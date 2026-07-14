#!/bin/bash

set -euo pipefail

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
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

printf 'TARGET_DATE=%s\n' "$TARGET_DATE"
printf 'SOURCE_FILE=%s\n' "$SOURCE_FILE"
printf 'REVIEW_FILE=%s\n' "$REVIEW_FILE"
printf 'PROMPT_FILE=%s\n' "$PROMPT_FILE"
printf 'STATUS_FILE=%s\n' "$STATUS_FILE"

if [ ! -s "$SOURCE_FILE" ]; then
  echo 'STATUS=missing_source'
  exit 3
fi

if [ ! -s "$PROMPT_FILE" ] || ! grep -q "id: 'comprehensive'" "$PROMPT_FILE"; then
  echo 'STATUS=missing_prompt'
  exit 4
fi

SOURCE_HASH=$(shasum -a 256 "$SOURCE_FILE" | awk '{print $1}')
SOURCE_MOCK=false
if sed -n '1,/^---$/p' "$SOURCE_FILE" | grep -q '^mock: true$'; then
  SOURCE_MOCK=true
fi

printf 'SOURCE_HASH=%s\n' "$SOURCE_HASH"
printf 'SOURCE_MOCK=%s\n' "$SOURCE_MOCK"

EXISTING_HASH=''
if [ -s "$REVIEW_FILE" ]; then
  EXISTING_HASH=$(sed -n 's/^source_hash:[[:space:]]*//p' "$REVIEW_FILE" | head -1 | tr -d '"')
fi

if [ "$EXISTING_HASH" = "$SOURCE_HASH" ]; then
  echo 'STATUS=up_to_date'
else
  echo 'STATUS=needs_generation'
fi
