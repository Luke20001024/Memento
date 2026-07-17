# Memento Daily Review

这是 Codex 每日总结任务的执行协议。内容风格不在这里重复维护；每次运行必须读取 Vault 内 `.chrome-newtab/prompts.js`，找到 `MEMENTO_STYLES` 中 `id: 'comprehensive'` 的 `text`，将它作为唯一的总结 Prompt。

## 自动日级循环

自动任务每天运行两次（Asia/Shanghai）：

- 08:00 只复核昨天，用于补齐昨晚 21:00 后新增的记录或失败任务。
- 21:00 先复核昨天，再处理今天。

晨间运行：

```bash
~/AISecretary/.review/review_cycle.sh previous
```

晚间运行：

```bash
~/AISecretary/.review/review_cycle.sh
```

脚本每行输出独立 JSON。晨间只输出昨天，晚间固定按“昨天 → 今天”输出。必须按输出顺序逐日处理，以便先补昨天的漏跑，再生成今天的 Review。

对每条 `review_cycle_item`：

- `status=missing_source`：跳过，不创建空 Review，不写 `failed`。
- `status=up_to_date`：跳过 AI 调用；运行 `review_state.sh DATE success "Daily Review 已是最新"`，用成功状态覆盖可能残留的旧失败。
- `status=needs_generation`：继续下方生成流程。
- `status=missing_prompt` 或 `status=check_failed`：运行 `review_state.sh DATE failed "MESSAGE"`，该日期停止。

`review_cycle.sh` 自身只做确定性检查，不调用 AI，也不写 `pending` 或 `failed`。没有到计划时间、当天没有原始记录、状态文件不存在，都不是失败。

`up_to_date` 是完整合同校验，不只是比较 `source_hash`：现有 Review 的 frontmatter、Prompt 版本、标题、章节非空和来源索引都必须通过 `verify_review.sh`。cycle item 中的 `PROMPT_HASH` / `prompt_hash` 是整个 `.chrome-newtab/prompts.js` 的 SHA-256；采用整文件 hash 是为了不漏掉 `comprehensive` 的任何变化，其他风格改动至多触发一次保守重建。

每条 cycle item 还包含生成事务起点的 `review_hash`：现有正式 Review 使用 64 位 SHA-256，不存在时明确返回 `__MEMENTO_REVIEW_ABSENT__`。它不是展示字段；生成完成后必须原样传给 `commit_review.sh` 做 compare-and-swap。不得在模型调用结束后重新读取 hash 来绕过冲突。

## 单日处理

- 自动循环使用上一步返回的日期。
- 用户明确要求“今天”时处理当天。
- 用户明确要求“昨天”或补跑漏跑任务时处理前一天。
- 用户给出 `YYYY-MM-DD` 时处理该日期。

先运行：

```bash
~/AISecretary/.review/review_status.sh [today|previous|YYYY-MM-DD]
```

- `STATUS=missing_source`：停止，不创建空 Review。
- `STATUS=up_to_date`：停止，不重复调用 AI。
- `STATUS=needs_generation`：继续生成或更新 Review。

保存本次输出中的 `REVIEW_HASH`。它定义了生成起点；模型运行期间若用户或另一个生成器改动正式 Review，提交必须冲突退出，不能覆盖该改动。

只有在已经决定处理 `needs_generation` 后，才运行：

```bash
~/AISecretary/.review/review_state.sh YYYY-MM-DD pending "开始生成 Daily Review"
```

## 输入边界

只读取：

1. `SOURCE_FILE` 指向的当天原始记录。
2. `.chrome-newtab/prompts.js` 中 `id: 'comprehensive'` 的标准 Prompt。
3. 生成起点已有 Review 的 `## 我的补充` 部分，仅用于原样保留人工内容。

不要读取其他日期来补全事实，不要联网，不要修改原始记录。单日总结不生成“跨天观察”。

## 输出文件

写入 `REVIEW_FILE`，格式固定为：

```markdown
---
date: YYYY-MM-DD
type: memento-review
period: daily
source: "[[YYYY-MM-DD]]"
source_hash: "<SOURCE_HASH>"
source_mock: false
prompt: memento-comprehensive
prompt_hash: "<PROMPT_HASH>"
generated_at: YYYY-MM-DDTHH:MM:SS+08:00
---

# Daily Review · YYYY-MM-DD

## 工作与生活现场

## 行动线索

## 灵感与想法

## 个人记录/情绪

## 已忽略

## 来源索引

- [[YYYY-MM-DD]]

## 我的补充

无

```

`source_mock` 根据原始文件 frontmatter 的 `mock: true` 判断。

## 生成规则

- 严格执行 `comprehensive` Prompt 的归组、去重和噪声过滤规则。
- 重要事实或判断后附 `([[YYYY-MM-DD]] · HH:MM)`，保持可追溯。
- 只把原始记录中明确出现的行动倾向写入“行动线索”；它用于回看，不代表承诺、优先级或完成清单。
- 不把模糊句子强行任务化，不根据 `#TODO` 标签催促、排序或判断是否推进。
- 不补 deadline，不补人名，不猜项目背景。
- 数字测试、占位消息、乱码和重复内容放入“已忽略”，简要说明数量与原因。
- 没有内容的章节写“无”，不要删除章节。
- 所有必需章节都必须有正文；没有内容时写“无”。`## 来源索引` 至少包含精确的 `- [[YYYY-MM-DD]]`。
- 已有 Review 中 `## 我的补充` 及其后非空内容必须原样保留；旧文件该章节为空时，重建后写“无”。新补充建议使用 `###` 或更低级标题；校验器仍兼容历史补充中的普通 `##` 标题，但不允许在补充区重复七个固定章节名。
- 只写 `Reviews/Daily/` 内与正式文件同目录的私有临时文件；绝不直接写或 `mv` 覆盖正式文件。

## 旧 Review 一次性迁移

旧 Review 若缺少 `prompt_hash`、仍使用旧章节名、frontmatter 不完整或存在空章节，`review_status.sh` 会返回 `needs_generation`，不会把旧结果伪装成新版本，也不会原地补字段。按正常生成流程重建一次，并继续保留非空的 `## 我的补充`；新文件通过严格校验后即恢复 `up_to_date`。自动循环只迁移它本次检查的昨天/今天；更早历史 Review 继续只读保留，用户显式处理该日期时再按需迁移，不做无授权的全量模型回填。

完成后只运行确定性提交入口：

```bash
~/AISecretary/.review/commit_review.sh \
  YYYY-MM-DD \
  /path/to/Reviews/Daily/.same-directory-temp.md \
  "$REVIEW_HASH"
```

`commit_review.sh` 是唯一允许的提交入口。它按日期互斥，先严格校验候选和人工补充，再执行原子 CAS：已有文件使用 `RENAME_SWAP` 并核验交换出的旧 inode，不存在时使用 `RENAME_EXCL`。成功后还会对正式文件再次运行严格校验；提交前版本保存在 `Reviews/.recovery/Daily/`，权限仅当前用户可读。

- 退出码 `0`：提交和正式文件最终校验均成功；然后运行：

```bash
~/AISecretary/.review/review_state.sh YYYY-MM-DD success "Daily Review 校验通过"
```

- 退出码 `75`：生成期间正式 Review 已变化或出现并发提交。正式用户版本不会被静默覆盖，候选文件或恢复副本会保留。记录一次简短的冲突失败；如需重试，必须重新运行 `review_status.sh`，重新读取 Review 和 `REVIEW_HASH` 后再生成。
- 其他非零退出码：候选格式、人工补充保留、I/O 或最终严格校验失败；保留临时文件并记录实际失败。

如果读取 Prompt、调用模型、写临时文件、CAS 提交或最终校验中的任意一步实际失败，必须运行：

```bash
~/AISecretary/.review/review_state.sh YYYY-MM-DD failed "简短、可展示的失败原因"
```

失败消息不要包含原始记录正文、模型密钥或其他敏感信息。`failed` 只代表这一次实际执行失败；不能因为尚未到计划时间、没有原始记录或没有运行状态文件而推断失败。
