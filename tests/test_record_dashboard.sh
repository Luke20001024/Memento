#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

node --check chrome-newtab/dashboard.js
node --check chrome-newtab/prompts.js

rg -q 'id="record-summary"' chrome-newtab/dashboard.html
rg -q "currentFilter: 'all'" chrome-newtab/dashboard.js
rg -q '今天留下了' chrome-newtab/dashboard.js
rg -q '全部记录' chrome-newtab/dashboard.js
rg -q "KNOWN_TAGS = new Set\(\['TODO', '灵感', '下次再读'\]\)" chrome-newtab/dashboard.js
rg -q '## 行动线索' daily-review/DAILY_REVIEW.md
rg -q '目标是帮助回看和理解,不是督促清理任务' chrome-newtab/prompts.js

for TERM in \
  'todo-check' \
  'aisec.done' \
  '未完成 TODO' \
  '所有 TODO 已清空' \
  '标记完成/撤销' \
  'TODO · Memento' \
  'renderTodoBanner' \
  'updateFavicon' \
  'entry-body.is-done' \
  'chip.is-todo'; do
  if rg -qF "$TERM" chrome-newtab/dashboard.html chrome-newtab/dashboard.js chrome-newtab/dashboard.css; then
    echo "记录面板仍包含任务完成语义: $TERM" >&2
    exit 1
  fi
done

for TERM in '必须处理的 TODO' 'TODO 清单:' 'TODO 漂移' '还在拖的事' '反复出现但没推进'; do
  if rg -qF "$TERM" chrome-newtab/prompts.js; then
    echo "Prompt 仍包含催办语义: $TERM" >&2
    exit 1
  fi
done

# 新 Review 用记录优先章节；旧 Review 仍可通过校验，不要求迁移历史文件。
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT
DATE=2026-07-13
mkdir -p "$TMP_ROOT/Reviews/Daily"
printf '%s\n' '# test record' > "$TMP_ROOT/$DATE.md"
HASH=$(shasum -a 256 "$TMP_ROOT/$DATE.md" | awk '{print $1}')

write_review() {
  local scene_section="$1"
  local action_section="$2"
  printf '%s\n' \
    '---' \
    "date: $DATE" \
    'type: memento-review' \
    'period: daily' \
    'source: "[[2026-07-13]]"' \
    "source_hash: \"$HASH\"" \
    'prompt: memento-comprehensive' \
    '---' \
    '' \
    "## $scene_section" \
    '' \
    "## $action_section" \
    '' \
    '## 灵感与想法' \
    '' \
    '## 个人记录/情绪' \
    '' \
    '## 已忽略' \
    '' \
    '## 来源索引' \
    '' \
    '- [[2026-07-13]]' \
    '' \
    '## 我的补充' > "$TMP_ROOT/Reviews/Daily/$DATE.md"
}

write_review '工作与生活现场' '行动线索'
MEMENTO_VAULT="$TMP_ROOT" bash daily-review/verify_review.sh "$DATE" >/dev/null

write_review '工作事项' 'TODO 清单'
MEMENTO_VAULT="$TMP_ROOT" bash daily-review/verify_review.sh "$DATE" >/dev/null

# 本机存在已安装目录时,顺便防止“源码已改、Chrome 仍运行旧版”。
INSTALLED_ROOT="${MEMENTO_INSTALLED_ROOT:-$HOME/AISecretary}"
if [ -d "$INSTALLED_ROOT/.chrome-newtab" ] && [ -d "$INSTALLED_ROOT/.review" ]; then
  for FILE in README.md daily-summary-library.js dashboard.css dashboard.html dashboard.js manifest.json photo-library.js prompts.js viewer.html; do
    cmp -s "chrome-newtab/$FILE" "$INSTALLED_ROOT/.chrome-newtab/$FILE" || {
      echo "已安装扩展未同步: $FILE" >&2
      exit 1
    }
  done
  for FILE in DAILY_REVIEW.md README.md review_cycle.sh review_state.sh review_status.sh verify_review.sh; do
    cmp -s "daily-review/$FILE" "$INSTALLED_ROOT/.review/$FILE" || {
      echo "已安装 Daily Review 未同步: $FILE" >&2
      exit 1
    }
  done
fi

echo "✓ record-first dashboard: no completion state, neutral TODO tag, compatible Daily Review"
