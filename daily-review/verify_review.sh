#!/bin/bash

set -euo pipefail

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
TARGET_DATE="${1:-}"
REVIEW_OVERRIDE="${2:-}"

case "$TARGET_DATE" in
  ????-??-??) ;;
  *)
    echo "用法: $0 YYYY-MM-DD [REVIEW_FILE]" >&2
    exit 2
    ;;
esac

NORMALIZED_DATE=$(date -j -f '%Y-%m-%d' "$TARGET_DATE" '+%Y-%m-%d' 2>/dev/null || true)
if [ "$NORMALIZED_DATE" != "$TARGET_DATE" ]; then
  echo "无效日期: $TARGET_DATE" >&2
  exit 2
fi

SOURCE_FILE="$VAULT/$TARGET_DATE.md"
REVIEW_FILE="${REVIEW_OVERRIDE:-$VAULT/Reviews/Daily/$TARGET_DATE.md}"
PROMPT_FILE="$VAULT/.chrome-newtab/prompts.js"

if [ ! -s "$SOURCE_FILE" ]; then
  echo "缺少原始记录: $SOURCE_FILE" >&2
  exit 3
fi

if [ ! -s "$REVIEW_FILE" ]; then
  echo "缺少 Daily Review: $REVIEW_FILE" >&2
  exit 4
fi

if [ ! -s "$PROMPT_FILE" ] || ! grep -q "id: 'comprehensive'" "$PROMPT_FILE"; then
  echo "缺少 comprehensive Prompt: $PROMPT_FILE" >&2
  exit 4
fi

EXPECTED_SOURCE_HASH=$(shasum -a 256 "$SOURCE_FILE" | awk '{print $1}')
EXPECTED_PROMPT_HASH=$(shasum -a 256 "$PROMPT_FILE" | awk '{print $1}')
EXPECTED_SOURCE_MOCK=false
if [ "$(sed -n '1p' "$SOURCE_FILE")" = '---' ] \
  && sed -n '2,/^---$/p' "$SOURCE_FILE" | grep -q '^mock: true$'; then
  EXPECTED_SOURCE_MOCK=true
fi

# 同一校验器既用于生成完成后的临时文件，也用于 review_status 的 up_to_date 判定。
# 严格限定 frontmatter，避免正文中的伪字段或一份只剩 source_hash 的截断文件蒙混过关。
awk \
  -v target_date="$TARGET_DATE" \
  -v expected_source_hash="$EXPECTED_SOURCE_HASH" \
  -v expected_source_mock="$EXPECTED_SOURCE_MOCK" \
  -v expected_prompt_hash="$EXPECTED_PROMPT_HASH" '
  function fail(message) {
    print "Daily Review 校验失败: " message > "/dev/stderr"
    exit 8
  }

  function nonblank(value) {
    return value ~ /[^[:space:]]/
  }

  BEGIN {
    required_count = 7
    required[1] = "## 工作与生活现场"
    required[2] = "## 行动线索"
    required[3] = "## 灵感与想法"
    required[4] = "## 个人记录/情绪"
    required[5] = "## 已忽略"
    required[6] = "## 来源索引"
    required[7] = "## 我的补充"

    allowed["date"] = 1
    allowed["type"] = 1
    allowed["period"] = 1
    allowed["source"] = 1
    allowed["source_hash"] = 1
    allowed["source_mock"] = 1
    allowed["prompt"] = 1
    allowed["prompt_hash"] = 1
    allowed["generated_at"] = 1
  }

  NR == 1 {
    if ($0 != "---") fail("文件必须从 frontmatter 开始")
    in_frontmatter = 1
    next
  }

  in_frontmatter {
    if ($0 == "---") {
      in_frontmatter = 0
      frontmatter_closed = 1
      next
    }

    separator = index($0, ":")
    if (separator == 0) fail("frontmatter 含无效行: " $0)
    key = substr($0, 1, separator - 1)
    value = substr($0, separator + 1)
    sub(/^[[:space:]]*/, "", value)

    if (!(key in allowed)) fail("frontmatter 含未知字段: " key)
    counts[key]++
    if (counts[key] > 1) fail("frontmatter 字段重复: " key)
    values[key] = value
    next
  }

  !frontmatter_closed {
    fail("frontmatter 未闭合")
  }

  !body_started && !nonblank($0) {
    next
  }

  !body_started {
    if ($0 != "# Daily Review · " target_date) fail("缺少或错误的一级标题")
    body_started = 1
    h1_count++
    next
  }

  $0 ~ /^[[:space:]]*```/ || $0 ~ /^[[:space:]]*~~~/ {
    in_fence = !in_fence
    if (current_section > 0) section_has_content[current_section] = 1
    next
  }

  !in_fence && $0 ~ /^# / {
    fail("不允许额外或重复的一级标题")
  }

  !in_fence && $0 ~ /^## / {
    if (section_index < required_count) {
      expected = required[section_index + 1]
      if ($0 != expected) fail("章节缺失或顺序错误，期望: " expected)
      section_index++
      current_section = section_index
      section_seen[current_section]++
      next
    }

    # 「我的补充」是用户拥有的 opaque 区域；历史内容可能已经使用 H2，
    # 必须原样兼容。这里只拒绝伪造或重复七个固定章节的标题。
    for (required_index = 1; required_index <= required_count; required_index++) {
      if ($0 == required[required_index]) fail("我的补充中不允许重复固定章节: " $0)
    }
    section_has_content[current_section] = 1
    next
  }

  current_section == 0 {
    if (nonblank($0)) fail("一级标题与首个章节之间存在未归组内容")
    next
  }

  {
    if (nonblank($0)) section_has_content[current_section] = 1
    if (current_section == 6 && $0 == "- [[" target_date "]]" ) {
      source_index_link = 1
    }
  }

  END {
    if (in_frontmatter || !frontmatter_closed) fail("frontmatter 未闭合")

    for (key in allowed) {
      if (counts[key] != 1) fail("frontmatter 缺少字段: " key)
    }

    if (values["date"] != target_date) fail("date 不匹配")
    if (values["type"] != "memento-review") fail("type 不匹配")
    if (values["period"] != "daily") fail("period 不匹配")
    if (values["source"] != "\"[[" target_date "]]\"") fail("source 不匹配")
    if (values["source_hash"] != "\"" expected_source_hash "\"") fail("source_hash 不匹配")
    if (values["source_mock"] != expected_source_mock) fail("source_mock 不匹配")
    if (values["prompt"] != "memento-comprehensive") fail("prompt 不匹配")
    if (values["prompt_hash"] != "\"" expected_prompt_hash "\"") fail("prompt_hash 不匹配")
    if (values["generated_at"] !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\+08:00$/) {
      fail("generated_at 必须是 Asia/Shanghai ISO-8601 时间")
    }

    if (h1_count != 1) fail("一级标题数量错误")
    if (section_index != required_count) fail("必需章节不完整")
    for (section_number = 1; section_number <= required_count; section_number++) {
      if (section_seen[section_number] != 1) fail("章节重复或缺失: " required[section_number])
      if (!section_has_content[section_number]) fail("章节不能为空（无内容时写“无”）: " required[section_number])
    }
    if (!source_index_link) fail("来源索引缺少精确链接: [[" target_date "]]" )
  }
' "$REVIEW_FILE"

GENERATED_AT=$(sed -n '2,/^---$/s/^generated_at:[[:space:]]*//p' "$REVIEW_FILE")
GENERATED_AT_COMPACT="${GENERATED_AT%+08:00}+0800"
NORMALIZED_GENERATED_AT=$(
  TZ=Asia/Shanghai date -j -f '%Y-%m-%dT%H:%M:%S%z' "$GENERATED_AT_COMPACT" \
    '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || true
)
if [ -z "$NORMALIZED_GENERATED_AT" ]; then
  echo "Daily Review 校验失败: generated_at 不是有效日历时间" >&2
  exit 8
fi
NORMALIZED_GENERATED_AT="${NORMALIZED_GENERATED_AT:0:${#NORMALIZED_GENERATED_AT}-2}:${NORMALIZED_GENERATED_AT: -2}"
if [ "$NORMALIZED_GENERATED_AT" != "$GENERATED_AT" ]; then
  echo "Daily Review 校验失败: generated_at 规范化失败" >&2
  exit 8
fi

echo "Daily Review 校验通过: $REVIEW_FILE"
