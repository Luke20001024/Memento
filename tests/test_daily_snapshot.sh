#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/memento-snapshot-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

VAULT="$TMP_ROOT/vault"
SCRIPTS="$VAULT/.scripts"
APP="$VAULT/.apps/Memento Daily Snapshot.app"
EXECUTABLE="$APP/Contents/MacOS/MementoDailySnapshot"
LAUNCH_LOG="$TMP_ROOT/launch.log"
mkdir -p "$SCRIPTS" "$(dirname "$EXECUTABLE")"

# 从安装器提取真正会被安装的统一环境脚本，避免测试一份复制品。
awk '
  /cat > "\$SCRIPT_DIR\/memento_env.sh" << '\''BASH_EOF'\''/ { copying = 1; next }
  copying && $0 == "BASH_EOF" { exit }
  copying { print }
' "$ROOT/install_aisecretary.sh" > "$SCRIPTS/memento_env.sh"
chmod +x "$SCRIPTS/memento_env.sh"

cat > "$EXECUTABLE" <<'FAKE_APP'
#!/bin/bash
exit 0
FAKE_APP
chmod +x "$EXECUTABLE"

cat > "$TMP_ROOT/fake-launcher.sh" <<'FAKE_LAUNCHER'
#!/bin/bash
printf '%s\n' "$*" >> "$MEMENTO_TEST_LAUNCH_LOG"
FAKE_LAUNCHER
chmod +x "$TMP_ROOT/fake-launcher.sh"

export MEMENTO_VAULT="$VAULT"
export MEMENTO_DAILY_SNAPSHOT_LAUNCHER="$TMP_ROOT/fake-launcher.sh"
export MEMENTO_TEST_LAUNCH_LOG="$LAUNCH_LOG"
. "$SCRIPTS/memento_env.sh"

# 并发首写只能认领并启动一次。
for _ in $(seq 1 20); do
  (memento_trigger_daily_snapshot "2026-07-14" "09:42" "周二" "Codex") &
done
wait
for _ in $(seq 1 40); do
  [ -f "$LAUNCH_LOG" ] && break
  sleep 0.05
done

[ -d "$VAULT/.state/daily-snapshot/2026-07-14.claim" ]
[ "$(wc -l < "$LAUNCH_LOG" | tr -d ' ')" = "1" ]
grep -q -- '--capture-date 2026-07-14' "$LAUNCH_LOG"
grep -q -- '--source-app Codex' "$LAUNCH_LOG"

# 同一天再次记录没有任何新启动；次日独立认领一次。
memento_trigger_daily_snapshot "2026-07-14" "10:00" "周二" "Feishu"
memento_trigger_daily_snapshot "2026-07-15" "08:00" "周三" "Feishu"
for _ in $(seq 1 40); do
  [ -f "$LAUNCH_LOG" ] && [ "$(wc -l < "$LAUNCH_LOG" | tr -d ' ')" = "2" ] && break
  sleep 0.05
done
[ "$(wc -l < "$LAUNCH_LOG" | tr -d ' ')" = "2" ]

# 禁用开关不会认领，也不会启动。
export MEMENTO_DAILY_SNAPSHOT_DISABLED=1
memento_trigger_daily_snapshot "2026-07-16" "08:00" "周四" "Feishu"
[ ! -e "$VAULT/.state/daily-snapshot/2026-07-16.claim" ]
[ "$(wc -l < "$LAUNCH_LOG" | tr -d ' ')" = "2" ]
unset MEMENTO_DAILY_SNAPSHOT_DISABLED

# 落档脚本一次性写入完整块；天气和来源只绑定每日第一帧。
cp "$ROOT/snapshot-capture/append_daily_snapshot.sh" "$SCRIPTS/append_daily_snapshot.sh"
chmod +x "$SCRIPTS/append_daily_snapshot.sh"
PHOTO="$TMP_ROOT/photo.jpg"
printf 'fake-jpeg-data' > "$PHOTO"

"$SCRIPTS/append_daily_snapshot.sh" \
  "$PHOTO" "2026-07-14" "09:42" "周二" "Asia/Shanghai" \
  "阴 · 31.7°C（体感 37.3°C）" "2026-07-14T09:45" "Codex"

DAILY="$VAULT/2026-07-14.md"
grep -q '^type: memento-daily$' "$DAILY"
[ "$(grep -c '每日第一帧' "$DAILY")" = "2" ]
grep -q '> 天气: 阴 · 31.7°C（体感 37.3°C）' "$DAILY"
grep -q '> 天气观测: 2026-07-14T09:45 · Open-Meteo' "$DAILY"
grep -q '> 首条记录来源: Codex' "$DAILY"
ASSET=$(find "$VAULT/assets" -name '*-daily-portrait*.jpg' -type f | head -1)
[ -n "$ASSET" ]
[ -s "$ASSET" ]

# 异步快照与后续普通记录共用按日写锁；并发追加不能相互穿插或重复 frontmatter。
LOCK_DATE="2026-07-17"
for index in $(seq 1 20); do
  BLOCK="$TMP_ROOT/block-$index.md"
  printf '\n## 10:%02d · 周五\n\nentry-%02d\n\n---\n' "$index" "$index" > "$BLOCK"
  (memento_append_daily_block "$VAULT/$LOCK_DATE.md" "$LOCK_DATE" "$BLOCK") &
done
wait
[ "$(grep -c '^## ' "$VAULT/$LOCK_DATE.md")" = "20" ]
[ "$(grep -c '^type: memento-daily$' "$VAULT/$LOCK_DATE.md")" = "1" ]
for index in $(seq 1 20); do
  [ "$(grep -c "entry-$(printf '%02d' "$index")" "$VAULT/$LOCK_DATE.md")" = "1" ]
done

# append_text 必须先确认真实写入成功，之后才能通知并触发每日第一帧。
# 用测试版 memento_env 注入成功/失败，测试安装器实际生成的 append_text，而非复制品。
TEXT_ROOT="$TMP_ROOT/text-integrity"
TEXT_SCRIPTS="$TEXT_ROOT/.scripts"
TEXT_TMP="$TEXT_ROOT/tmp"
TEXT_BIN="$TEXT_ROOT/bin"
NOTIFY_LOG="$TEXT_ROOT/notify.log"
SNAPSHOT_LOG="$TEXT_ROOT/snapshot.log"
mkdir -p "$TEXT_SCRIPTS" "$TEXT_TMP" "$TEXT_BIN"

awk '
  /cat > "\$SCRIPT_DIR\/append_text.sh" << '\''BASH_EOF'\''/ { copying = 1; next }
  copying && $0 == "BASH_EOF" { exit }
  copying { print }
' "$ROOT/install_aisecretary.sh" > "$TEXT_SCRIPTS/append_text.sh"
chmod +x "$TEXT_SCRIPTS/append_text.sh"

cat > "$TEXT_SCRIPTS/memento_env.sh" <<'FAKE_ENV'
#!/bin/bash
MEMENTO_VAULT="${MEMENTO_VAULT:?}"

memento_append_daily_block() {
  [ "${MEMENTO_TEST_WRITE_FAIL:-0}" = "1" ] && return 23
  mkdir -p "$MEMENTO_VAULT"
  cp "$3" "$MEMENTO_VAULT/written-block.md"
}

memento_trigger_daily_snapshot() {
  printf '%s\n' "$*" >> "${MEMENTO_TEST_SNAPSHOT_LOG:?}"
}
FAKE_ENV

cat > "$TEXT_BIN/osascript" <<'FAKE_OSASCRIPT'
#!/bin/bash
printf '%s\n' "$*" >> "${MEMENTO_TEST_NOTIFY_LOG:?}"
FAKE_OSASCRIPT
chmod +x "$TEXT_BIN/osascript"

set +e
MEMENTO_VAULT="$TEXT_ROOT/vault" \
MEMENTO_TEST_WRITE_FAIL=1 \
MEMENTO_TEST_NOTIFY_LOG="$NOTIFY_LOG" \
MEMENTO_TEST_SNAPSHOT_LOG="$SNAPSHOT_LOG" \
TMPDIR="$TEXT_TMP" \
PATH="$TEXT_BIN:$PATH" \
  "$TEXT_SCRIPTS/append_text.sh" "不会落档的内容" >/dev/null 2>&1
WRITE_STATUS=$?
set -e

[ "$WRITE_STATUS" -ne 0 ]
[ ! -e "$NOTIFY_LOG" ]
[ ! -e "$SNAPSHOT_LOG" ]
[ -z "$(find "$TEXT_TMP" -maxdepth 1 -name 'memento-text.*' -print -quit)" ]

MEMENTO_VAULT="$TEXT_ROOT/vault" \
MEMENTO_TEST_NOTIFY_LOG="$NOTIFY_LOG" \
MEMENTO_TEST_SNAPSHOT_LOG="$SNAPSHOT_LOG" \
SOURCE_APP="Codex" TAG="TODO" NOTE="测试备注" \
TMPDIR="$TEXT_TMP" \
PATH="$TEXT_BIN:$PATH" \
  "$TEXT_SCRIPTS/append_text.sh" "真实落档的内容"

grep -q '真实落档的内容' "$TEXT_ROOT/vault/written-block.md"
grep -q '#TODO' "$TEXT_ROOT/vault/written-block.md"
grep -q '测试备注' "$TEXT_ROOT/vault/written-block.md"
[ "$(wc -l < "$NOTIFY_LOG" | tr -d ' ')" = "1" ]
[ "$(grep -c '行动线索' "$NOTIFY_LOG")" = "1" ]
if grep -q '#TODO' "$NOTIFY_LOG"; then
  echo "成功通知仍暴露 TODO 任务语义" >&2
  exit 1
fi
[ "$(wc -l < "$SNAPSHOT_LOG" | tr -d ' ')" = "1" ]
[ -z "$(find "$TEXT_TMP" -maxdepth 1 -name 'memento-text.*' -print -quit)" ]

# 标签选择不再默认 TODO；用户看到的是记录语义，底层仍映射到兼容标签。
rg -qF 'set labels to {"灵感", "行动线索", "下次再读"}' "$ROOT/install_aisecretary.sh"
rg -qF '只用于回看，不表示待办或优先级' "$ROOT/install_aisecretary.sh"
rg -qF 'if chosenLabel is "行动线索" then return "TODO"' "$ROOT/install_aisecretary.sh"
rg -qF 'NOTIFY_MSG="已存入 [行动线索]"' "$ROOT/install_aisecretary.sh"
if rg -qF 'default items {"TODO"}' "$ROOT/install_aisecretary.sh"; then
  echo "标签入口仍默认选中 TODO" >&2
  exit 1
fi

# 安装和卸载都覆盖旧版 AI秘书·* 入口，且不会借此删除 Vault 数据。
rg -qF '"$SERVICES_DIR"/AI秘书·*.workflow' "$ROOT/install_aisecretary.sh"
rg -qF '"$SERVICES_DIR"/AI秘书·*.workflow' "$ROOT/uninstall_aisecretary.sh"

echo "✓ daily snapshot hook: atomic once per day"
echo "✓ daily snapshot append: photo + time + one-time weather"
echo "✓ daily note writer: concurrent blocks remain complete"
echo "✓ text writer: notify/snapshot only after durable append"
echo "✓ installer semantics: record-first tags and legacy Service cleanup"
