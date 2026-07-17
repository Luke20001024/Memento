# Memento Chrome 快速缓存与并发读取 · Lean v1 测试计划

日期：2026-07-17
目标版本：v0.8.7

## 1. 发布目标

验证五件事：

1. 暖启动先显示可信完整快照，实时读取不等待 Cache DB。
2. 根日报最多 4 个真实请求并行，整轮固定 `scanDate` 且今天优先。
3. 共享协调可用时，多标签页只有一个核心扫描者；leader 在 Web Lock 内完成扫描、缓存提交和快照发布，follower 不排队、不定时接管。
4. 持久缓存只接受完整扫描；缓存底稿只允许 live today 单文件覆盖，且只解锁今天。
5. 错目录、撤权、跨标签页切换、partial 和迟到任务都不能泄露或污染正文。

单元测试使用 deferred / barrier，不用“必须在 N ms 内完成”作为确定性断言。性能目标只在固定 Chrome 与固定 fixture 上记录 p50 / p95。

## 2. 自动化测试

### A. 4-worker reader

- 9 个文件：初始只启动 4 个；settle 1 个后只启动第 5 个。
- 枚举顺序混乱：今天第一个领取，其余日期倒序。
- 扫描中跨过午夜：排序、today 标记和结果仍使用启动时固定的 `scanDate`。
- 4 个 never-settle：第 5 个永不开始。
- `NotReadableError` / `NotFoundError`：从父目录重新取得 child handle 和新 File 快照，最多读取两次，成功后 complete。
- 重复瞬态失败：形成单文件 issue，不继续重试。
- 普通错误：只调用一次，其他文件继续。
- 枚举中途失败：已发现 handle 全部 settle，coverage 不完整。
- permission fatal：停止 dequeue，等待已启动请求 settle 后抛错。
- 空目录：完整结果。

### B. Web Lock

- 第一个调用是 leader，第二个立即 follower；follower producer 调用数为 0。
- leader 的完整扫描、token-CAS commit 和 `core-snapshot-committed` 发布全部完成后才释放 core lock。
- 10 个 follower 同时出现：所有 follower producer 调用数均为 0，也没有排队 core waiter。
- leader 释放、失败、测试时钟前进或 timer 触发后，旧 follower 仍不自动调用 producer。
- leader 成功发布：follower 只重读并精确安装同 binding、`committedAt`、`scanDate` 的快照。
- leader 关闭 / crash、广播丢失或安装失败：follower 保留 cache / waiting；用户刷新后才发起新一轮探测。
- Web Locks 缺失：local producer 只运行一次。
- BroadcastChannel 缺失：不启用共享 core lock，本页 local producer 一次且不写共享快照。
- 初始 lock callback 前失败：local 一次；callback 进入后不在同一调用内补跑。

### C. Cache codec 与事务

- 原始 bytes 编码 / 解码一致；空目录可缓存。
- `coverage.complete !== true`、issue 或 issues 均拒绝写入。
- 非法文件名、重复文件、mtime、计数、总大小、5 MiB 超限均 cache miss。
- 选择目录单事务：`dir + binding` 同时更新，旧 snapshot 删除；注入中途失败时全部回滚。
- `prepareSelection` 不提前开启事务；`startPersistence()` 惰性且幂等，才能让目录选择事务真正从共享写锁内开始。
- invalidate 必须携带有效 `expectedToken`；当前 token 相同时才轮换 token 并删除 snapshot。
- 旧 token 的迟到 invalidate 是 no-op，不能轮换或删除新目录的 binding / snapshot。
- 旧 token 的迟到 commit 失败。
- 当前 token 完整 commit 成功。
- v0.8.6 只有 `dir` 时创建 binding。
- v0.8.6 回滚后只更换 `dir`：旧 snapshot 不展示。
- 当前 handle、stored handle、bound handle 任一不相同 / 抛错 / pending：缓存 fail-closed，live 不依赖它。
- 未来 schema 不展示，也不被旧 reader 覆盖。

### D. 静态合同

- HTML 在 `dashboard.js` 前加载 cache 与 operations 模块。
- manifest / footer / README 都是 v0.8.7。
- 安装目录包含新 cache 模块。
- 不出现旧硬超时、`Promise.race` 补开、follower timer / polling takeover 或排队 core waiter。
- leader 的 cache commit 与快照发布位于 Web Lock producer 内；快照和发布都包含精确的 token、`committedAt` 和 `scanDate`。
- cache 底稿只接受成功读取的 live today 单文件覆盖，不混入历史 partial，也不覆盖持久 LKG。
- cache 状态下全部复制禁用；today overlay 只开放今天；fresh / shared 才开放周、月。
- 自动恢复、跨页同步和手动选择使用同一 flow 代次；旧流程不能晚到覆盖目录、UI 或 busy 状态。
- 目录选择广播 `selection-changed`；发送页的旧选择晚到成功时也会自行重读最终 persisted handle。
- 目录选择提交与归档写共用目录写锁；归档在锁内再次读取 persisted handle 并通过 `isSameEntry()` 后才写入或删除。

## 3. 真实 Chrome 场景

使用 22 个无敏感内容的 dummy 日报；不要在真实日记上注入故障。

### C01 冷启动

- 清除扩展站点数据并授权 dummy Vault。
- 页面立即离开“首次授权卡片”，显示中性核对状态。
- 文件完成后渐进显示；今天成功后“今天”可复制。
- 完整后周 / 月复制开放并写入快照。

### C02 暖启动

- 关闭并重新打开新标签。
- 权限 granted 后先显示上次完整记录，并标明正在核对。
- 缓存刚显示时复制禁用；live today 成功后只替换缓存中的今天并只开放今天复制。
- 历史 partial 不混入缓存底稿；核对完整后状态切 fresh，周 / 月复制开放。
- 记录 permission granted → cache 首屏、fresh 完整展示的 p50 / p95。

### C03 单请求永久 pending

- dummy handle 将一个文件的 `arrayBuffer()` 保持 pending。
- 证明并行上界为 4；另外 3 路继续。
- 历史文件 pending：有缓存时保留完整缓存，today 成功后只覆盖今天并只解锁今天。
- today 文件 pending：今天不可复制；无缓存时只显示其他成功 partial。
- 第 5 个任务只有真实槽释放后才开始。

### C04 多标签页

- 标签 A 持 leader lock，标签 B 打开。
- B 不调用根日报 reader，也没有定时接管，先显示缓存或 waiting。
- A 在锁内完成完整提交与发布后，B 从 IndexedDB 重读，精确匹配 token、`committedAt`、`scanDate` 并切 shared。
- 消息载荷不包含 Markdown。
- 10 个 B 类 follower 都不调用 reader，也不排队 core lock。
- A 正常发布：B 只从 IndexedDB 重读精确快照并切 shared。
- A 不完整、抛错、关闭、renderer crash、广播丢失或安装失败：B 保持 cache / waiting，不自动 reader；关闭其他页面后由用户刷新再探测。
- A 永久 pending：B 不调用 reader，物理 FSA 仍最多 4。

### C05 目录切换与撤权

- A 扫描未结束时选择目录 B；`selection-changed` 使旧页 generation 失效，A 迟到结果不能更新 DOM / snapshot。
- 保存目录 B 的 UI watchdog 先超时、底层 IndexedDB 随后成功：其他页面仍收到一次 `selection-changed` 并立即隔离旧目录。
- 自动恢复或旧 picker 在 B 之后才返回：flow 代次拒绝其 DOM / UI 更新；若旧 picker 的事务最终成为 persisted winner，发送页主动重读并与最终结果一致。
- 在旧页点击复制：重新读取 persisted handle，`isSameEntry()` 不匹配时拒绝复制。
- 旧页归档保存 / 删除与 B 的选择事务并发：共享写锁内重读 handle，不匹配时取消操作，不能写入或删除旧目录。
- 旧目录页面用旧 token invalidate：必须 no-op，不能删除 B 的 snapshot。
- Chrome 权限改为 denied：正文立即隐藏；只有当前 token 的 invalidate 才轮换 binding 并删除 snapshot。
- permission=prompt：缓存不展示，只请求再次确认。

### C06 Cache DB 故障

- 让 `readBootstrap`、`resolveBootstrap` 或 `isSameEntry` 永久 pending。
- 证明 live 仍启动并可完成。
- 缓存写失败只影响下次快速启动，不撤销当前 fresh 页面。

### C07 跨午夜

- 23:59 启动扫描，过程中把测试时钟推进到次日。
- 本轮排序、today 标记、复制门禁和共享发布始终使用启动时 `scanDate`。
- 下次刷新才采用新日期；旧轮发布不能被新轮误认。

## 4. Obsidian / Chrome A-B

定位结论（不作为发布阻塞）：Obsidian 高置信度不是根因。`2026-05-12.md` 是健康的本机普通文件；10:14 的同类失败发生在 Obsidian 完全退出约 63 分钟后。早期一次异常与 Obsidian 活跃 / 随后崩溃相关，只能说明外部改写可能制造瞬态快照失效，不能解释持续 pending。

### O01 外部原子改写

- 脚本每 20–50 ms 用 `tmp + mv` 替换一个 dummy 日报。
- 预期偶发 `NotReadableError` / `NotFoundError` 时只重取一次；不整轮重扫。
- 若出现永久 pending，记录阶段属于 `getFile` 还是 `arrayBuffer`。

### O02 Obsidian 状态

同一 dummy Vault 各运行 20 轮：

1. Obsidian 完全退出。
2. Obsidian 打开但空闲。
3. Obsidian 持续编辑 today 文件。
4. 仅在实际配置 Sync 时，再测试 Sync 下载。

只记录 `{scanId, name, phase, duration, errorName, lastModified, size}`，不记录正文。

### O03 睡眠唤醒 / Chrome build / Profile

- 前三次现场异常都出现在显示器唤醒后不久；对比“唤醒后沿用当前 Profile”与“完全退出 Chrome 后重开”。
- 当前 150.0.7871.127 临时 Profile。
- 可安全取得时，对比 Canary 或独立旧 build；不降级主浏览器。
- Chrome 150 更新晚于最初两次异常，不能把初始问题直接归因于该更新。
- 改变 dummy 文件创建顺序，判断故障跟随文件还是跟随第 N 个请求。

## 5. 发布门槛

- 自动化全绿，`git diff --check` 通过。
- 冷 / 暖、单 pending、多标签、切目录 / denied、Cache DB、跨午夜场景通过。
- 任意时刻每个 leader 最多 4 个核心 FSA 请求。
- leader 在 cache commit / 快照发布完成前不释放 core lock；follower 不排队、不因 timer / polling 发起 FSA。
- 整轮 `scanDate` 固定，跨午夜不改变 today 语义。
- partial 不覆盖 LKG；缓存底稿只允许 today overlay，且不能解锁周 / 月。
- 旧 token invalidate 是 no-op；错 token / 错 handle 从未显示。
- cache 未核对时无法静默复制，copy 时目录 `isSameEntry()` 不匹配必定阻止。
- 已安装 `.chrome-newtab` 与源码一致。
- 发布 ZIP 从确定 commit 生成，版本、目录前缀和 SHA-256 校验通过。
