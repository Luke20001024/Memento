#!/bin/bash
# ============================================================
# Memento 卸载脚本 (v7 · 每日第一帧)
# 作用: 移除所有由 install_aisecretary.sh v7 安装的组件
#       同时兼容清理 v1 残留 (单 workflow + LaunchAgent)
# 注意: 默认保留你的 Obsidian Vault (~/AISecretary),除非明确选择删除
# ============================================================

set -e
set -o pipefail
umask 077

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

INSTALL_LOCK="$HOME/.memento-install.lock"
INSTALL_LOCK_TOKEN="$$-${RANDOM}-$(date +%s)"

release_install_lock() {
  local current_token
  local quarantine
  [ -d "$INSTALL_LOCK" ] || return 0
  current_token=$(cat "$INSTALL_LOCK/token" 2>/dev/null || true)
  [ "$current_token" = "$INSTALL_LOCK_TOKEN" ] || return 0
  quarantine="$INSTALL_LOCK.released.$$.$RANDOM"
  mv "$INSTALL_LOCK" "$quarantine" 2>/dev/null || return 0
  rm -rf "$quarantine" 2>/dev/null || true
}

acquire_install_lock() {
  local owner_pid
  local lock_mtime
  local now
  local quarantine
  for _ in $(seq 1 60); do
    if mkdir "$INSTALL_LOCK" 2>/dev/null; then
      printf '%s\n' "$INSTALL_LOCK_TOKEN" > "$INSTALL_LOCK/token" || {
        rmdir "$INSTALL_LOCK" 2>/dev/null || true
        exit 1
      }
      trap release_install_lock EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM
      printf '%s\n' "$$" > "$INSTALL_LOCK/pid" || exit 1
      return 0
    fi
    owner_pid=$(cat "$INSTALL_LOCK/pid" 2>/dev/null || true)
    if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
      echo -e "${RED}另一个 Memento 安装或卸载进程正在运行 (PID $owner_pid)。${NC}" >&2
      exit 1
    fi
    lock_mtime=$(stat -f %m "$INSTALL_LOCK" 2>/dev/null || echo 0)
    now=$(date +%s)
    if { [ -n "$owner_pid" ] || { [ "$lock_mtime" -gt 0 ] && [ $((now - lock_mtime)) -gt 30 ]; }; }; then
      quarantine="$INSTALL_LOCK.abandoned.$$.$RANDOM"
      if mv "$INSTALL_LOCK" "$quarantine" 2>/dev/null; then
        rm -rf "$quarantine"
        continue
      fi
    fi
    sleep 0.05
  done
  echo -e "${RED}无法获取 Memento 安装锁，请稍后重试。${NC}" >&2
  exit 1
}

memento_workflow_owned() {
  local workflow="$1"
  local marker="$workflow/Contents/.memento-managed"
  local document="$workflow/Contents/document.wflow"
  [ -f "$marker" ] && grep -q '^com.memento.workflow.v1$' "$marker" && return 0
  [ -f "$document" ] && grep -Eq 'AISecretary/\.(scripts|apps)/|Memento Voice Capture\.app' "$document"
}

memento_legacy_launchagent_owned() {
  local plist="$1"
  local label
  [ -f "$plist" ] || return 1
  label=$(plutil -extract Label raw -o - "$plist" 2>/dev/null || true)
  [ "$label" = 'com.aisecretary.screenshot' ] || return 1
  plutil -convert xml1 -o - "$plist" 2>/dev/null \
    | grep -Eq '<string>[^<]*/AISecretary/'
}

acquire_install_lock

echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Memento 卸载程序                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# 1. 卸载截图监听 LaunchAgent (v1 残留)
PLIST="$HOME/Library/LaunchAgents/com.aisecretary.screenshot.plist"
if [ -f "$PLIST" ]; then
  if memento_legacy_launchagent_owned "$PLIST"; then
    echo -e "${BLUE}→ 停止截图监听服务 (v1 残留)...${NC}"
    if [ "${MEMENTO_SKIP_LEGACY_LAUNCHAGENT_UNLOAD:-0}" != '1' ]; then
      launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null \
        || launchctl unload "$PLIST" 2>/dev/null \
        || true
    fi
    rm -f "$PLIST"
    echo -e "${GREEN}  ✓ 已停止${NC}"
  else
    echo -e "${YELLOW}  ⚠ 已保留无法确认归属的同名 LaunchAgent: $PLIST${NC}"
  fi
fi

# 2. 移除 Workflow
echo -e "${BLUE}→ 移除右键菜单服务...${NC}"
REMOVED=0
SERVICES_DIR="$HOME/Library/Services"
for NAME in \
  "存入 AI 秘书" \
  "存入 AI 秘书 (选标签)" \
  "存入 AI 秘书 (加备注)" \
  "存入 AI 秘书 (截图)" \
  "存入 AI 秘书 (语音)" \
  "存入 AI 秘书 (语音+截图)"; do
  WF="$SERVICES_DIR/$NAME.workflow"
  if [ -d "$WF" ]; then
    if memento_workflow_owned "$WF"; then
      rm -rf "$WF"
      echo -e "${GREEN}  ✓ $NAME${NC}"
      REMOVED=$((REMOVED+1))
    else
      echo -e "${YELLOW}  ⚠ 已保留非 Memento 管理的同名 Service: $NAME${NC}"
    fi
  fi
done

# 同时清理早期版本使用的「AI秘书·速记 / 标签 / 备注 / 截图」等入口。
# 这里只删除 Workflow；~/AISecretary 中的历史记录仍按下方默认策略保留。
shopt -s nullglob
for WF in "$SERVICES_DIR/AI秘书.workflow" "$SERVICES_DIR"/AI秘书·*.workflow; do
  [ -d "$WF" ] || continue
  NAME=$(basename "$WF" .workflow)
  if memento_workflow_owned "$WF"; then
    rm -rf "$WF"
    echo -e "${GREEN}  ✓ $NAME (旧版入口)${NC}"
    REMOVED=$((REMOVED+1))
  else
    echo -e "${YELLOW}  ⚠ 已保留非 Memento 管理的旧前缀 Service: $NAME${NC}"
  fi
done
shopt -u nullglob

if [ "$REMOVED" -gt 0 ]; then
  echo -e "${YELLOW}  注意: 系统设置里的快捷键绑定可能需要手动清理${NC}"
  echo -e "${YELLOW}        (位置: 系统设置 → 键盘 → 键盘快捷键 → 服务)${NC}"
  if [ "${MEMENTO_SKIP_SERVICE_REFRESH:-0}" != "1" ]; then
    /System/Library/CoreServices/pbs -update 2>/dev/null || true
  fi
else
  echo -e "${BLUE}  (没有找到任何已安装的 workflow)${NC}"
fi

# 3. 清理本地语音捕获应用
VOICE_APP="$HOME/AISecretary/.apps/Memento Voice Capture.app"

if [ -d "$VOICE_APP" ]; then
  echo ""
  echo -e "${BLUE}→ 清理本地语音捕获应用...${NC}"
  pkill -f "$VOICE_APP/Contents/MacOS/MementoVoiceCapture" 2>/dev/null || true
  rm -rf "$VOICE_APP"
  echo -e "${GREEN}  ✓ 已删除语音捕获应用${NC}"
fi

# 4. 清理每日第一帧应用 (已拍照片和每日状态随 Vault 默认保留)
SNAPSHOT_APP="$HOME/AISecretary/.apps/Memento Daily Snapshot.app"

if [ -d "$SNAPSHOT_APP" ]; then
  echo ""
  echo -e "${BLUE}→ 清理每日第一帧应用...${NC}"
  pkill -f "$SNAPSHOT_APP/Contents/MacOS/MementoDailySnapshot" 2>/dev/null || true
  rm -rf "$SNAPSHOT_APP"
  echo -e "${GREEN}  ✓ 已删除每日第一帧应用${NC}"
fi

# 5. 清理 Chrome 新标签页 Dashboard 资源
NEWTAB_DIR="$HOME/AISecretary/.chrome-newtab"
if [ -d "$NEWTAB_DIR" ]; then
  echo ""
  echo -e "${BLUE}→ 清理 Chrome dashboard 资源...${NC}"
  rm -rf "$NEWTAB_DIR"
  echo -e "${GREEN}  ✓ 已删除 $NEWTAB_DIR${NC}"
  echo -e "${YELLOW}  ⚠ 别忘了去 chrome://extensions 手动移除 'Memento' 扩展${NC}"
  echo -e "${YELLOW}    (Chrome 不允许脚本卸载扩展,只能你点 [移除] 按钮)${NC}"
fi

# 6. 清理 Daily Review 执行协议 (保留已生成的 Reviews)
REVIEW_WORKER="$HOME/AISecretary/.review"
if [ -d "$REVIEW_WORKER" ]; then
  echo ""
  echo -e "${BLUE}→ 清理 Daily Review 执行协议...${NC}"
  rm -rf "$REVIEW_WORKER"
  echo -e "${GREEN}  ✓ 已删除 $REVIEW_WORKER${NC}"
  echo -e "${BLUE}  → 已生成的 ~/AISecretary/Reviews 已保留${NC}"
fi

# 7. 删除产品执行脚本；事实文件、资产和已生成 Review 仍保留。
SCRIPT_DIR="$HOME/AISecretary/.scripts"
if [ -d "$SCRIPT_DIR" ]; then
  echo ""
  echo -e "${BLUE}→ 清理 Memento 执行脚本...${NC}"
  rm -rf "$SCRIPT_DIR"
  echo -e "${GREEN}  ✓ 已删除 $SCRIPT_DIR${NC}"
fi

APPS_DIR="$HOME/AISecretary/.apps"
if [ -d "$APPS_DIR" ]; then
  rmdir "$APPS_DIR" 2>/dev/null || true
fi

# 8. Obsidian Vault 的处理 (默认保留)
SECRETARY_DIR="$HOME/AISecretary"
if [ -d "$SECRETARY_DIR" ]; then
  echo ""
  echo -e "${YELLOW}━━━ 你的 Obsidian Vault ━━━${NC}"
  echo "位置: $SECRETARY_DIR"
  COUNT=$(find "$SECRETARY_DIR" -name "*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  IMG=$(find "$SECRETARY_DIR/assets" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "包含 $COUNT 个 Markdown 文件 + $IMG 张图片/截图"
  echo ""
  read -p "是否一并删除你的数据? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "再次确认: 删除后无法恢复,确定吗? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      rm -rf "$SECRETARY_DIR"
      echo -e "${GREEN}  ✓ 数据已删除${NC}"
      echo -e "${YELLOW}  ⚠ Obsidian 若仍显示 Memento Vault,请在 Vault 列表中手动移除入口${NC}"
    else
      echo -e "${BLUE}  → 数据已保留: $SECRETARY_DIR${NC}"
    fi
  else
    echo -e "${BLUE}  → 数据已保留: $SECRETARY_DIR${NC}"
  fi
fi

echo ""
echo -e "${GREEN}✓ 卸载完成${NC}"
echo ""
