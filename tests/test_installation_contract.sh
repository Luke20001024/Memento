#!/bin/bash
# 在隔离 HOME 中验证完整安装、升级幂等与默认卸载的数据边界。

set -e
set -o pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/memento-install-contract.XXXXXX")
TEST_HOME="$TMP_ROOT/home"
FAKE_BIN="$TMP_ROOT/bin"
LOG_DIR="$TMP_ROOT/logs"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$TEST_HOME/Library/Services" "$TEST_HOME/Library/LaunchAgents" "$FAKE_BIN" "$LOG_DIR"

# 强制 Swift 构建失败，验证升级时已有可用 App 不会被半成品覆盖。
cat > "$FAKE_BIN/swiftc" <<'FAKE_SWIFTC'
#!/bin/bash
exit 42
FAKE_SWIFTC
chmod 700 "$FAKE_BIN/swiftc"

run_install() {
  local replies="$1"
  local log="$2"
  printf '%s' "$replies" | env \
    HOME="$TEST_HOME" \
    PATH="$FAKE_BIN:$PATH" \
    MEMENTO_SKIP_SERVICE_REFRESH=1 \
    MEMENTO_SKIP_LEGACY_LAUNCHAGENT_UNLOAD=1 \
    bash "$ROOT/install_aisecretary.sh" >"$log" 2>&1
}

run_uninstall() {
  local replies="$1"
  local log="$2"
  printf '%s' "$replies" | env \
    HOME="$TEST_HOME" \
    PATH="$FAKE_BIN:$PATH" \
    MEMENTO_SKIP_SERVICE_REFRESH=1 \
    MEMENTO_SKIP_LEGACY_LAUNCHAGENT_UNLOAD=1 \
    bash "$ROOT/uninstall_aisecretary.sh" >"$log" 2>&1
}

# v1 的 owned 常驻截图监听器必须在升级时清掉，避免旧通知继续后台出现。
LEGACY_PLIST="$TEST_HOME/Library/LaunchAgents/com.aisecretary.screenshot.plist"
cat > "$LEGACY_PLIST" <<LEGACY_PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aisecretary.screenshot</string>
  <key>ProgramArguments</key><array><string>$TEST_HOME/AISecretary/.scripts/watch_screenshots.sh</string></array>
</dict></plist>
LEGACY_PLIST_EOF

# 同名但无 Memento marker/专属路径的用户 Workflow 必须全程保留。
USER_WF="$TEST_HOME/Library/Services/存入 AI 秘书.workflow"
mkdir -p "$USER_WF/Contents"
printf '%s\n' 'USER_WORKFLOW_SENTINEL' > "$USER_WF/Contents/document.wflow"

# 首次安装只有 Chrome 可选提示；回答 n，避免触碰真实 Chrome。
run_install 'n' "$LOG_DIR/install-first.log"

# App 源码组合 hash 必须只依赖内容，不能把安装器绝对路径算进去。
SOURCE_HASH_A=$(
  {
    shasum -a 256 "$ROOT/snapshot-capture/MementoDailySnapshot.swift" | awk '{print $1}'
    shasum -a 256 "$ROOT/snapshot-capture/Info.plist" | awk '{print $1}'
  } | shasum -a 256 | awk '{print $1}'
)
SOURCE_COPY="$TMP_ROOT/source-copy"
mkdir -p "$SOURCE_COPY"
cp "$ROOT/snapshot-capture/MementoDailySnapshot.swift" "$SOURCE_COPY/"
cp "$ROOT/snapshot-capture/Info.plist" "$SOURCE_COPY/"
SOURCE_HASH_B=$(
  {
    shasum -a 256 "$SOURCE_COPY/MementoDailySnapshot.swift" | awk '{print $1}'
    shasum -a 256 "$SOURCE_COPY/Info.plist" | awk '{print $1}'
  } | shasum -a 256 | awk '{print $1}'
)
[ "$SOURCE_HASH_A" = "$SOURCE_HASH_B" ]
rg -q 'SNAPSHOT_SOURCE_HASH=\$\(memento_content_set_hash' "$ROOT/install_aisecretary.sh"
rg -q 'VOICE_SOURCE_HASH=\$\(memento_content_set_hash' "$ROOT/install_aisecretary.sh"

VAULT="$TEST_HOME/AISecretary"
[ -x "$VAULT/.scripts/append_text.sh" ]
[ -x "$VAULT/.scripts/append_daily_snapshot.sh" ]
[ -f "$VAULT/.chrome-newtab/manifest.json" ]
[ -f "$VAULT/.chrome-newtab/dashboard-cache-library.js" ]
[ -f "$VAULT/.chrome-newtab/dashboard-operations-library.js" ]
[ -x "$VAULT/.review/review_cycle.sh" ]
[ -x "$VAULT/.review/commit_review.sh" ]
[ -x "$VAULT/.review/commit_review_atomic.py" ]
[ "$(cat "$USER_WF/Contents/document.wflow")" = 'USER_WORKFLOW_SENTINEL' ]
[ ! -d "$TEST_HOME/.memento-install.lock" ]
[ ! -e "$LEGACY_PLIST" ]

for NAME in \
  '存入 AI 秘书 (选标签)' \
  '存入 AI 秘书 (加备注)' \
  '存入 AI 秘书 (截图)'; do
  MARKER="$TEST_HOME/Library/Services/$NAME.workflow/Contents/.memento-managed"
  [ "$(cat "$MARKER")" = 'com.memento.workflow.v1' ]
done
[ ! -d "$TEST_HOME/Library/Services/存入 AI 秘书 (语音).workflow" ]

# 模拟用户数据、运行状态和上一版可执行 App；二次安装必须保留它们。
printf '%s\n' 'USER_README_SENTINEL' >> "$VAULT/README.md"
mkdir -p "$VAULT/.review/status"
printf '%s\n' 'USER_REVIEW_STATUS_SENTINEL' > "$VAULT/.review/status/state.txt"
cat > "$VAULT/2026-07-16.md" <<'DAILY_NOTE'
---
date: 2026-07-16
type: memento-daily
---

## 09:00 · 周四

USER_DAILY_SENTINEL

---
DAILY_NOTE
printf '%s\n' 'USER_ASSET_SENTINEL' > "$VAULT/assets/user-asset.txt"
printf '%s\n' 'USER_REVIEW_SENTINEL' > "$VAULT/Reviews/Daily/2026-07-16.md"

# POSIX mode 之外的显式 ACL 也必须在完整安装的隐私收紧阶段移除。
# 单文件 metadata 迁移函数仍单独验证原子替换会保留 ACL/xattr；最终安装边界更严格。
chmod +a 'everyone allow read' "$VAULT"
chmod +a 'everyone allow read' "$VAULT/README.md"

SNAPSHOT_EXEC="$VAULT/.apps/Memento Daily Snapshot.app/Contents/MacOS/MementoDailySnapshot"
VOICE_EXEC="$VAULT/.apps/Memento Voice Capture.app/Contents/MacOS/MementoVoiceCapture"
mkdir -p "$(dirname "$SNAPSHOT_EXEC")" "$(dirname "$VOICE_EXEC")"
printf '%s\n' 'OLD_SNAPSHOT_APP_SENTINEL' > "$SNAPSHOT_EXEC"
printf '%s\n' 'OLD_VOICE_APP_SENTINEL' > "$VOICE_EXEC"
chmod 700 "$SNAPSHOT_EXEC" "$VOICE_EXEC"

README_HASH=$(shasum -a 256 "$VAULT/README.md" | awk '{print $1}')
STATUS_HASH=$(shasum -a 256 "$VAULT/.review/status/state.txt" | awk '{print $1}')
SCRIPT_HASH=$(shasum -a 256 "$VAULT/.scripts/append_text.sh" | awk '{print $1}')
SNAPSHOT_HASH=$(shasum -a 256 "$SNAPSHOT_EXEC" | awk '{print $1}')
VOICE_HASH=$(shasum -a 256 "$VOICE_EXEC" | awk '{print $1}')

# 已有 Vault 提示回答 y，Chrome 提示回答 n。
run_install 'yn' "$LOG_DIR/install-second.log"

[ "$README_HASH" = "$(shasum -a 256 "$VAULT/README.md" | awk '{print $1}')" ]
[ "$STATUS_HASH" = "$(shasum -a 256 "$VAULT/.review/status/state.txt" | awk '{print $1}')" ]
[ "$SCRIPT_HASH" = "$(shasum -a 256 "$VAULT/.scripts/append_text.sh" | awk '{print $1}')" ]
[ "$SNAPSHOT_HASH" = "$(shasum -a 256 "$SNAPSHOT_EXEC" | awk '{print $1}')" ]
[ "$VOICE_HASH" = "$(shasum -a 256 "$VOICE_EXEC" | awk '{print $1}')" ]
[ "$(cat "$USER_WF/Contents/document.wflow")" = 'USER_WORKFLOW_SENTINEL' ]
[ -f "$VAULT/.chrome-newtab/manifest.json" ]
[ -f "$VAULT/.chrome-newtab/dashboard-cache-library.js" ]
[ -x "$VAULT/.review/review_cycle.sh" ]
[ -x "$VAULT/.review/commit_review.sh" ]
[ -x "$VAULT/.review/commit_review_atomic.py" ]
[ "$(cat "$TEST_HOME/Library/Services/存入 AI 秘书 (语音).workflow/Contents/.memento-managed")" = 'com.memento.workflow.v1' ]

# Vault 与事实文件默认仅当前用户可读；升级不能留下 staging/backup/lock。
[ "$(stat -f %Lp "$VAULT")" = '700' ]
for PRIVATE_FILE in \
  "$VAULT/README.md" \
  "$VAULT/2026-07-16.md" \
  "$VAULT/assets/user-asset.txt" \
  "$VAULT/Reviews/Daily/2026-07-16.md" \
  "$VAULT/.review/status/state.txt"; do
  [ "$(stat -f %Lp "$PRIVATE_FILE")" = '600' ]
done
for ACL_TARGET in "$VAULT" "$VAULT/README.md"; do
  if ls -led "$ACL_TARGET" | tail -n +2 | rg -q '^[[:space:]]*[0-9]+:'; then
    echo "安装后仍残留可绕过 0700/0600 的扩展 ACL: $ACL_TARGET" >&2
    exit 1
  fi
done

if find "$TEST_HOME" \
  \( -name '.memento-install.lock' \
     -o -name '.memento-workflow.*' \
     -o -name '.memento-*-build.*' \
     -o -name '.memento-backup.*' \
     -o -name '.scripts-stage.*' \
     -o -name '.chrome-newtab-stage.*' \
     -o -name '.review-stage.*' \
     -o -name '.ocr-image.*' \
     -o -name '.append-daily-snapshot.*' \) \
  -print -quit | rg -q .; then
  echo '安装后遗留 staging、backup 或 lock' >&2
  exit 1
fi

# 默认卸载回答 n：只移除执行组件，保留事实、资产、Reviews 和用户 Workflow。
# 无法确认归属的同名 LaunchAgent 也必须保留。
cat > "$LEGACY_PLIST" <<'FOREIGN_PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.foreign</string>
  <key>ProgramArguments</key><array><string>/bin/true</string></array>
</dict></plist>
FOREIGN_PLIST_EOF
run_uninstall 'n' "$LOG_DIR/uninstall-first.log"

[ ! -d "$VAULT/.scripts" ]
[ ! -d "$VAULT/.apps" ]
[ ! -d "$VAULT/.chrome-newtab" ]
[ ! -d "$VAULT/.review" ]
[ -f "$LEGACY_PLIST" ]
[ -f "$VAULT/2026-07-16.md" ]
[ "$(cat "$VAULT/assets/user-asset.txt")" = 'USER_ASSET_SENTINEL' ]
[ "$(cat "$VAULT/Reviews/Daily/2026-07-16.md")" = 'USER_REVIEW_SENTINEL' ]
rg -qF 'USER_README_SENTINEL' "$VAULT/README.md"
[ "$(cat "$USER_WF/Contents/document.wflow")" = 'USER_WORKFLOW_SENTINEL' ]
[ ! -d "$TEST_HOME/.memento-install.lock" ]

for NAME in \
  '存入 AI 秘书 (选标签)' \
  '存入 AI 秘书 (加备注)' \
  '存入 AI 秘书 (截图)' \
  '存入 AI 秘书 (语音)'; do
  [ ! -d "$TEST_HOME/Library/Services/$NAME.workflow" ]
done

# 卸载幂等：第二次运行仍不删除默认保留的数据和未托管 Workflow。
run_uninstall 'n' "$LOG_DIR/uninstall-second.log"
[ -f "$VAULT/2026-07-16.md" ]
[ -f "$VAULT/assets/user-asset.txt" ]
[ -f "$VAULT/Reviews/Daily/2026-07-16.md" ]
[ "$(cat "$USER_WF/Contents/document.wflow")" = 'USER_WORKFLOW_SENTINEL' ]

# 活跃安装锁必须 fail closed，且不能在退出时删除别人的锁或开始写入。
mkdir "$TEST_HOME/.memento-install.lock"
printf '%s\n' 'foreign-token' > "$TEST_HOME/.memento-install.lock/token"
printf '%s\n' "$$" > "$TEST_HOME/.memento-install.lock/pid"
set +e
run_install 'yn' "$LOG_DIR/install-locked.log"
LOCKED_STATUS=$?
set -e
[ "$LOCKED_STATUS" -ne 0 ]
[ "$(cat "$TEST_HOME/.memento-install.lock/token")" = 'foreign-token' ]
[ ! -d "$VAULT/.scripts" ]
rm -rf "$TEST_HOME/.memento-install.lock"

echo '✓ installer contract: isolated install, idempotent upgrade and data-preserving uninstall'
