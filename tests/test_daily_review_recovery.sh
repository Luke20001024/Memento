#!/bin/bash

set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test -x "$ROOT/daily-review/verify_review.sh"
test -x "$ROOT/daily-review/commit_review.sh"
test -x "$ROOT/daily-review/commit_review_atomic.py"
TMP_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

VAULT="$TMP_ROOT/vault with spaces"
mkdir -p "$VAULT/.chrome-newtab" "$VAULT/Reviews/Daily"

write_prompt() {
  local text="$1"
  printf "const MEMENTO_STYLES = [{ id: 'comprehensive', text: '%s' }];\n" "$text" \
    > "$VAULT/.chrome-newtab/prompts.js"
}

write_valid_review() {
  local date="$1"
  local source_hash="$2"
  local prompt_hash="$3"
  local scene_content="${4-无}"
  local supplement_content="${5-无}"
  local source_mock="${6-false}"
  local output_path="${7-$VAULT/Reviews/Daily/$date.md}"

  printf '%s\n' \
    '---' \
    "date: $date" \
    'type: memento-review' \
    'period: daily' \
    "source: \"[[$date]]\"" \
    "source_hash: \"$source_hash\"" \
    "source_mock: $source_mock" \
    'prompt: memento-comprehensive' \
    "prompt_hash: \"$prompt_hash\"" \
    'generated_at: 2026-07-13T21:00:00+08:00' \
    '---' \
    '' \
    "# Daily Review · $date" \
    '' \
    '## 工作与生活现场' \
    '' \
    "$scene_content" \
    '' \
    '## 行动线索' \
    '' \
    '无' \
    '' \
    '## 灵感与想法' \
    '' \
    '无' \
    '' \
    '## 个人记录/情绪' \
    '' \
    '无' \
    '' \
    '## 已忽略' \
    '' \
    '无' \
    '' \
    '## 来源索引' \
    '' \
    "- [[$date]]" \
    '' \
    '## 我的补充' \
    '' \
    "$supplement_content" \
    > "$output_path"
}

write_prompt 'test'
printf '# 2026-07-12\n\n## 20:00 · 记录\n\n昨天。\n' > "$VAULT/2026-07-12.md"
printf '# 2026-07-13\n\n## 20:00 · 记录\n\n今天。\n' > "$VAULT/2026-07-13.md"

PREVIOUS_HASH=$(shasum -a 256 "$VAULT/2026-07-12.md" | awk '{print $1}')
PROMPT_HASH=$(shasum -a 256 "$VAULT/.chrome-newtab/prompts.js" | awk '{print $1}')
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH"
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null

CYCLE_OUTPUT="$TMP_ROOT/cycle.ndjson"
MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" "$VAULT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [outputPath, vault] = process.argv.slice(2);
const rows = fs.readFileSync(outputPath, 'utf8').trim().split('\n').map(JSON.parse);

assert.equal(rows.length, 3);
assert.deepEqual(rows.slice(0, 2).map(row => row.role), ['previous', 'today']);

assert.equal(rows[0].date, '2026-07-12');
assert.equal(rows[0].status, 'up_to_date');
assert.equal(rows[0].action, 'skip');
assert.equal(rows[0].exit_code, 0);
assert.equal(rows[0].source_mock, false);
assert.equal(rows[0].status_file, `${vault}/.review/status/2026-07-12.json`);
assert.match(rows[0].prompt_hash, /^[a-f0-9]{64}$/);
assert.match(rows[0].review_hash, /^[a-f0-9]{64}$/);

assert.equal(rows[1].date, '2026-07-13');
assert.equal(rows[1].status, 'needs_generation');
assert.equal(rows[1].action, 'generate');
assert.equal(rows[1].exit_code, 0);
assert.match(rows[1].source_hash, /^[a-f0-9]{64}$/);
assert.equal(rows[1].prompt_hash, rows[0].prompt_hash);
assert.equal(rows[1].review_hash, '__MEMENTO_REVIEW_ABSENT__');

assert.equal(rows[2].kind, 'review_cycle_summary');
assert.equal(rows[2].checked, 2);
assert.equal(rows[2].generation_needed, 1);
assert.equal(rows[2].blocked, 0);
NODE

# 一份完整结果才能 up_to_date；临时文件也使用同一严格校验器。
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" \
  2026-07-12 "$VAULT/Reviews/Daily/2026-07-12.md" >/dev/null
TZ=UTC MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" \
  2026-07-12 "$VAULT/Reviews/Daily/2026-07-12.md" >/dev/null

# 截断文件即使保留正确 source_hash / prompt_hash，也必须重建，不能被误报 success。
printf '%s\n' \
  '---' \
  'date: 2026-07-12' \
  'type: memento-review' \
  'period: daily' \
  'source: "[[2026-07-12]]"' \
  "source_hash: \"$PREVIOUS_HASH\"" \
  'source_mock: false' \
  'prompt: memento-comprehensive' \
  "prompt_hash: \"$PROMPT_HASH\"" \
  'generated_at: 2026-07-13T21:00:00+08:00' \
  '---' \
  '# Daily Review · 2026-07-12' \
  > "$VAULT/Reviews/Daily/2026-07-12.md"

TRUNCATED_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^STATUS=needs_generation$' <<< "$TRUNCATED_STATUS"
if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" \
  2026-07-12 >/dev/null 2>&1; then
  echo 'verify_review.sh accepted a truncated Review' >&2
  exit 1
fi

# 无 frontmatter 的正文不能用正文伪造字段。
printf '%s\n' \
  '# Daily Review · 2026-07-12' \
  "source_hash: \"$PREVIOUS_HASH\"" \
  "prompt_hash: \"$PROMPT_HASH\"" \
  '## 工作与生活现场' \
  '无' \
  > "$VAULT/Reviews/Daily/2026-07-12.md"
NO_FRONTMATTER_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^STATUS=needs_generation$' <<< "$NO_FRONTMATTER_STATUS"

# 旧 Review 没有 prompt_hash 时执行一次性重建；状态检查本身不得破坏人工补充。
printf '%s\n' \
  '---' \
  'date: 2026-07-12' \
  'type: memento-review' \
  'period: daily' \
  'source: "[[2026-07-12]]"' \
  "source_hash: \"$PREVIOUS_HASH\"" \
  'source_mock: false' \
  'prompt: memento-comprehensive' \
  'generated_at: 2026-07-13T21:00:00+08:00' \
  '---' \
  '# Daily Review · 2026-07-12' \
  '## 工作与生活现场' \
  '无' \
  '## 行动线索' \
  '无' \
  '## 灵感与想法' \
  '无' \
  '## 个人记录/情绪' \
  '无' \
  '## 已忽略' \
  '无' \
  '## 来源索引' \
  '- [[2026-07-12]]' \
  '## 我的补充' \
  '请保留这段人工补充' \
  > "$VAULT/Reviews/Daily/2026-07-12.md"
LEGACY_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^STATUS=needs_generation$' <<< "$LEGACY_STATUS"
grep -q '请保留这段人工补充' "$VAULT/Reviews/Daily/2026-07-12.md"

# 空章节违反合同；重建后“无”是合法的显式正文。
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" '' '请保留这段人工补充'
if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" \
  2026-07-12 >/dev/null 2>&1; then
  echo 'verify_review.sh accepted an empty required section' >&2
  exit 1
fi
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" '无' '请保留这段人工补充'
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null

# “我的补充”属于用户，历史人工内容中的普通 H2 必须原样兼容。
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" '无' $'## 项目 A\n人工补充正文'
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null

# fenced code 中看起来像固定章节的文本不是结构标题。
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" '无' $'```md\n## 工作与生活现场\n```\n代码后的补充'
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null

# 但固定章节不能在“我的补充”里重复，避免伪造结构蒙混过关。
printf '%s\n' '## 工作与生活现场' '重复章节' >> "$VAULT/Reviews/Daily/2026-07-12.md"
if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" \
  2026-07-12 >/dev/null 2>&1; then
  echo 'verify_review.sh accepted a duplicate section after 我的补充' >&2
  exit 1
fi
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" '无' '### 人工小标题'
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null

# 看似符合格式但不存在的日历时间也不能通过。
sed -i '' 's/generated_at: 2026-07-13T21:00:00+08:00/generated_at: 2026-99-99T21:00:00+08:00/' \
  "$VAULT/Reviews/Daily/2026-07-12.md"
if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" \
  2026-07-12 >/dev/null 2>&1; then
  echo 'verify_review.sh accepted an invalid generated_at calendar date' >&2
  exit 1
fi
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" '无' '请保留这段人工补充'

# 任意 Prompt 文件内容变化都会改变 prompt_hash，使旧 Review 保守重建一次。
write_prompt 'test-v2'
NEW_PROMPT_HASH=$(shasum -a 256 "$VAULT/.chrome-newtab/prompts.js" | awk '{print $1}')
[ "$NEW_PROMPT_HASH" != "$PROMPT_HASH" ]
PROMPT_CHANGED_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^STATUS=needs_generation$' <<< "$PROMPT_CHANGED_STATUS"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$NEW_PROMPT_HASH" '无' '请保留这段人工补充'
PROMPT_CURRENT_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^STATUS=up_to_date$' <<< "$PROMPT_CURRENT_STATUS"
PROMPT_HASH="$NEW_PROMPT_HASH"

# source_mock 必须只从真正的源 frontmatter 读取，并由严格校验器核对 true/false。
printf '%s\n' \
  '---' \
  'date: 2026-07-12' \
  'type: memento-daily' \
  'mock: true' \
  '---' \
  '' \
  '## 20:00 · 记录' \
  '' \
  '模拟记录。' \
  > "$VAULT/2026-07-12.md"
MOCK_SOURCE_HASH=$(shasum -a 256 "$VAULT/2026-07-12.md" | awk '{print $1}')
write_valid_review '2026-07-12' "$MOCK_SOURCE_HASH" "$PROMPT_HASH" '无' '无' true
MOCK_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^SOURCE_MOCK=true$' <<< "$MOCK_STATUS"
grep -q '^STATUS=up_to_date$' <<< "$MOCK_STATUS"

# 恢复普通源，覆盖 false 分支并让后续 cycle 继续校验最新结果。
printf '# 2026-07-12\n\n## 20:00 · 记录\n\n昨天。\n' > "$VAULT/2026-07-12.md"
PREVIOUS_HASH=$(shasum -a 256 "$VAULT/2026-07-12.md" | awk '{print $1}')
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH"
NON_MOCK_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^SOURCE_MOCK=false$' <<< "$NON_MOCK_STATUS"
grep -q '^STATUS=up_to_date$' <<< "$NON_MOCK_STATUS"

# commit_review 是唯一提交入口：现有人工补充不能被候选结果静默删掉。
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '现有现场' '请逐字保留这段人工补充'
SUPPLEMENT_START=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
SUPPLEMENT_HASH=$(sed -n 's/^REVIEW_HASH=//p' <<< "$SUPPLEMENT_START")
SUPPLEMENT_TEMP="$VAULT/Reviews/Daily/.2026-07-12.drop-supplement.$$.md"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '候选现场' '无' false "$SUPPLEMENT_TEMP"
FORMAL_BEFORE=$(shasum -a 256 "$VAULT/Reviews/Daily/2026-07-12.md" | awk '{print $1}')
set +e
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/commit_review.sh" \
  2026-07-12 "$SUPPLEMENT_TEMP" "$SUPPLEMENT_HASH" >/dev/null 2>&1
SUPPLEMENT_COMMIT_STATUS=$?
set -e
[ "$SUPPLEMENT_COMMIT_STATUS" -eq 8 ]
[ -f "$SUPPLEMENT_TEMP" ]
[ "$FORMAL_BEFORE" = "$(shasum -a 256 "$VAULT/Reviews/Daily/2026-07-12.md" | awk '{print $1}')" ]
grep -qF '请逐字保留这段人工补充' "$VAULT/Reviews/Daily/2026-07-12.md"
rm -f "$SUPPLEMENT_TEMP"

# 用户在模型生成期间编辑正式 Review：CAS 必须以 75 冲突退出，候选和人工编辑都保留。
GENERATION_START=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
GENERATION_HASH=$(sed -n 's/^REVIEW_HASH=//p' <<< "$GENERATION_START")
USER_EDIT_TEMP="$VAULT/Reviews/Daily/.2026-07-12.user-edit.$$.md"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '模型生成结果' '请逐字保留这段人工补充' false "$USER_EDIT_TEMP"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '现有现场' '用户在生成期间写下的新补充'
USER_EDITED_HASH=$(shasum -a 256 "$VAULT/Reviews/Daily/2026-07-12.md" | awk '{print $1}')
set +e
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/commit_review.sh" \
  2026-07-12 "$USER_EDIT_TEMP" "$GENERATION_HASH" >"$TMP_ROOT/user-edit.log" 2>&1
USER_EDIT_STATUS=$?
set -e
[ "$USER_EDIT_STATUS" -eq 75 ]
[ -f "$USER_EDIT_TEMP" ]
[ "$USER_EDITED_HASH" = "$(shasum -a 256 "$VAULT/Reviews/Daily/2026-07-12.md" | awk '{print $1}')" ]
grep -qF '用户在生成期间写下的新补充' "$VAULT/Reviews/Daily/2026-07-12.md"
grep -qF '退出码 75' "$TMP_ROOT/user-edit.log"
rm -f "$USER_EDIT_TEMP"

# 两个生成器从同一 Review hash 出发：按日锁 + CAS 只允许一个成功，另一个候选保留。
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '并发起点' '并发测试人工补充'
CONCURRENT_START=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
CONCURRENT_HASH=$(sed -n 's/^REVIEW_HASH=//p' <<< "$CONCURRENT_START")
CONCURRENT_A="$VAULT/Reviews/Daily/.2026-07-12.concurrent-a.$$.md"
CONCURRENT_B="$VAULT/Reviews/Daily/.2026-07-12.concurrent-b.$$.md"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '并发候选 A' '并发测试人工补充' false "$CONCURRENT_A"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '并发候选 B' '并发测试人工补充' false "$CONCURRENT_B"
set +e
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/commit_review.sh" \
  2026-07-12 "$CONCURRENT_A" "$CONCURRENT_HASH" >"$TMP_ROOT/concurrent-a.log" 2>&1 &
CONCURRENT_A_PID=$!
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/commit_review.sh" \
  2026-07-12 "$CONCURRENT_B" "$CONCURRENT_HASH" >"$TMP_ROOT/concurrent-b.log" 2>&1 &
CONCURRENT_B_PID=$!
wait "$CONCURRENT_A_PID"
CONCURRENT_A_STATUS=$?
wait "$CONCURRENT_B_PID"
CONCURRENT_B_STATUS=$?
set -e
if [ $((CONCURRENT_A_STATUS + CONCURRENT_B_STATUS)) -ne 75 ]; then
  echo "并发提交退出码错误: A=$CONCURRENT_A_STATUS B=$CONCURRENT_B_STATUS" >&2
  cat "$TMP_ROOT/concurrent-a.log" "$TMP_ROOT/concurrent-b.log" >&2
  exit 1
fi
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null
grep -Eq '并发候选 (A|B)' "$VAULT/Reviews/Daily/2026-07-12.md"
grep -qF '并发测试人工补充' "$VAULT/Reviews/Daily/2026-07-12.md"
if [ "$CONCURRENT_A_STATUS" -eq 0 ]; then
  [ ! -e "$CONCURRENT_A" ]
  [ -f "$CONCURRENT_B" ]
else
  [ -f "$CONCURRENT_A" ]
  [ ! -e "$CONCURRENT_B" ]
fi
rm -f "$CONCURRENT_A" "$CONCURRENT_B"

# 正式 Review 不存在时使用明确 sentinel + RENAME_EXCL，原子创建且最终再次严格校验。
rm -f "$VAULT/Reviews/Daily/2026-07-12.md"
ABSENT_STATUS=$(MEMENTO_VAULT="$VAULT" \
  bash "$ROOT/daily-review/review_status.sh" 2026-07-12)
grep -q '^REVIEW_HASH=__MEMENTO_REVIEW_ABSENT__$' <<< "$ABSENT_STATUS"
grep -q '^STATUS=needs_generation$' <<< "$ABSENT_STATUS"
ABSENT_TEMP="$VAULT/Reviews/Daily/.2026-07-12.absent.$$.md"
write_valid_review '2026-07-12' "$PREVIOUS_HASH" "$PROMPT_HASH" \
  '首次生成' '无' false "$ABSENT_TEMP"
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/commit_review.sh" \
  2026-07-12 "$ABSENT_TEMP" '__MEMENTO_REVIEW_ABSENT__' >/dev/null
[ ! -e "$ABSENT_TEMP" ]
MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/verify_review.sh" 2026-07-12 >/dev/null

# 成功替换保留提交前 inode 的私有恢复链接；持久 lock file 使用 0600 + flock。
find "$VAULT/Reviews/.recovery/Daily" -type f \
  -name '2026-07-12.previous.*.md' -print -quit | grep -q .
[ -f "$VAULT/.state/review-commit-locks/2026-07-12.lock" ]
[ "$(stat -f %Lp "$VAULT/.state/review-commit-locks/2026-07-12.lock")" = '600' ]

MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" previous > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows.length, 2);
assert.equal(rows[0].role, 'previous');
assert.equal(rows[1].kind, 'review_cycle_summary');
assert.equal(rows[1].checked, 1);
NODE

rm "$VAULT/2026-07-13.md"
MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows[1].status, 'missing_source');
assert.equal(rows[1].action, 'skip');
assert.equal(rows[1].exit_code, 3);
assert.equal(rows[2].generation_needed, 0);
NODE

rm "$VAULT/.chrome-newtab/prompts.js"
MEMENTO_VAULT="$VAULT" MEMENTO_CYCLE_TODAY=2026-07-13 \
  bash "$ROOT/daily-review/review_cycle.sh" > "$CYCLE_OUTPUT"

node - "$CYCLE_OUTPUT" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows[0].status, 'missing_prompt');
assert.equal(rows[0].action, 'blocked');
assert.equal(rows[0].exit_code, 4);
assert.match(rows[0].message, /Prompt/);
assert.equal(rows[2].blocked, 1);
NODE

MESSAGE=$'模型返回 "no"\n稍后重试\\一次'
STATE_OUTPUT=$(MEMENTO_VAULT="$VAULT" MEMENTO_STATUS_NOW=2026-07-13T21:01:02+0800 \
  bash "$ROOT/daily-review/review_state.sh" 2026-07-12 failed "$MESSAGE")

node - "$VAULT/.review/status/2026-07-12.json" "$STATE_OUTPUT" "$MESSAGE" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [statusPath, stdoutJson, expectedMessage] = process.argv.slice(2);
const fromFile = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
const fromStdout = JSON.parse(stdoutJson);

assert.deepEqual(fromFile, fromStdout);
assert.deepEqual(fromFile, {
  date: '2026-07-12',
  status: 'failed',
  updated_at: '2026-07-13T21:01:02+08:00',
  message: expectedMessage,
});
NODE

MEMENTO_VAULT="$VAULT" MEMENTO_STATUS_NOW=2026-07-13T21:02:00+08:00 \
  bash "$ROOT/daily-review/review_state.sh" 2026-07-12 success >/dev/null

node - "$VAULT/.review/status/2026-07-12.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(state.status, 'success');
assert.equal(state.message, 'Daily Review 校验通过');
NODE

if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/review_state.sh" \
  2026-07-12 waiting >/dev/null 2>&1; then
  echo 'review_state.sh accepted an unsupported status' >&2
  exit 1
fi

if MEMENTO_VAULT="$VAULT" bash "$ROOT/daily-review/review_state.sh" \
  2026-02-31 failed >/dev/null 2>&1; then
  echo 'review_state.sh accepted a normalized but invalid calendar date' >&2
  exit 1
fi

if find "$VAULT/.review/status" -name '*.tmp' -o -name '.*.json.*' | grep -q .; then
  echo 'review_state.sh left a temporary file behind' >&2
  exit 1
fi

echo '✓ daily review recovery: checks previous/today and writes atomic Dashboard states'
