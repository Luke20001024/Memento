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

只有在已经决定处理 `needs_generation` 后，才运行：

```bash
~/AISecretary/.review/review_state.sh YYYY-MM-DD pending "开始生成 Daily Review"
```

## 输入边界

只读取：

1. `SOURCE_FILE` 指向的当天原始记录。
2. `.chrome-newtab/prompts.js` 中 `id: 'comprehensive'` 的标准 Prompt。
3. 已有 Review 的 `## 我的补充` 部分，仅用于原样保留人工内容。

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
- 已有 Review 中 `## 我的补充` 及其后内容必须原样保留。
- 先写同目录临时文件，校验通过后再替换正式文件，避免留下半份结果。

完成后运行：

```bash
~/AISecretary/.review/verify_review.sh YYYY-MM-DD
```

只有校验退出码为 0 时，任务才算成功，并运行：

```bash
~/AISecretary/.review/review_state.sh YYYY-MM-DD success "Daily Review 校验通过"
```

如果读取 Prompt、调用模型、写临时文件、替换正式文件或最终校验中的任意一步实际失败，必须运行：

```bash
~/AISecretary/.review/review_state.sh YYYY-MM-DD failed "简短、可展示的失败原因"
```

失败消息不要包含原始记录正文、模型密钥或其他敏感信息。`failed` 只代表这一次实际执行失败；不能因为尚未到计划时间、没有原始记录或没有运行状态文件而推断失败。
