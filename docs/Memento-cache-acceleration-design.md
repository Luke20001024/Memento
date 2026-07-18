# Memento Chrome 快速缓存与并发读取 · Lean v1

日期：2026-07-17
实现版本：v0.8.8

## 1. 结论

Lean v1 只解决一个问题：Chrome 某次本地文件调用很慢或永久 pending 时，新标签页仍能尽快可用，并且不能展示错目录、污染完整缓存或静默复制旧数据。

实现由七个约束组成：

1. 授权通过后，250 ms 快速窗口内命中的 last-known-good 完整快照必须先提交并获得一次绘制机会，根目录遍历才能开始；窗口超时只放行 live，不取消底层缓存请求。
2. 每个 Tab 在完整历史锁外直接点读本轮固定的 `${scanDate}.md`，不先枚举根目录；今天完成后立即覆盖缓存视图。
3. 今日点读完成后再协调完整历史扫描；leader 固定 4 路读取，并把预读 today 作为 seed，枚举到同名文件时不二次打开。
4. 共享协调可用时，同一扩展 origin 同时只有一个标签页执行完整历史扫描；leader 在锁内完成缓存提交和快照发布后才释放锁，follower 不自动补开全量扫描。
5. 只有完整扫描能覆盖持久 Markdown 缓存；缓存底稿只允许当前轮已确认的 today 单文件覆盖或删除。
6. 照片仍按视口懒加载；首次把原图转换为约 480 px WebP，合格衍生图写入独立本机 IndexedDB，后续 Tab 直接复用。
7. 目录切换、失效、复制、照片缓存和归档写入都重新核对目录身份，旧标签页不能影响新目录。

除独立的照片缩略图数据库外，不引入 outbox、租约、heartbeat、根日报分文件增量索引、多版本正文或定时刷新。

## 2. 问题定位

旧链路是严格串行：

```text
iterator.next → getFile → arrayBuffer → 下一个文件
```

任意一个不可取消的 Chrome Promise 不返回，后续文件全部无法开始；Dashboard 又要等待整轮结束才显示，所以几十 KB 的 22 个文件也会表现成“极慢加载”。

现场中的 `2026-05-12.md` 在故障页出现前已有 7 个文件成功，并非已证明损坏。它是本机 APFS 普通文件，295 B、UTF-8 有效；没有软链接、ACL、特殊 flags、云占位或异常扩展属性。原生读取 200 次平均约 0.62 ms，22 个日报完整原生扫描平均约 2.75 ms，因此 8 秒不是文件或磁盘的正常耗时。

Obsidian 接入提交没有修改 Dashboard 读取代码。更强的反证是：2026-07-17 10:14 再次出现该文件读取错误时，Obsidian 已完全退出约 63 分钟。早期一次超时发生时 Obsidian 确实在运行，并在 26 秒后崩溃，所以不能排除编辑或同步改写造成过一次瞬态快照失效；但可以高置信度排除它是授权恢复、永久 pending 和持续复现的根因。

前三次现场截图都出现在显示器唤醒后不久。Chrome 150.0.7871.127 的更新又晚于最初两次异常，因此更值得验证的是睡眠唤醒后的 File System Access handle / permission 恢复，以及 Chrome Profile 状态，而不是把问题归因于 Obsidian 或单个 Markdown 文件。

## 3. 何时触发

- 新建 Memento 标签页且目录权限为 `granted`。
- 用户重新加载当前标签页。
- 用户重新允许权限或重新选择目录。

以下行为不触发：

- 关闭归档或每日总结抽屉。
- 页面保持打开一段时间。
- Obsidian 单独打开或关闭。

页面没有 timer、轮询或定时重扫。

## 4. 数据与模块边界

核心记录继续使用 IndexedDB `aisecretary` version 1 的 `handles` store：

| key | 内容 |
|---|---|
| `dir` | 现有 `FileSystemDirectoryHandle`，兼容 v0.8.6 回滚 |
| `dir-binding` | `{schema, token, boundHandle, createdAt}` |
| `core-snapshot` | 完整根日报原始字节、计数、总大小、提交时间、binding token 和固定 `scanDate` |
| `archive-index` | 归档文件名、标题、修改时间、提交时间和 binding token；不含 HTML 正文 |

核心持久快照只包含根目录 `YYYY-MM-DD.md`，总上限 5 MiB、最多 3660 个文件；归档 HTML 正文、Review、Prompt、状态、DOM 和 parser 派生值都不进入该快照。归档列表另存一份轻量索引，只包含文件名、标题和修改时间，并与当前目录 binding token 绑定；它不缓存 HTML 正文。

照片衍生缩略图使用独立 IndexedDB `memento-photo-thumbnails` version 1 的 `thumbnails` store。键由 `[bindingToken, assetName, variant]` 组成，当前规格为 `w480-webp-q72-v1`；不同目录、文件名或缩略规格不会串用。该库只接受 WebP 衍生 Blob，最多 96 项、合计 32 MiB、单项 512 KiB，并按 LRU 淘汰。原图不进入 IndexedDB。当前 Tab 另外保留最多 32 个 object URL；`pagehide` 只释放这些页面资源，不删除持久缩略图。

代码职责：

- `dashboard-cache-library.js`：快照 codec、handle 身份检查和 IndexedDB 原子事务。
- `dashboard-operations-library.js`：today 直读、4 worker 历史读取、预读 seed、单文件瞬态重试和 Web Lock 选主。
- `directory-access-library.js`：授权恢复和 generation gate。
- `photo-cache-library.js`：照片缩略图 identity、schema、限额和原子 LRU 事务。
- `photo-library.js`：视口调度、缩略生成、当前 Tab object URL 缓存和持久缓存接入。
- `dashboard.js`：缓存 / partial / fresh 的页面单调状态、today-first 编排与复制门禁。

## 5. 不变量

### 权限与目录身份

- `queryPermission() !== granted` 时不展示缓存正文。
- 当前 handle 必须与已保存 `dir`、binding 的 `boundHandle` 都通过 `isSameEntry()`。
- v0.8.6 回滚后若只把 `dir` 改成新目录，旧 binding 与快照立即 cache miss，并在 CAS 安全时重建 binding。
- 其他标签页选择新目录后广播 `selection-changed`；旧页重新读取已保存 `dir`，发现不一致就让当前 generation 失效。
- 目录保存的 UI watchdog 不取消底层 IndexedDB 事务；即使先提示超时，只要事务随后真实成功，也只补发一次 `selection-changed`。
- 自动恢复、跨页同步和手动选择共享一个 `selectionFlowId`；任何旧流程在 `await` 后都不能覆盖更新的目录、UI 或 busy 状态。
- 目录选择事务只在取得现有目录写锁后启动；归档保存 / 删除在同一锁内重读 `dir` 并做 `isSameEntry()`，因此切目录和归档写之间没有检查后再被替换的窗口。
- 每次复制前再次读取已保存 `dir` 并与页面 handle 做 `isSameEntry()`；不一致时不复制。
- 照片缩略图命中必须使用当前目录 binding token；切换目录后相同文件名也不能读取旧目录的衍生图。

### 原子事务

选择新目录：

```text
put(dir) + put(new binding) + delete(snapshot)
```

明确撤权 / 失效：

```text
read current binding → token 与调用方 expectedToken 相同
→ rotate binding token + delete(snapshot)
```

提交完整快照：

```text
read current binding → token 相同才 put(snapshot)
```

失效操作必须携带调用方已确认的 token；token 已变化时 no-op。因此目录切换前启动的旧扫描不能复活旧正文，旧标签页的迟到错误也不能轮换新目录 token 或删除新目录快照。

### 完整性

只有以下条件同时成立才写缓存：

```text
coverage.complete === true
issue === ''
issues.length === 0
```

空目录可以是完整结果；目录枚举中断、单文件失败或 worker 永久 pending 都不能覆盖 last-known-good。

### 页面单调性

- 有效缓存：`cache → partial(today overlay) → fresh / shared`；首个记录画面不先提交空 `waiting`。
- 缓存 miss / 损坏：`waiting → partial → fresh / shared`。
- 一旦 fresh / shared 已显示，迟到的旧缓存不能覆盖它。若今天的 live 文件意外早于缓存到达，只用缓存补齐历史，不覆盖 live today。
- 已显示缓存时，锁外点读只允许已确认的 `${scanDate}.md` 替换内存视图中的同名文件；确认 NotFound 时移除缓存中的旧 today。未完成的 null 不能被解释成删除，点读之后新建且 `mtime` 更新的文件也不能被旧 tombstone 覆盖。
- 完整历史扫描枚举到 today 时复用点读 seed，不再发起第二次 `getFile()` / `arrayBuffer()`；历史 partial 不混入持久 LKG。
- today overlay 只解锁“今天”；周 / 月仍需本轮完整 `fresh` 或同轮 leader 发布的 `shared`。
- 共享发布必须精确匹配 binding token、`committedAt` 和 `scanDate`，且接收前再次确认权限。

## 6. 今日直读与四路历史读取

1. 页面启动时只计算一次本地 `scanDate`，本轮排序、解析、today gate 和共享发布都使用它；跨午夜不重新解释“今天”。
2. 缓存首屏获得一次绘制机会后，本 Tab 对 `${scanDate}.md` 直接调用 `getFileHandle()` → `getFile()` → `arrayBuffer()`；这一请求位于完整历史 Web Lock 之外，也不调用 `entries()`。
3. today 成功或确认不存在后立即提交 partial；普通瞬态错误交给完整扫描再试，权限 / 根目录失效继续走统一恢复边界。
4. today 点读 settle 后才探测完整历史锁，因此同一 Tab 不会让直读与自身 4 路历史池争抢 File System Access broker。
5. 历史 leader 枚举根目录中所有日报 handle；若枚举到已点读的 today，直接使用 seed 并正确计入 `discoveredCount` / `completedCount`，不二次打开。其余日期倒序。
6. 历史扫描最多创建 4 个 worker；一个 worker 的 `getFile + arrayBuffer` 完整 settle 后才领取下一个文件。
7. `NotReadableError` / `NotFoundError` 在同一槽内从父目录重新取得 child handle，再取新 File 快照并重试一次；permission 和未知错误不重试。
8. 权限 fatal 后停止领取新任务，并等待已经启动的真实请求 settle 后释放锁。
9. 目录切换使 generation 失效后，不再开始 `arrayBuffer()`、枚举或领取新文件；已经发出的不可取消请求仍等待真实 settle。

不使用 `Promise.race` 假装取消，不因 UI watchdog 再开第 5 个真实请求。

## 7. 多标签页

固定 Web Lock：`memento.dashboard.core-refresh.v1`，初次探测使用 `ifAvailable: true`：

- leader：在同一个 core lock callback 内运行 4-worker pool；完整结果的 token-CAS 提交和 `core-snapshot-committed` 发布也在释放锁前完成。
- follower：与所有 Tab 一样，先在锁外点读并提交 today；随后对完整历史锁立即返回，不排队扫描。leader 成功发布时再重读完整快照。
- Web Locks / BroadcastChannel 不可用：本页仍先直读 today，随后 local 4 路扫描，且不写共享缓存。

leader 完成并成功 CAS 写入后，通过 BroadcastChannel 只发送 `{bindingToken, committedAt, scanDate}`；Markdown 正文始终不经过消息通道。follower 从 IndexedDB 重读并精确验证快照字段。快照本身也记录 `scanDate`，避免把跨午夜或旧轮 LKG 误认成当前共享结果。

这里没有定时器、轮询、租约、heartbeat 或自动接管。leader 永久 pending、失败、关闭或 renderer 崩溃而没有发布完整快照时，follower 仍保留最新 today + last-known-good 历史；用户刷新会重新直读 today 并发起一轮新的 `ifAvailable` 历史探测。这个明确的手动边界避免为了极少见的跨标签页故障引入租约、持久化协调状态或不可证明的重复全量扫描。

目录选择成功持久化后另发 `selection-changed`。每个旧页重新核对已保存 handle；发送页若发现自己的选择流程已过期，也会主动重读最终持久化结果，因为 BroadcastChannel 不会把消息回送给发送者。复制入口和归档写入口都独立做 `isSameEntry()`，不依赖广播一定送达。

## 8. 照片缩略图缓存

1. 每日总结文字卡先渲染；只有距离滚动可视区前后约 600 px 的照片进入 3 路加载池。
2. 当前 Tab 先查内存 object URL，再查独立 IndexedDB。持久缓存只有 120 ms 的决策窗口；窗口内命中时直接为 WebP Blob 创建 object URL，不读原图、不重新缩放或编码，超时则立即按 miss 回退实时原图，迟到结果不阻塞本次显示。
3. 首次 miss 才从 `assets/` 读原图，在内存中生成最大宽约 480 px、WebP 质量 0.72 的派生图。渲染不等待 IndexedDB 写入；写入失败只影响下一个 Tab 的命中。
4. 只有真正派生的 WebP Blob 可持久化。缩略能力不可用或单张处理失败时显示原图，但原图不会进入缩略缓存。
5. 持久 key 精确包含目录 binding token、asset filename 和 variant。当前上限是 96 项 / 32 MiB / 单项 512 KiB，同一事务写入后按 LRU 淘汰。损坏的当前 schema 记录异步清理，future schema 保留但不展示。
6. 当前 Tab 最多保留 32 个 object URL。`pagehide` 只停止视口任务并回收 object URL；持久 Blob 保留，下一个 Tab 可继续命中。
7. 正常采集器为每张 asset 生成唯一文件名，缓存据此将 asset 视为不可变资源。命中不承诺重新打开源文件验证内容；需要替换图片时必须写新文件名并更新 Markdown 引用，同名原位替换不属于本合同支持的常规写入路径。

## 9. 降级行为

| 情况 | 当前页面 | 缓存 |
|---|---|---|
| Cache DB / `isSameEntry` 慢 | live 独立启动 | 本轮可能不读写 |
| today 直读普通失败 | 继续显示 LKG，完整扫描再独立尝试一次 | 不变 |
| 单文件瞬态替换 | 同文件重取一次 | 完整后才更新 |
| 历史文件永久 pending | 只占 1 路；若今天成功则覆盖缓存底稿中的今天并只解锁今天 | 保留 LKG |
| 今天文件永久 pending | 显示缓存或其他已确认 partial；今天不可复制 | 保留 LKG |
| 4 路都 pending | 显示缓存或中性 waiting | 保留 LKG |
| 单文件真实失败 | 显示其他已确认文件 | 不覆盖 |
| permission denied | 立即隐藏正文并提示重选 | 仅 expected token 仍为当前值时轮换并删除 |
| 其他标签页切换目录 | 当前 generation 失效；复制前 identity gate 再兜底 | 原子换 binding，删除旧快照 |
| 切目录与旧页归档写同时发生 | 同一目录写锁决定先后；归档在锁内重读 persisted handle，不匹配就取消并同步新目录 | 不写旧目录 |
| 快照广播丢失 / 安装失败 | 保留直读 today + LKG 历史 | 不变 |
| leader 失败、关闭或 renderer 崩溃 | follower 不自动全量扫描；今天仍由本 Tab 直读 | 不变 |
| leader 永久 pending | 保留直读 today + LKG 历史，不增加全量 FSA | 不变 |
| 扫描跨过午夜 | 整轮继续使用启动时 `scanDate`；下次刷新才进入新日期 | 完整时按原 scanDate 发布 |
| 缓存超 5 MiB / 损坏 / 未来 schema | live-only | fail-closed |
| 照片 IndexedDB 不可用 / 读写失败 | 本 Tab 直读原图并生成临时预览 | 本页停用相应持久读或写 |
| 持久缩略图读取超过 120 ms | 立即回退实时原图，不等待迟到缓存 | 本次按 miss 处理，既有条目保留 |
| 缩略图超过 512 KiB | 当前页仍可显示 | 不写入 |
| 照片缓存超 96 项或 32 MiB | 无感知 | 事务内淘汰 LRU |

## 10. 后续扩展点

只有真实数据证明需要时再考虑：

- `mtime + size` 增量读取。
- 用户可见的“清除快速启动缓存”按钮。
- 诊断事件环：仅记录文件名、阶段、耗时和错误名。
- follower 长时间等待或共享快照安装失败时的用户可见手动刷新入口。

这些都不改变现有 binding token、complete-only 和 generation gate 协议。

## 11. 参考

- [Chrome File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [File System Standard · getFile](https://fs.spec.whatwg.org/#api-filesystemfilehandle-getfile)
- [File API · errors](https://w3c.github.io/FileAPI/)
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)
- [Obsidian Sync security and privacy](https://help.obsidian.md/Obsidian%20Sync/Security%20and%20privacy)
