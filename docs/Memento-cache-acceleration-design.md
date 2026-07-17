# Memento Chrome 快速缓存与并发读取 · Lean v1

日期：2026-07-17
实现版本：v0.8.7

## 1. 结论

Lean v1 只解决一个问题：Chrome 某次本地文件调用很慢或永久 pending 时，新标签页仍能尽快可用，并且不能展示错目录、污染完整缓存或静默复制旧数据。

实现由五个约束组成：

1. 授权通过后，可信的 last-known-good 完整快照可先显示。
2. 根日报固定 4 路读取；本轮固定的 `${scanDate}.md` 最先进入 worker 队列。
3. 共享协调可用时，同一扩展 origin 同时只有一个标签页执行核心扫描；leader 在锁内完成缓存提交和快照发布后才释放锁，follower 不自动补开扫描。
4. 只有完整扫描能覆盖持久缓存；缓存底稿只允许当前轮成功读取的“今天”在内存中单文件覆盖。
5. 目录切换、失效、复制和归档写入都重新核对目录身份，旧标签页不能影响新目录。

不引入第二个数据库、outbox、租约、heartbeat、分文件增量索引、多版本正文或定时刷新。

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

继续使用 IndexedDB `aisecretary` version 1 的 `handles` store：

| key | 内容 |
|---|---|
| `dir` | 现有 `FileSystemDirectoryHandle`，兼容 v0.8.6 回滚 |
| `dir-binding` | `{schema, token, boundHandle, createdAt}` |
| `core-snapshot` | 完整根日报原始字节、计数、总大小、提交时间、binding token 和固定 `scanDate` |

快照只包含根目录 `YYYY-MM-DD.md`，总上限 5 MiB、最多 3660 个文件。照片、归档、Review、Prompt、状态、DOM 和 parser 派生值都不缓存。

代码职责：

- `dashboard-cache-library.js`：快照 codec、handle 身份检查和 IndexedDB 原子事务。
- `dashboard-operations-library.js`：4 worker 文件读取、单文件瞬态重试和 Web Lock 选主。
- `directory-access-library.js`：授权恢复和 generation gate。
- `dashboard.js`：缓存 / partial / fresh 的页面单调状态与复制门禁。

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

- `waiting → cache → fresh / shared`。
- `waiting → partial → fresh`。
- `cache → partial(today overlay) → fresh / shared`。
- 一旦 partial / fresh 已显示，迟到的旧缓存不能覆盖它。
- 已显示缓存时，live 只允许成功读取的 `${scanDate}.md` 替换内存视图中的同名文件；历史文件不做混合，持久 LKG 也不改变。
- today overlay 只解锁“今天”；周 / 月仍需本轮完整 `fresh` 或同轮 leader 发布的 `shared`。
- 共享发布必须精确匹配 binding token、`committedAt` 和 `scanDate`，且接收前再次确认权限。

## 6. 四路读取

1. 页面启动时只计算一次本地 `scanDate`，本轮排序、解析、today gate 和共享发布都使用它；跨午夜不重新解释“今天”。
2. 先枚举根目录中所有日报 handle。
3. `${scanDate}.md` 排序第一，其余日期倒序。
4. 最多创建 4 个 worker。
5. 一个 worker 的 `getFile + arrayBuffer` 完整 settle 后才领取下一个文件。
6. `NotReadableError` / `NotFoundError` 在同一槽内从父目录重新取得 child handle，再取新 File 快照并重试一次；permission 和未知错误不重试。
7. 权限 fatal 后停止领取新任务，并等待已经启动的真实请求 settle 后释放锁。
8. 目录切换使 generation 失效后，不再枚举或领取新文件；已经发出的不可取消请求仍等待真实 settle。

不使用 `Promise.race` 假装取消，不因 UI watchdog 再开第 5 个真实请求。

## 7. 多标签页

固定 Web Lock：`memento.dashboard.core-refresh.v1`，初次探测使用 `ifAvailable: true`：

- leader：在同一个 core lock callback 内运行 4-worker pool；完整结果的 token-CAS 提交和 `core-snapshot-committed` 发布也在释放锁前完成。
- follower：立即返回，不访问根日报、不排队扫描；显示可信缓存或 waiting，成功发布时重读快照。
- Web Locks / BroadcastChannel 不可用：本页 local 4 路，且不写共享缓存。

leader 完成并成功 CAS 写入后，通过 BroadcastChannel 只发送 `{bindingToken, committedAt, scanDate}`；Markdown 正文始终不经过消息通道。follower 从 IndexedDB 重读并精确验证快照字段。快照本身也记录 `scanDate`，避免把跨午夜或旧轮 LKG 误认成当前共享结果。

这里没有定时器、轮询、租约、heartbeat 或自动接管。leader 永久 pending、失败、关闭或 renderer 崩溃而没有发布完整快照时，follower 保留 cache / waiting，并提示关闭其他 Memento 页面后手动刷新。用户刷新会发起一轮新的 `ifAvailable` 探测。这个明确的手动边界避免为了极少见的跨标签页故障引入租约、持久化协调状态或不可证明的重复扫描。

目录选择成功持久化后另发 `selection-changed`。每个旧页重新核对已保存 handle；发送页若发现自己的选择流程已过期，也会主动重读最终持久化结果，因为 BroadcastChannel 不会把消息回送给发送者。复制入口和归档写入口都独立做 `isSameEntry()`，不依赖广播一定送达。

## 8. 降级行为

| 情况 | 当前页面 | 缓存 |
|---|---|---|
| Cache DB / `isSameEntry` 慢 | live 独立启动 | 本轮可能不读写 |
| 单文件瞬态替换 | 同文件重取一次 | 完整后才更新 |
| 历史文件永久 pending | 只占 1 路；若今天成功则覆盖缓存底稿中的今天并只解锁今天 | 保留 LKG |
| 今天文件永久 pending | 显示缓存或其他已确认 partial；今天不可复制 | 保留 LKG |
| 4 路都 pending | 显示缓存或中性 waiting | 保留 LKG |
| 单文件真实失败 | 显示其他已确认文件 | 不覆盖 |
| permission denied | 立即隐藏正文并提示重选 | 仅 expected token 仍为当前值时轮换并删除 |
| 其他标签页切换目录 | 当前 generation 失效；复制前 identity gate 再兜底 | 原子换 binding，删除旧快照 |
| 切目录与旧页归档写同时发生 | 同一目录写锁决定先后；归档在锁内重读 persisted handle，不匹配就取消并同步新目录 | 不写旧目录 |
| 快照广播丢失 / 安装失败 | 保留 cache / waiting，提示关闭其他页面后刷新 | 不变 |
| leader 失败、关闭或 renderer 崩溃 | follower 不自动扫描；用户刷新后重新探测 | 不变 |
| leader 永久 pending | 保留 cache / waiting，不增加 FSA | 不变 |
| 扫描跨过午夜 | 整轮继续使用启动时 `scanDate`；下次刷新才进入新日期 | 完整时按原 scanDate 发布 |
| 缓存超 5 MiB / 损坏 / 未来 schema | live-only | fail-closed |

## 9. 后续扩展点

只有真实数据证明需要时再考虑：

- `mtime + size` 增量读取。
- 用户可见的“清除快速启动缓存”按钮。
- 诊断事件环：仅记录文件名、阶段、耗时和错误名。
- follower 长时间等待或共享快照安装失败时的用户可见手动刷新入口。

这些都不改变现有 binding token、complete-only 和 generation gate 协议。

## 10. 参考

- [Chrome File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [File System Standard · getFile](https://fs.spec.whatwg.org/#api-filesystemfilehandle-getfile)
- [File API · errors](https://w3c.github.io/FileAPI/)
- [Obsidian Vault API](https://docs.obsidian.md/Plugins/Vault)
- [Obsidian Sync security and privacy](https://help.obsidian.md/Obsidian%20Sync/Security%20and%20privacy)
