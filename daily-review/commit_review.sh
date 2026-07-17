#!/bin/bash

set -euo pipefail
umask 077

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET_DATE="${1:-}"
TEMP_REVIEW="${2:-}"
EXPECTED_REVIEW_HASH="${3:-}"
ABSENT_SENTINEL='__MEMENTO_REVIEW_ABSENT__'

case "$TARGET_DATE" in
  ????-??-??) ;;
  *)
    echo "用法: $0 YYYY-MM-DD SAME_DIRECTORY_TEMP EXPECTED_REVIEW_HASH" >&2
    exit 2
    ;;
esac

NORMALIZED_DATE=$(date -j -f '%Y-%m-%d' "$TARGET_DATE" '+%Y-%m-%d' 2>/dev/null || true)
if [ "$NORMALIZED_DATE" != "$TARGET_DATE" ]; then
  echo "无效日期: $TARGET_DATE" >&2
  exit 2
fi

if [ "$EXPECTED_REVIEW_HASH" != "$ABSENT_SENTINEL" ] \
  && [[ ! "$EXPECTED_REVIEW_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "EXPECTED_REVIEW_HASH 必须是 64 位小写 SHA-256 或 $ABSENT_SENTINEL" >&2
  exit 2
fi

if [ -z "$TEMP_REVIEW" ]; then
  echo "缺少同目录临时 Review" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "缺少 python3，无法执行原子 Daily Review 提交" >&2
  exit 70
fi

exec python3 "$SCRIPT_DIR/commit_review_atomic.py" \
  "$VAULT" "$TARGET_DATE" "$TEMP_REVIEW" "$EXPECTED_REVIEW_HASH" \
  "$SCRIPT_DIR/verify_review.sh"
