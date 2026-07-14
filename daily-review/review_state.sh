#!/bin/bash

set -euo pipefail

VAULT="${MEMENTO_VAULT:-$HOME/AISecretary}"
TARGET_DATE="${1:-}"
RUN_STATUS="${2:-}"

case "$TARGET_DATE" in
  ????-??-??) ;;
  *)
    echo "用法: $0 YYYY-MM-DD pending|success|failed [message]" >&2
    exit 2
    ;;
esac

NORMALIZED_DATE=$(date -j -f '%Y-%m-%d' "$TARGET_DATE" '+%Y-%m-%d' 2>/dev/null || true)
if [ "$NORMALIZED_DATE" != "$TARGET_DATE" ]; then
  echo "无效日期: $TARGET_DATE" >&2
  exit 2
fi

case "$RUN_STATUS" in
  pending|success|failed) ;;
  *)
    echo "无效状态: $RUN_STATUS（只允许 pending、success、failed）" >&2
    exit 2
    ;;
esac

shift 2
MESSAGE="$*"
if [ -z "$MESSAGE" ]; then
  case "$RUN_STATUS" in
    pending) MESSAGE='Daily Review 正在生成' ;;
    success) MESSAGE='Daily Review 校验通过' ;;
    failed) MESSAGE='Daily Review 生成失败' ;;
  esac
fi

UPDATED_AT="${MEMENTO_STATUS_NOW:-$(TZ=Asia/Shanghai date '+%Y-%m-%dT%H:%M:%S%z')}"
if [[ "$UPDATED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{4}$ ]]; then
  UPDATED_AT="${UPDATED_AT:0:${#UPDATED_AT}-2}:${UPDATED_AT: -2}"
fi

STATUS_DIR="$VAULT/.review/status"
STATUS_FILE="$STATUS_DIR/$TARGET_DATE.json"
mkdir -p "$STATUS_DIR"

# 使用系统自带 JXA 生成 JSON，避免消息中的引号、换行或反斜杠破坏 Chrome 解析。
JSON=$(/usr/bin/osascript -l JavaScript - \
  "$TARGET_DATE" "$RUN_STATUS" "$UPDATED_AT" "$MESSAGE" <<'JXA'
function run(argv) {
  return JSON.stringify({
    date: argv[0],
    status: argv[1],
    updated_at: argv[2],
    message: argv[3]
  });
}
JXA
)

umask 077
TMP_FILE=$(mktemp "$STATUS_DIR/.${TARGET_DATE}.json.XXXXXX")
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

printf '%s\n' "$JSON" > "$TMP_FILE"
mv "$TMP_FILE" "$STATUS_FILE"
trap - EXIT

# stdout 与落盘文件保持相同，便于自动任务直接记录机器可读结果。
printf '%s\n' "$JSON"
