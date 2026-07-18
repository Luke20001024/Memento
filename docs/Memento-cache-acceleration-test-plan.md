# Memento Chrome 快速缓存与并发读取 · Lean v1 测试计划

日期：2026-07-17
目标版本：v0.8.8

## 1. 发布目标

验证七件事：

1. 暖启动给可信完整快照 250 ms 的首屏优先窗口；窗口超时后 live 必须独立启动，不取消底层 Cache DB 请求。
2. 每个 Tab 在完整历史锁外直接点读 today，不枚举根目录；新增记录的提交必须早于历史锁协调。
3. 根日报历史扫描最多 4 个真实请求并行，整轮固定 `scanDate`，并复用已点读的 today seed。
4. 共享协调可用时，多标签页只有一个完整历史扫描者；leader 在 Web Lock 内完成扫描、缓存提交和快照发布，follower 仅做锁外 today 点读，不排队、不定时接管全量。
5. Markdown 持久缓存只接受完整扫描；缓存底稿只允许已确认 today 单文件覆盖或删除，且只解锁今天。
6. 照片只在视口附近加载；首次生成的 480 px WebP 可跨 Tab 命中，且必须满足目录 / 文件名 / 规格隔离与 96 项 / 32 MiB / 单项 512 KiB 限额。
7. 错目录、撤权、跨标签页切换、partial 和迟到任务都不能泄露或污染正文或照片缓存。

单元测试使用 deferred / barrier，不用“必须在 N ms 内完成”作为确定性断言。性能目标只在固定 Chrome 与固定 fixture 上记录 p50 / p95。

## 2. 自动化测试

### A. today 直读与 4-worker 历史 reader

- today 直读只对 `${scanDate}.md` 调用 `getFileHandle()`，不调用 `entries()`。
- today 成功返回完整 file record；初始 NotFound 返回 confirmed missing；permission 上抛。
- today 的 `NotReadableError` / `NotFoundError` 重取 child handle 一次；第二次不再重试。
- generation 在 `getFile()` 后失效：不再开始 `arrayBuffer()`，返回 stale。
- 9 个文件：初始只启动 4 个；settle 1 个后只启动第 5 个。
- 枚举顺序混乱：其余日期倒序。枚举到 seeded today 时不二次 `getFile()` / `arrayBuffer()`，但 coverage 和 `onFile` 计数完整。
- 扫描中跨过午夜：排序、today 标记和结果仍使用启动时固定的 `scanDate`。
- 4 个 never-settle：第 5 个永不开始。
- `NotReadableError` / `NotFoundError`：从父目录重新取得 child handle 和新 File 快照，最多读取两次，成功后 complete。
- 重复瞬态失败：形成单文件 issue，不继续重试。
- 普通错误：只调用一次，其他文件继续。
- 枚举中途失败：已发现 handle 全部 settle，coverage 不完整。
- permission fatal：停止 dequeue，等待已启动请求 settle 后抛错。
- 空目录：完整结果。

### B. Web Lock

- 每个 Tab 的 today 点读 / commit 均先于历史锁请求；第一个历史调用是 leader，第二个立即 follower；follower history producer 调用数为 0。
- leader 的完整扫描、token-CAS commit 和 `core-snapshot-committed` 发布全部完成后才释放 core lock。
- 10 个 follower 同时出现：每页只做一次 today 点读，所有 follower history producer 调用数均为 0，也没有排队 core waiter。
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

### D. 照片持久缓存

- key 必须精确包含 binding token、asset filename 和 variant；任一不同都 miss。
- 只接受有效 Blob；单项超 512 KiB 拒绝，写入后按 96 项 / 32 MiB 原子 LRU 淘汰。
- 命中先返回 Blob，`lastAccessedAt` touch 后台 best effort；touch 失败不产生 unhandled rejection。
- 当前 schema 损坏记录为 miss 并异步清理；future schema 为 miss 但保留回滚数据。
- put / LRU / 清理在同一事务中；注入失败全部回滚。
- 第一个 repository 写入后 `clearMemory()` / `pagehide`：新 repository 仍能命中同一 Blob，证明 object URL 回收没有删除持久缓存。
- 持久 miss 才读原图和生成 WebP；hit 不调用原图 loader / thumbnailer。写入是后台任务，不阻塞当前渲染。
- 持久读取在 120 ms 决策窗口内未完成时，立即调用原图 loader；迟到缓存不能阻塞、重复提交或覆盖本次实时结果。
- 缓存身份合同以“正常采集使用唯一、不可变的 asset 文件名”为前提；替换测试使用新文件名并更新 Markdown 引用，不把同名源文件重新校验作为命中路径要求。

### E. 静态合同

- 归档缓存只持久化 `{name,title,mtime}`，并以当前 binding token 做 CAS；切目录、invalidate 和 binding 轮换必须同时删除旧索引。
- 暖启动只开启一个 IndexedDB 只读事务，同时读取 handle、binding、核心快照和归档索引；归档数量必须在侧栏首次绘制前恢复，不得等待打开抽屉、扫描 `.archives` 或再次调用 `readArchiveIndex()`。归档索引损坏、future schema 或 token 不匹配时，核心快照仍须正常命中。
- 同 Tab 再开归档时，已验证内存列表直接显示且不再遍历目录；新 Tab 在 120 ms 内优先显示持久索引，再经过 paint barrier 后后台核对。
- 冷启动枚举出文件名后立即显示列表；标题逐项更新，不等待 `Promise.all`。mtime 未变化的条目不读 HTML 文本；新增或变化条目最多读取 256 KiB 前缀。
- 单个归档读取永久 pending 时，其余两个并发槽仍可推进并显示其他条目；重复开关不叠加新的目录遍历。缓存行点击时只解析并读取该一个文件。

- HTML 在 `dashboard.js` 前加载 cache 与 operations 模块。
- HTML 在 `dashboard.js` 前加载 `photo-cache-library.js`，安装目录也包含该模块。
- manifest / footer / README 都是 v0.8.8。
- 安装目录包含新 cache 模块。
- today 直读必须位于 core history lock 外且早于 `startHistory`；不出现旧硬超时、`Promise.race` 补开、follower timer / polling takeover 或排队 core waiter。
- leader 的 cache commit 与快照发布位于 Web Lock producer 内；快照和发布都包含精确的 token、`committedAt` 和 `scanDate`。
- cache 底稿只接受成功读取的 live today 单文件覆盖，不混入历史 partial，也不覆盖持久 LKG。
- cache 状态下当前显示内容可复制，但必须在按钮和剪贴板中明确标注仍在核对；today 点读成功后，今天升级为 fresh。partial 的周 / 月仍只能作为带状态标注的当前显示版本复制。
- 自动恢复、跨页同步和手动选择使用同一 flow 代次；旧流程不能晚到覆盖目录、UI 或 busy 状态。
- 目录选择广播 `selection-changed`；发送页的旧选择晚到成功时也会自行重读最终 persisted handle。
- 目录选择提交与归档写共用目录写锁；归档在锁内再次读取 persisted handle 并通过 `isSameEntry()` 后才写入或删除。

### F. 首屏启动编排

- 快速 cache hit：首个记录 commit 是 cache，不提交空 waiting；显式 paint barrier 释放前 refresh 调用数为 0。
- cache miss / 解析失败：`waiting → refresh`，不等待不存在的 paint。
- cache hydration 永不 settle：显式 decision barrier 到期后 refresh 只启动一次；底层 hydration 仍可迟到完成。
- 迟到 cache 只用 LKG 补历史，不覆盖 live today；已是 fresh / shared 时不再安装。
- hydration / paint 期间 generation 失效：不提交 waiting，不启动 refresh。
- hydration / paint 期间收到已验证 shared：不被 waiting 覆盖，不重复扫描。
- 新选目录 `cacheFirst=false`：不触碰可能 pending 的旧缓存，直接 `waiting → refresh`。
- 已有 cache：`cache commit → paint → today read → today commit → history lock`，任一历史 deferred 都不能阻塞 today commit。
- today 点读期间 generation 失效：不 commit、不启动 history。permission 失败上抛且不启动 history。

关键新回归测试：

```bash
node tests/test_dashboard_operations_library.js
node tests/test_today_first_refresh.js
node tests/test_photo_asset_loader.js
node tests/test_photo_viewport_loader.js
node tests/test_photo_persistent_cache.js
bash tests/test_record_dashboard.sh
bash tests/test_photo_drawer.sh
```

## 3. 真实 Chrome 场景

使用 22 个无敏感内容的 dummy 日报；不要在真实日记上注入故障。

### C01 冷启动

- 清除扩展站点数据并授权 dummy Vault。
- 页面立即离开“首次授权卡片”，显示中性核对状态。
- today 直读完成后先显示今天并开放“今天”复制；历史仍在后台。
- 完整后周 / 月复制开放并写入快照。

### C02 暖启动

- 关闭并重新打开新标签。
- 权限 granted 后先显示上次完整记录，并标明正在核对。
- 缓存刚显示时复制禁用；锁外 today 点读成功后只替换缓存中的今天并只开放今天复制。
- 在今天的 dummy Markdown 追加一条记录后 reload：新记录必须在历史 leader 完成前出现。
- 历史 partial 不混入缓存底稿；核对完整后状态切 fresh，周 / 月复制开放。
- 记录 permission granted → cache 首屏、fresh 完整展示的 p50 / p95。

### C03 单请求永久 pending

- dummy handle 将一个文件的 `arrayBuffer()` 保持 pending。
- 证明并行上界为 4；另外 3 路继续。
- 历史文件 pending：有缓存时保留完整缓存，today 成功后只覆盖今天并只解锁今天。
- today 直读 pending：显示 LKG，今天不可静默复制，且当前 Tab 不与自己的历史池并发争抢。
- 第 5 个任务只有真实槽释放后才开始。

### C04 多标签页

- 标签 A 持 leader lock，标签 B 打开。
- B 先做一次锁外 today 点读并 commit；随后不调用完整历史 reader，也没有定时接管。
- A 在锁内完成完整提交与发布后，B 从 IndexedDB 重读，精确匹配 token、`committedAt`、`scanDate` 并切 shared。
- 消息载荷不包含 Markdown。
- 10 个 B 类 follower 各点读 today 一次，都不调用 history producer，也不排队 core lock。
- A 正常发布：B 只从 IndexedDB 重读精确快照并切 shared。
- A 不完整、抛错、关闭、renderer crash、广播丢失或安装失败：B 保留自己点读的 today + LKG 历史，不自动全量 reader。
- A 永久 pending：B 不调用 history reader，但 today 仍可由 B 单文件刷新。

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
- 证明 250 ms 首屏窗口结束后 live 仍启动并可完成，且不重复启动。
- pending 后迟到的 cache 在显示前重新核对权限；若 live 已是 fresh / shared 则不覆盖。
- 缓存写失败只影响下次快速启动，不撤销当前 fresh 页面。

### C07 跨午夜

- 23:59 启动扫描，过程中把测试时钟推进到次日。
- 本轮排序、today 标记、复制门禁和共享发布始终使用启动时 `scanDate`。
- 下次刷新才采用新日期；旧轮发布不能被新轮误认。

### C08 照片跨 Tab 缓存

- 清除 `memento-photo-thumbnails`，打开每日总结并把首张照片滚入预读边界：首次需读原图、生成 480 px WebP，文字卡始终先可见。
- 关闭新标签并打开另一个 Tab：同一目录 / 文件名 / variant 直接命中 Blob，不读原图、不调用 thumbnailer。
- 切换目录或更改 variant：必须 miss 并生成新衍生图，不展示旧目录 / 旧规格 Blob。
- 关闭页面后检查 object URL 已回收，但新 repository 仍能命中持久 Blob。
- 让 IndexedDB get 超过 120 ms 才返回：页面应立即回退读取原图，迟到命中不能覆盖或重复显示。
- 替换图片时使用新 asset 文件名并更新 Markdown 引用，新 key 必须 miss；不以同名原位替换验证缓存失效。
- 写入 97 项或超过 32 MiB：最旧 LRU 被原子淘汰；单项超 512 KiB 不写入。

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
- 冷 / 暖、单 pending、多标签、切目录 / denied、Cache DB、跨午夜和照片跨 Tab 场景通过。
- 每个 Tab 的锁外 today 请求 settle 后才开始该 Tab 的历史协调；每个 history leader 最多 4 个核心 FSA 请求。
- leader 在 cache commit / 快照发布完成前不释放 core lock；follower 不排队、不因 timer / polling 发起全量 FSA，但保留一次 today 点读。
- 整轮 `scanDate` 固定，跨午夜不改变 today 语义。
- partial 不覆盖 LKG；缓存底稿只允许 today overlay，且不能解锁周 / 月。
- 照片持久缓存不包含原图，精确按 binding / asset / variant 隔离，读取超过 120 ms 必须 fail-open 到实时原图，并遵守 96 项 / 32 MiB / 单项 512 KiB 上限。
- 旧 token invalidate 是 no-op；错 token / 错 handle 从未显示。
- cache 未核对时无法静默复制，copy 时目录 `isSameEntry()` 不匹配必定阻止。
- 已安装 `.chrome-newtab` 与源码一致。
- 发布 ZIP 从确定 commit 生成，版本、目录前缀和 SHA-256 校验通过。
