# Daily Review

Memento 的 AI 每日总结执行协议。它不维护第二份内容 Prompt，而是始终读取 `chrome-newtab/prompts.js` 中 `id: 'comprehensive'` 的标准 Prompt。

Review 用来帮助回看和理解记录，不承担任务完成管理。`#TODO` 只是原始记录标签；新 Review 使用“行动线索”承接明确写下的行动倾向，不生成催办或清理清单。

安装后文件位于 `~/AISecretary/.review/`，结果写入 `~/AISecretary/Reviews/Daily/YYYY-MM-DD.md`。Codex 自动任务每天 08:00 复核昨天，21:00 先补昨天再处理今天。只有需要生成时才调用模型。

## 日级补跑检查

```bash
~/AISecretary/.review/review_cycle.sh
~/AISecretary/.review/review_cycle.sh previous
```

默认模式按“昨天 → 今天”输出；`previous` 模式只检查昨天，供晨间补跑。格式均为逐行 JSON（NDJSON）。每个日期的 `status` 与动作是：

- `missing_source` → `skip`：当天没有记录，不创建空 Review，也不算失败。
- `up_to_date` → `skip`：现有 Review 已包含最新原始记录。
- `needs_generation` → `generate`：应生成或重新生成 Review。
- `missing_prompt` / `check_failed` → `blocked`：这是一次真实的运行阻塞，应记录失败原因。

`review_cycle.sh` 只判断，不调用 AI，也不改变运行状态。这样仅仅检查页面或在计划时间前运行状态检查，不会被误记为生成失败。`up_to_date` 会复用严格结果校验，不再只看 `source_hash`。

## 状态检查

```bash
~/AISecretary/.review/review_status.sh
~/AISecretary/.review/review_status.sh today
~/AISecretary/.review/review_status.sh previous
~/AISecretary/.review/review_status.sh 2026-07-13
```

脚本同时计算原始记录、现有正式 Review 和整个 `.chrome-newtab/prompts.js` 的 SHA-256，并校验现有 Review 的完整合同，返回 `needs_generation`、`up_to_date` 或 `missing_source`。`REVIEW_HASH` 是本次生成的 CAS 起点；正式文件不存在时为明确 sentinel `__MEMENTO_REVIEW_ABSENT__`。对整个 Prompt 文件取 hash 会保守地响应任意 Prompt 编辑，避免漏掉 `comprehensive` 的变化。

旧 Review 缺少 `prompt_hash` 或不符合当前严格结构时会返回 `needs_generation`，由下一次覆盖该日期的正常流程重建；不会原地冒充新版本。重建必须保留已有的非空 `## 我的补充`，空补充区改写为“无”。自动循环只迁移昨天/今天，更早历史结果保持只读，显式处理对应日期时才按需迁移。

## Dashboard 运行状态

自动任务在实际开始、校验成功或真实失败时写入：

```bash
~/AISecretary/.review/review_state.sh 2026-07-13 pending "开始生成 Daily Review"
~/AISecretary/.review/review_state.sh 2026-07-13 success "Daily Review 校验通过"
~/AISecretary/.review/review_state.sh 2026-07-13 failed "模型调用失败"
```

状态文件为 `~/AISecretary/.review/status/YYYY-MM-DD.json`，使用 UTF-8 JSON：

```json
{
  "date": "2026-07-13",
  "status": "pending",
  "updated_at": "2026-07-13T21:00:00+08:00",
  "message": "开始生成 Daily Review"
}
```

只有真正开始生成时才写 `pending`，只有实际执行或校验出错时才写 `failed`。没有到 21:00、当天无记录、或者状态文件不存在，都不代表失败。状态采用同目录临时文件后原子替换，Dashboard 不会读到半份 JSON。

## 结果校验

```bash
~/AISecretary/.review/verify_review.sh 2026-07-13
~/AISecretary/.review/verify_review.sh 2026-07-13 /path/to/temp-review.md
```

校验严格限制 frontmatter 字段和值，并检查 Prompt hash、一级标题、固定章节非空及来源索引。完整 AI 执行步骤见 `DAILY_REVIEW.md`。原始每日记录不会被修改。

## 冲突安全提交

模型输出必须先写到 `Reviews/Daily/` 内的同目录临时文件，再使用状态检查时得到的 `REVIEW_HASH` 提交：

```bash
~/AISecretary/.review/commit_review.sh \
  2026-07-13 \
  ~/AISecretary/Reviews/Daily/.2026-07-13.generated.md \
  "$REVIEW_HASH"
```

不要直接 `mv` 覆盖正式 Review。提交器会按日期串行、逐字核对现有“我的补充”，并用 macOS 原子 rename CAS；生成期间发生人工编辑或第二个生成器先提交时以退出码 `75` 关闭，不覆盖当前正式文件。候选会留在原临时路径，必要的恢复副本位于 `Reviews/.recovery/Daily/`。
