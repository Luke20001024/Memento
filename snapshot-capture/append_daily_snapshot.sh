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

FILE="$MEMENTO_VAULT/$CAPTURE_DATE.md"
STAMP=$(printf '%s' "$CAPTURE_TIME" | tr -d ':')
BASENAME="${CAPTURE_DATE}-${STAMP}00-daily-portrait.jpg"
DEST="$MEMENTO_ASSETS_DIR/$BASENAME"

mkdir -p "$MEMENTO_ASSETS_DIR"
if [ -e "$DEST" ]; then
  BASENAME="${CAPTURE_DATE}-${STAMP}00-daily-portrait-$RANDOM.jpg"
  DEST="$MEMENTO_ASSETS_DIR/$BASENAME"
fi
cp "$PHOTO" "$DEST"

BLOCK=$(mktemp "${TMPDIR:-/tmp}/memento-daily-snapshot.XXXXXX")
trap 'rm -f "$BLOCK"' EXIT

{
  echo ""
  echo "## $CAPTURE_TIME · $WEEKDAY · 每日第一帧"
  echo ""
  echo "> 时间: $CAPTURE_DATE $CAPTURE_TIME · $TIMEZONE"
  echo "> 天气: $WEATHER"
  [ -n "$WEATHER_OBSERVED" ] && echo "> 天气观测: $WEATHER_OBSERVED · Open-Meteo"
  [ -n "$SOURCE_APP" ] && echo "> 首条记录来源: $SOURCE_APP"
  echo ""
  echo "![每日第一帧](./assets/$BASENAME)"
  echo ""
  echo "---"
} > "$BLOCK"

# 和普通记录共用按日写锁，避免异步快照与下一条记录交错。
if ! memento_append_daily_block "$FILE" "$CAPTURE_DATE" "$BLOCK"; then
  rm -f "$DEST"
  exit 1
fi

osascript -e "display notification \"每日第一帧已存入 $CAPTURE_DATE.md\" with title \"Memento\"" 2>/dev/null || true
