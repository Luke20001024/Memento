# Memento

> Memento 不是另一个笔记 App，而是一层覆盖 macOS 当前窗口的个人 Context 记录层。

Memento 以 **AI friendly、轻量本地化、0 摩擦和模块化**为产品哲学，把搜索、聊天、文档、屏幕和声音里的即时想法，在原场景保存为本地、可追溯、可被 AI 回看的个人事实。

[打开可操作产品逻辑页](docs/product-logic.standalone.html)

## 为什么存在

### 意图在每个窗口发生

搜索框里的问题、聊天中的表达、文档与代码里的判断、屏幕上正在关注的内容，以及随口说出的想法，都在暴露一个人此刻想理解、表达、判断或继续做什么。问题不是缺少输入框，而是这些意图分散、易逝，还没有成为同一个人的连续 Context。

### 在原场景留下证据

Memento 不要求切到另一个 App 重新复述，也不持续监听所有窗口。用户在意图发生处主动触发记录，通过文字、备注、标签、截图与 OCR、语音和每日第一帧保留表达与现场。多模态不是为了扩大监控范围，而是为了用更低摩擦保存更完整的证据。

### 事实先沉淀，理解再发生

不同入口的记录汇入同一个本地事实层，保留时间、来源和原始资产。AI Review 在事实之上提出可核对、可删除、可重建的解释；用户拥有原始事实，并保留补充与修正 AI 理解的权利。

## 产品哲学

Memento 用四条原则约束同一件事：让个人 Context 对 AI 可理解、对用户可掌控，并且在日常工作里足够轻。

| 原则 | 产品约束 |
|---|---|
| **AI friendly** | 让事实可读，也让理解可校准。记录保留开放文本、时间、来源与原始资产；事实、AI 解释和用户反馈彼此分层，能够持续读取、引用与重建。 |
| **轻量本地化** | 原始事实先属于用户。系统优先使用 macOS 原生能力、本地 Markdown 与原始文件，不要求账号或常驻云端；联网只发生在用户明确启用的能力上。 |
| **0 摩擦** | 0 摩擦不等于 0 确认。不要求离开当前窗口、切换 App 或重新复述；一次主动触发完成记录，同时保留必要的授权与控制。 |
| **模块化** | 采集、事实、Review、回看与反馈彼此解耦。文字、截图、语音和每日第一帧可以按条件启用；单个模块停用或替换，不影响已有事实。 |

四条原则形成一条约束链：以接近 0 摩擦的方式留下 AI friendly 的 Context，以轻量本地化守住数据边界，再用模块化持续扩展能力。

## 当前产品闭环

`原窗口主动记录 → 本地按日事实 → Daily Review → 每日总结回看`

1. **记录**：不离开当前 App，通过 macOS Service 留下文字、截图或语音。
2. **落档**：正文进入按日 Markdown，截图、照片和录音保留原件。
3. **在场**：当天第一次真实记录后，可主动拍下一张“每日第一帧”，补充一次时间与天气。
4. **理解**：启用后，Codex 基于目标日文本生成 Daily Review，不改写原始记录。
5. **回看**：Obsidian 负责检索与编辑；Chrome 新标签页负责轻量浏览、复制给 AI 和进入每日总结。

当前已经形成**记录闭环**：内容能留下、找到、整理并回看。下一步要补的是**理解闭环**：让“准确 / 有误读 / 值得记住 / 补充 Context”被独立保存，并真正影响后续 Review。

## 产品由两层组成

### 记录层

基础安装提供 4 个 macOS Service；语音在系统与本地编译条件满足时成为第 5 个。

| 能力 | 触发与结果 |
|---|---|
| 直接记录 | 选中文字后原样写入当天 Markdown，并保留时间、星期和来源 App |
| 加备注 | 正文与用户补充的判断一起保存；取消则不写入 |
| 选标签 | 使用“行动线索 / 灵感 / 下次再读”帮助检索，没有完成态、优先级或催办 |
| 截图 | 调起系统选区；保存原始 PNG，OCR 超过阈值时同时写入可检索文本 |
| 语音 | 用户主动开始与停止；保留原始 M4A，并尝试 Apple 本地转写；要求 macOS 26 或更高版本 |

当前这台 Mac 的绑定为 `⌃1` 至 `⌃5`。安装器不会替其他设备设置系统快捷键。

### 回看层

- **Obsidian**：`Memento.md` 是首页，原始 Markdown 可继续搜索、关联与编辑。
- **Chrome 新标签页**：让今天的记录在任务切换的自然间隙出现，不再增加一个需要记住的新入口。
- **每日总结**：以所有有原始记录的日期为底表，组合每日第一帧、Daily Review 与处理状态。
- **HTML 归档**：可把 AI 生成的单文件 HTML 手动放入归档抽屉；当前仍是半自动流程。

每日总结状态：

| 状态 | 含义 |
|---|---|
| 待总结 | 有原始记录，但还没有可用 Review，或本轮正在生成 |
| 总结已更新 | Review 与当前原始记录一致 |
| 记录有更新 | Review 生成后，原始记录又发生变化 |
| 生成失败 | 一次真实生成、写入或校验已经开始，并实际失败 |

没有状态文件、还没到运行时间或当天没有记录，都不等于生成失败。

## 每日第一帧

每日第一帧不是为了多保存一张照片，而是让记录里留下“正在生活和判断的我”。文字说明发生了什么，照片把抽象日期重新连接到具体的人、状态和时刻，让时间线从资料库变成一个人持续生活的痕迹。

它是一项独立的在场感能力：

- 仅在当天第一次记录真实落盘后邀请一次。
- 用户可以拍摄或跳过，当天不重复打扰。
- 只有照片成功后才补充一次拍摄时间与天气。
- 照片保存在本地；当前 Daily Review 不直接理解照片。

## 产品边界

- **不是另一个输入 App**：入口仍属于搜索、聊天、文档和当前窗口，Memento 只负责跨入口承接。
- **不是后台监控系统**：记录由用户主动触发或明确授权，不持续开启摄像头、麦克风或屏幕。
- **不是待办清理器**：行动线索可以被记录，但记录本身就是价值，不制造“未完成”压力。
- **不是隐藏的人格判断**：AI Review 是可核对的派生解释，不做人脸识别，也不根据单张照片推断情绪、健康或动机。

隐私边界：

- 每日记录、Dashboard、语音转写和原始资产保存在本地。
- Dashboard 核心功能不主动联网；用户导入的 HTML 归档可能按自身内容加载远程字体或资源。
- 启用 Daily Review 时，目标日文本会交给已配置的 Codex 模型。
- 照片成功后才向 Open-Meteo 查询一次天气；位置先降到约 11 km 粒度，经纬度不落盘。

## 快速开始

要求：macOS。截图 OCR 与每日第一帧需要可用的 `swiftc`；语音还要求 macOS 26 或更高版本。

```bash
chmod +x install_aisecretary.sh uninstall_aisecretary.sh
./install_aisecretary.sh
```

安装后：

1. 在“系统设置 → 键盘 → 键盘快捷键 → 服务”中绑定需要的 Service。
2. Chrome 打开 `chrome://extensions`，启用开发者模式，加载 `~/AISecretary/.chrome-newtab/`。
3. 打开新标签页，授权数据目录 `~/AISecretary`。

```bash
./uninstall_aisecretary.sh
```

卸载默认不删除记录。产品名是 **Memento**；为兼容既有数据，内部目录、脚本和 Workflow 仍保留技术名 `AISecretary`。

---

## 面向 Codex / AI

### 阅读顺序

1. 本 README：产品语义、边界与已实现能力。
2. [`daily-review/DAILY_REVIEW.md`](daily-review/DAILY_REVIEW.md)：Daily Review 唯一机器执行协议。
3. [`daily-review/README.md`](daily-review/README.md)：状态查看、手动运行与排障。
4. [`chrome-newtab/README.md`](chrome-newtab/README.md)：Dashboard 和交互约定。
5. [`chrome-newtab/prompts.js`](chrome-newtab/prompts.js)：实际 Prompt 源；Daily Review 使用 `id: 'comprehensive'`。

不要复制第二份完整 Review Prompt。协议和 Prompt 必须各自只有一个事实源。

### 不可违反的约束

- 不修改原始 `YYYY-MM-DD.md`；安装升级只能补兼容元数据，不能重写正文。
- 单日 Review 只读取目标日记录、`comprehensive` Prompt，以及旧 Review 中的 `## 我的补充`。
- 不读取其他日期补事实，不联网补背景，不生成跨日观察。
- 不把模糊表达强制转成任务，不补 deadline、人名、优先级或项目背景。
- `## 我的补充` 必须原样保留。
- 先写临时文件，校验通过后原子替换正式 Review。
- 只有真实开始生成后才能写 `pending`；只有真实运行失败才能写 `failed`。
- 只有原始内容持久化成功，记录入口才可以通知成功并触发每日第一帧。

### 数据与状态契约

| 路径 | 角色 |
|---|---|
| `~/AISecretary/YYYY-MM-DD.md` | 原始事实层 |
| `~/AISecretary/assets/` | 截图、照片与录音原件 |
| `~/AISecretary/Reviews/Daily/YYYY-MM-DD.md` | 可重建的日级 AI Review |
| `~/AISecretary/.review/status/YYYY-MM-DD.json` | 最近一次真实 Review 执行状态 |
| `~/AISecretary/.chrome-newtab/` | 已安装 Dashboard |
| `~/AISecretary/.archives/` | 用户主动放入的 HTML 归档 |

Review 是否存在与 `source_hash` 判断“未生成 / 最新 / 记录有更新”；状态 JSON 只表达最近一次真实执行的 `pending / success / failed`。状态缺失不能推断失败。

### Daily Review 入口

```bash
# 上午：只复核昨天
~/AISecretary/.review/review_cycle.sh previous

# 晚间：按“昨天 → 今天”检查
~/AISecretary/.review/review_cycle.sh

# 状态与结果校验
~/AISecretary/.review/review_status.sh today
~/AISecretary/.review/verify_review.sh YYYY-MM-DD
```

`review_cycle.sh` 只做确定性检查，不调用模型。安装器会铺设 Review 协议，但不会替新机器创建 Codex 自动任务；08:00 与 21:00 调度需要单独配置。

### 修改后的最低验证

```bash
node tests/test_daily_summary_library.js
node tests/test_photo_library.js
bash tests/test_daily_review_recovery.sh
bash tests/test_daily_snapshot.sh
bash tests/test_photo_drawer.sh
bash tests/test_record_dashboard.sh
```

修改安装器后，还要确认源码与 `~/AISecretary/.scripts/`、`.review/`、`.chrome-newtab/` 中的已安装副本一致。

## 现状与后续

### 已知限制

- 自动循环只检查昨天与今天，不会批量回填更早历史记录。
- Dashboard 在页面加载时读取文件，没有实时文件监听；新 Review 生成后需要刷新。
- 每日第一帧失败、跳过或权限拒绝后当天不重试。
- 语音依赖 macOS 26、`swiftc` 与打包源码，部分非原生 App 不支持从 Services 菜单启动。
- HTML 归档仍需“复制给 AI → 保存 HTML → 手动放入归档库”。
- 当前没有多设备同步、原生多模态 Review 或反馈学习。

### TODO

近期先补逻辑漏洞：

- 完成 08:00 晨间复核的真实定时验证，并支持扫描最近 N 天的漏跑记录。
- 增加 Dashboard 手动刷新，或明确提示重新加载后读取最新文件。
- 为 Daily Review 增加“准确 / 有误读 / 值得记住 / 补充 Context”。
- 将用户反馈与 AI 结果分开保存，支持查看、撤回与删除，并让确认 Context 参与后续 Review。

后续体验：

- 支持照片原比例全屏、键盘切换与多端自适应。
- 增加连续 30 天横向照片时间线，并回到当天原始记录。
- 结合照片、天气、记录和 Review 生成可校准的月度反思。
- 将 HTML 生成与归档升级为可确认的一键流程。

### 最近改动 · 2026-07-14

- 重构产品叙事为“为什么 → 记录 → 回看 → 理解 → 架构 → 闭环 → 方向”。
- 为 5 个 Service 增加可操作微型演示，并明确语音的条件启用边界。
- 将每日第一帧并入记录后的在场感能力，补充触发、天气与打扰边界。
- Service 入口与产品演示使用“行动线索”；数据层继续兼容历史 `#TODO`，但已移除勾选、完成和催办语义。
- 区分当前已成立的记录闭环与尚未成立的理解闭环。
