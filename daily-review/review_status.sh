#!/bin/bash

set -euo pipefail

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REQUESTED_DATE="${1:-today}"

case "$REQUESTED_DATE" in
  previous)
    TARGET_DATE=$(TZ=Asia/Shanghai date -v-1d +%F)
    ;;
  today)
    TARGET_DATE=$(TZ=Asia/Shanghai date +%F)
    ;;
  ????-??-??)
    TARGET_DATE="$REQUESTED_DATE"
    ;;
  *)
    echo "用法: $0 [today|previous|YYYY-MM-DD]" >&2
    exit 2
    ;;
esac

NORMALIZED_DATE=$(date -j -f '%Y-%m-%d' "$TARGET_DATE" '+%Y-%m-%d' 2>/dev/null || true)
if [ "$NORMALIZED_DATE" != "$TARGET_DATE" ]; then
  echo "无效日期: $TARGET_DATE" >&2
  exit 2
fi

SOURCE_FILE="$VAULT/$TARGET_DATE.md"
REVIEW_DIR="$VAULT/Reviews/Daily"
REVIEW_FILE="$REVIEW_DIR/$TARGET_DATE.md"
PROMPT_FILE="$VAULT/.chrome-newtab/prompts.js"
STATUS_FILE="$VAULT/.review/status/$TARGET_DATE.json"
REVIEW_ABSENT_SENTINEL='__MEMENTO_REVIEW_ABSENT__'

printf 'TARGET_DATE=%s\n' "$TARGET_DATE"
printf 'SOURCE_FILE=%s\n' "$SOURCE_FILE"
printf 'REVIEW_FILE=%s\n' "$REVIEW_FILE"
printf 'PROMPT_FILE=%s\n' "$PROMPT_FILE"
printf 'STATUS_FILE=%s\n' "$STATUS_FILE"

# 这是生成事务的 compare-and-swap 起点。调用方必须把该值原样交给
# commit_review.sh；生成期间任何人工编辑都会使提交因冲突而关闭，不能被覆盖。
if [ -L "$REVIEW_FILE" ] || { [ -e "$REVIEW_FILE" ] && [ ! -f "$REVIEW_FILE" ]; }; then
  echo 'REVIEW_HASH=__MEMENTO_REVIEW_INVALID__'
  echo 'STATUS=invalid_review_target'
  exit 5
elif [ -e "$REVIEW_FILE" ]; then
  REVIEW_HASH=$(shasum -a 256 "$REVIEW_FILE" | awk '{print $1}')
  printf 'REVIEW_HASH=%s\n' "$REVIEW_HASH"
else
  printf 'REVIEW_HASH=%s\n' "$REVIEW_ABSENT_SENTINEL"
fi

if [ ! -s "$SOURCE_FILE" ]; then
  echo 'STATUS=missing_source'
  exit 3
fi

if [ ! -s "$PROMPT_FILE" ] || ! grep -q "id: 'comprehensive'" "$PROMPT_FILE"; then
  echo 'STATUS=missing_prompt'
  exit 4
fi

SOURCE_HASH=$(shasum -a 256 "$SOURCE_FILE" | awk '{print $1}')
PROMPT_HASH=$(shasum -a 256 "$PROMPT_FILE" | awk '{print $1}')
SOURCE_MOCK=false
if [ "$(sed -n '1p' "$SOURCE_FILE")" = '---' ] \
  && sed -n '2,/^---$/p' "$SOURCE_FILE" | grep -q '^mock: true$'; then
  SOURCE_MOCK=true
fi

printf 'SOURCE_HASH=%s\n' "$SOURCE_HASH"
printf 'SOURCE_MOCK=%s\n' "$SOURCE_MOCK"
printf 'PROMPT_HASH=%s\n' "$PROMPT_HASH"

# `source_hash` 相同并不代表结果完整。只有整个 Review 合同校验通过，才能跳过生成。
# 旧 Review 没有 prompt_hash，或仍使用旧章节结构，会在这里自然进入一次性重建；
# 自动任务随后按协议保留已有「我的补充」，不会原地伪造新版本元数据。
if [ -s "$REVIEW_FILE" ] \
  && MEMENTO_VAULT="$VAULT" "$SCRIPT_DIR/verify_review.sh" "$TARGET_DATE" >/dev/null 2>&1; then
  echo 'STATUS=up_to_date'
else
  echo 'STATUS=needs_generation'
fi
