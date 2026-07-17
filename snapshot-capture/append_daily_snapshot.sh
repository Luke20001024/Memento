#!/bin/bash
# 把每日第一帧作为独立事实条目写入当天记录。
# 天气只属于这张照片；脚本本身不会请求位置或网络。
# 用法:
#   append_daily_snapshot.sh PHOTO DATE TIME WEEKDAY TIMEZONE WEATHER WEATHER_OBSERVED SOURCE_APP

set -e

PHOTO="$1"
CAPTURE_DATE="$2"
CAPTURE_TIME="$3"
WEEKDAY="$4"
TIMEZONE="$5"
WEATHER="$6"
WEATHER_OBSERVED="$7"
SOURCE_APP="$8"

[ -f "$PHOTO" ] || exit 1
[ -n "$CAPTURE_DATE" ] || CAPTURE_DATE=$(date +%Y-%m-%d)
[ -n "$CAPTURE_TIME" ] || CAPTURE_TIME=$(date +%H:%M)
[ -n "$WEEKDAY" ] || WEEKDAY="时间未知"
[ -n "$TIMEZONE" ] || TIMEZONE="$(date +%Z)"
[ -n "$WEATHER" ] || WEATHER="暂不可用"

SCRIPT_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$SCRIPT_HOME/memento_env.sh"

BLOCK=""
PENDING_ASSET=""
cleanup_snapshot_append() {
  [ -z "$BLOCK" ] || rm -f "$BLOCK"
  if [ "${MEMENTO_DAILY_APPEND_COMMITTED:-0}" != "1" ]; then
    [ -z "$PENDING_ASSET" ] || rm -f "$PENDING_ASSET"
    [ -z "${MEMENTO_COPIED_ASSET_PATH:-}" ] || rm -f "$MEMENTO_COPIED_ASSET_PATH"
  fi
  [ -z "${MEMENTO_ASSET_RESERVATION:-}" ] || rm -rf "$MEMENTO_ASSET_RESERVATION"
}
trap cleanup_snapshot_append EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

FILE="$MEMENTO_VAULT/$CAPTURE_DATE.md"
STAMP=$(printf '%s' "$CAPTURE_TIME" | tr -d ':')
if ! memento_copy_asset "$PHOTO" \
  "${CAPTURE_DATE}-${STAMP}00-daily-portrait" "jpg"; then
  echo "Memento: 每日第一帧照片复制失败" >&2
  exit 1
fi
BASENAME="$MEMENTO_COPIED_ASSET_BASENAME"
DEST="$MEMENTO_COPIED_ASSET_PATH"
PENDING_ASSET="$DEST"

BLOCK=$(mktemp "${TMPDIR:-/tmp}/memento-daily-snapshot.XXXXXX") || {
  rm -f "$DEST"
  exit 1
}

if ! {
  printf '\n## %s · %s · 每日第一帧\n\n' "$CAPTURE_TIME" "$WEEKDAY"
  printf '> 时间: %s %s · %s\n' "$CAPTURE_DATE" "$CAPTURE_TIME" "$TIMEZONE"
  printf '> 天气: %s\n' "$WEATHER"
  [ -n "$WEATHER_OBSERVED" ] && printf '> 天气观测: %s · Open-Meteo\n' "$WEATHER_OBSERVED"
  [ -n "$SOURCE_APP" ] && printf '> 首条记录来源: %s\n' "$SOURCE_APP"
  printf '\n![每日第一帧](./assets/%s)\n\n---\n' "$BASENAME"
} > "$BLOCK"; then
  rm -f "$DEST"
  exit 1
fi

# 和普通记录共用按日写锁，避免异步快照与下一条记录交错。
if ! memento_append_daily_block "$FILE" "$CAPTURE_DATE" "$BLOCK"; then
  rm -f "$DEST"
  exit 1
fi
PENDING_ASSET=""
MEMENTO_COPIED_ASSET_PATH=""

# 拍摄窗口已经提供了明确反馈；成功落档保持静默，避免异步天气查询结束后
# 再弹出一条像“定时任务”一样的重复系统通知。失败仍由拍摄 App 提示。
