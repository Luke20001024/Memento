# Pre-Mortem：Memento Chrome Lean v1 加速

日期：2026-07-17

假设 v0.8.7 发布后失败，最可能不是“4 路不够快”，而是缓存、权限和异步任务之间的边界错误。

## Tigers

### T1：显示了另一个目录的缓存

- 场景：新版建立 A 的 binding；回滚 v0.8.6 后用户重选 B，旧版只更新 `dir`。
- 后果：严重隐私错误。
- 防护：当前 handle 同时比较 stored `dir` 与 `binding.boundHandle`；任一不一致 cache miss，并用 CAS 换 binding / 删除 snapshot。目录选择后广播 `selection-changed`，复制前再读取 persisted handle 并做 `isSameEntry()`。
- 发布门槛：A→旧版→B→新版往返测试通过；旧标签页不能显示或复制 A。

### T2：切目录或撤权后旧扫描复活正文

- 场景：A 扫描 pending，用户选 B 或 denied；A 晚到后写缓存，或旧页的迟到错误使 B 失效。
- 防护：选择目录原子轮换 token；invalidate 必须携带调用方 `expectedToken`，事务内 token 不同就 no-op；commit 也做 token-CAS，DOM 另有 generation gate。
- 发布门槛：旧 token 的页面提交、持久提交和 invalidate 都失败，B 的 token / snapshot 不变。

### T3：缓存校验自己把 live 卡住

- 场景：IndexedDB 或 `isSameEntry()` 永久 pending。
- 防护：cache context 与 `scheduleCoreRefresh()` 并列启动，live 不 await cache；缓存失败只 console warning。
- 发布门槛：pending cache fake 下 live 完整。

### T4：partial 覆盖完整缓存

- 场景：20 个文件成功、1 个失败，仍把 20 个写成新“完整”快照。
- 防护：`coverage.complete && !issue && issues.length===0`；持久缓存不接受 partial。唯一例外是缓存底稿可在内存中用成功读取的 live today 覆盖同名文件，历史 partial 不混入且 LKG 不改变。
- 发布门槛：所有不完整组合都保留旧 snapshot；history pending 时只允许 today overlay。

### T5：缓存内容被当成最新并复制

- 场景：暖启动一显示就复制，漏掉 Obsidian / Memento 刚写的新内容。
- 防护：旧 cache 禁用复制；live today overlay 只开放今天；fresh / 同轮 shared 才开放周、月。每次复制前再次比较页面 handle 与 persisted handle 的 `isSameEntry()`。
- 发布门槛：缓存首屏复制无输出，today overlay 不能复制周 / 月，目录不一致时所有复制都拒绝。

### T6：为了恢复速度无限增加 Chrome 请求

- 场景：watchdog 超时后补开读取，旧 Promise 仍 pending，请求数持续增长。
- 防护：无硬取消、无 `Promise.race` 补开；一个 worker 真实 settle 才领下一项；leader 上界固定 4。follower 使用 `ifAvailable` 立即返回，不排队、不自动接管。
- 发布门槛：4 个 never-settle 时第 5 个永不开始；无论等待、锁释放或测试时钟如何变化，10 个 follower 的 producer 调用数都为 0。

### T7：锁先释放，缓存和广播后完成

- 场景：leader 过早释放 Web Lock；用户随后新开或刷新 Memento 页面，新页面取得锁并扫描；旧 leader 又迟到提交缓存或广播，形成重复扫描和乱序发布。
- 防护：扫描、完整快照 token-CAS commit 和 `core-snapshot-committed` 发布都在同一个 core lock callback 内完成；快照与发布都带 token、`committedAt`、`scanDate`，接收方精确匹配后再采用。
- 发布门槛：barrier 测试证明 commit / broadcast 未完成时第二个 producer 永远不能进入。

### T8：扫描跨午夜后“今天”漂移

- 场景：23:59 开始，读取过程中日期变化；排序、today copy gate 与共享结果使用了不同日期。
- 防护：页面启动时只计算一次 `scanDate`，本轮 reader、解析、复制门禁和发布都使用它。
- 发布门槛：跨午夜 fake clock 下本轮语义不变，下次刷新才进入新日期。

### T9：切目录时旧页仍写归档

- 场景：页面 A 还显示旧目录，页面 B 已把新目录提交到 IndexedDB，但 `selection-changed` 广播尚未送达；A 恰好保存或删除归档。
- 防护：目录选择持久化惰性地从既有目录写锁内启动；归档保存 / 删除取得同一锁后重读 persisted `dir` 并做 `isSameEntry()`，不匹配就取消并同步页面。三个选目录入口另共享单一 flow 代次，旧恢复不能覆盖新 UI。
- 发布门槛：barrier 测试 / 接线合同证明选择与归档互斥，归档身份检查严格发生在锁内、第一次目录写之前。

## Paper Tigers

### P1：必须先做增量缓存

22 个文件只有几十 KB。当前瓶颈是 Chrome 调用串行与偶发 pending，不是字节量。完整快照 + 4 路已经解决主要收益，增量索引先不做。

### P2：必须自动抢救永久挂起的 leader

租约 / heartbeat 无法取消底层 FSA，只会让 follower 再开一组请求。Lean v1 明确不做自动 takeover：leader 未发布完整结果时保留缓存 / partial，提示关闭其他 Memento 页面后手动刷新。这个低频手动动作换来更小、更可证明、也更容易迭代的协调层。

### P3：Obsidian 必须被关闭

高置信度不是根因：现场文件是健康的本机普通文件；10:14 同类失败发生在 Obsidian 完全退出约 63 分钟后；Obsidian 接入提交也没有改 Dashboard reader。早期异常时它曾活跃并随后崩溃，所以只把外部改写视为可能的瞬态 File 快照失效，不要求用户关闭 Obsidian。

## Elephants

### E1：缓存是 Markdown 正文的本机副本

必须在 README 明示范围、5 MiB 上限和清除方式。未 granted 不显示；denied / 切目录失效。不能把“扩展不联网”误写成“没有额外数据副本”。

### E2：Chrome 版本 / 企业 Profile 仍可能有实现问题

前三次现场异常都出现在显示器唤醒后不久，更应验证睡眠唤醒后的 File System Access handle / permission 恢复和企业 Profile。Chrome 150.0.7871.127 更新晚于最初两次异常，也不能直接定性。用 dummy Vault 对比“唤醒后沿用当前 Profile”“完全退出 Chrome 后重开”和临时 Profile / Canary；不为了测试降级主浏览器。架构必须在底层偶发 pending 时仍有请求上界和可用 UI。

### E3：实现体积可能反噬迭代速度

约束：只保留一个 cache 模块、一个 reader / lock 模块和 Dashboard 状态接线；不再加入第二 DB、broker、outbox、租约或多版本 cache。数据安全继续由 token、coverage、generation 与固定 `scanDate` 表达；跨页只保留一把非排队 core lock。

## 发布前停线条件

出现任一情况必须停止发布：

- 错 handle / token 的缓存曾进入 parser 或 DOM。
- denied 后缓存仍可见或可复制。
- partial 覆盖完整 snapshot。
- 缓存底稿混入历史 partial，或 today overlay 解锁了周 / 月。
- 共享模式全局核心 FSA in-flight 超过 4，或降级模式单页超过 4。
- follower 因 timer / polling 发起 FSA。
- follower 排队 core lock，或在没有用户刷新时自动发起 producer。
- 过期或旧 generation 的 follower 更新当前页面。
- leader 在 cache commit / broadcast 完成前释放 Web Lock。
- 跨午夜时本轮 `scanDate` 发生变化。
- stale `expectedToken` invalidate 轮换或删除了当前目录数据。
- 复制未通过当前 persisted handle 的 `isSameEntry()`。
- 归档写入或删除未在共享目录写锁内核对 persisted handle。
- 旧 generation 更新当前页面。
- 安装副本、ZIP 或 README 版本与源码不一致。
