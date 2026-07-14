#!/bin/bash

set -euo pipefail

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
TARGET_DATE="${1:-}"

case "$TARGET_DATE" in
  ????-??-??) ;;
  *)
    echo "用法: $0 YYYY-MM-DD" >&2
    exit 2
    ;;
esac

NORMALIZED_DATE=$(date -j -f '%Y-%m-%d' "$TARGET_DATE" '+%Y-%m-%d' 2>/dev/null || true)
if [ "$NORMALIZED_DATE" != "$TARGET_DATE" ]; then
  echo "无效日期: $TARGET_DATE" >&2
  exit 2
fi

SOURCE_FILE="$VAULT/$TARGET_DATE.md"
REVIEW_FILE="$VAULT/Reviews/Daily/$TARGET_DATE.md"

if [ ! -s "$SOURCE_FILE" ]; then
  echo "缺少原始记录: $SOURCE_FILE" >&2
  exit 3
fi

if [ ! -s "$REVIEW_FILE" ]; then
  echo "缺少 Daily Review: $REVIEW_FILE" >&2
  exit 4
fi

EXPECTED_HASH=$(shasum -a 256 "$SOURCE_FILE" | awk '{print $1}')
ACTUAL_HASH=$(sed -n 's/^source_hash:[[:space:]]*//p' "$REVIEW_FILE" | head -1 | tr -d '"')

if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  echo "source_hash 不一致: expected=$EXPECTED_HASH actual=$ACTUAL_HASH" >&2
  exit 5
fi

grep -q "^date: $TARGET_DATE$" "$REVIEW_FILE"
grep -q '^type: memento-review$' "$REVIEW_FILE"
grep -q '^period: daily$' "$REVIEW_FILE"
grep -q '^prompt: memento-comprehensive$' "$REVIEW_FILE"

for SECTION in \
  '## 灵感与想法' \
  '## 个人记录/情绪' \
  '## 已忽略' \
  '## 来源索引' \
  '## 我的补充'; do
  if ! grep -qF "$SECTION" "$REVIEW_FILE"; then
    echo "缺少章节: $SECTION" >&2
    exit 6
  fi
done

# 新 Review 使用记录优先章节；旧章节名仍允许校验，避免要求迁移历史文件。
if ! grep -qF '## 工作与生活现场' "$REVIEW_FILE" && ! grep -qF '## 工作事项' "$REVIEW_FILE"; then
  echo "缺少章节: ## 工作与生活现场" >&2
  exit 6
fi

if ! grep -qF '## 行动线索' "$REVIEW_FILE" && ! grep -qF '## TODO 清单' "$REVIEW_FILE"; then
  echo "缺少章节: ## 行动线索" >&2
  exit 6
fi

if ! grep -qF "[[${TARGET_DATE}]]" "$REVIEW_FILE"; then
  echo "缺少来源链接: [[${TARGET_DATE}]]" >&2
  exit 7
fi

echo "Daily Review 校验通过: $REVIEW_FILE"
