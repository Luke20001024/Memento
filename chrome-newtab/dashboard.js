// Memento · Chrome 新标签页 Dashboard
// - 今日记录摘要 (不设置完成态,不催促清理)
// - 大号"复制今天 → AI"按钮 (clipboard API)
// - Entry 列表 (默认展示全部记录,chip 切换)
// - 统计 + 90 天记录热力图
// - 每日总结 (当天第一帧 + Daily Review + 运行状态)
//
// 本文件不依赖任何外部库,内含一个极简 markdown 渲染器 (paragraphs + code + list)。
// 注: 内部技术目录名仍为 AISecretary (沿用旧名),Memento 是后改的产品名。

// =============================================================
// 0. IndexedDB · 存放 directoryHandle
// =============================================================

const DB_NAME = 'aisecretary';
const STORE = 'handles';
const HANDLE_KEY = 'dir';
const STORAGE_OPERATION_TIMEOUT_MS = 8000;
const CACHE_FIRST_DECISION_MS = 250;
const CACHE_CONTEXT_GRACE_MS = 250;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    const fail = () => {
      db.close();
      reject(tx.error || new Error('无法保存目录授权记录'));
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

async function loadHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(HANDLE_KEY);
    let handle = null;
    req.onsuccess = () => { handle = req.result || null; };
    tx.oncomplete = () => {
      db.close();
      resolve(handle);
    };
    const fail = () => {
      db.close();
      const requestError = req.readyState === 'done' ? req.error : null;
      reject(requestError || tx.error || new Error('无法读取目录授权记录'));
    };
    req.onerror = fail;
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

const dashboardCacheRepository = window.MementoDashboardCache
  ? window.MementoDashboardCache.createRepository({ openDB })
  : null;
const photoThumbnailCacheRepository = window.MementoPhotoCache
  ? window.MementoPhotoCache.createRepository()
  : null;
const CORE_REFRESH_CHANNEL_NAME = 'memento.dashboard.core-refresh.events.v1';

async function invalidateFastStartCache(handle, suppliedContextPromise = null) {
  if (!dashboardCacheRepository || !handle) {
    return { invalidated: false, reason: 'missing-context' };
  }

  let context = null;
  if (suppliedContextPromise) {
    const suppliedContext = await suppliedContextPromise;
    if (suppliedContext && suppliedContext.handle) {
      try {
        if (await handle.isSameEntry(suppliedContext.handle)) context = suppliedContext;
      } catch {
        // Fall through to a fresh, handle-checked lookup below.
      }
    }
  }
  if (!context) {
    const bootstrap = await dashboardCacheRepository.readBootstrap();
    context = await dashboardCacheRepository.resolveBootstrap(handle, bootstrap);
  }
  if (!context || !context.binding) {
    return { invalidated: false, reason: context?.reason || 'missing-binding' };
  }
  return dashboardCacheRepository.invalidateCurrent(context.binding.token);
}

async function persistBrowserStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (error) {
    // 目录句柄已经写入 IndexedDB;持久化存储申请失败不应阻止本次使用。
    console.warn('无法申请持久化浏览器存储', error);
  }
}

// =============================================================
// 1. File System Access · 授权 + 读文件
// =============================================================

async function queryRead(handle) {
  return handle.queryPermission({ mode: 'read' });
}
async function requestRead(handle) {
  return handle.requestPermission({ mode: 'read' });
}
async function pickFolder() {
  return window.showDirectoryPicker({ mode: 'read' });
}
async function persistSelectedDirectoryHandle(handle, preparedSelection = null, onEventuallyPersisted = null) {
  const startPersistence = () => preparedSelection
    ? preparedSelection.startPersistence()
    : saveHandle(handle);
  const operations = window.MementoDashboardOperations;
  // Directory selection and archive writes change the meaning or contents of
  // the same user-owned directory. Serialize their commit boundaries so an
  // archive mutation can verify the persisted selection without a TOCTOU gap.
  const persistence = navigator.locks
      && typeof navigator.locks.request === 'function'
      && operations
      && typeof operations.withArchiveMutationLock === 'function'
    ? operations.withArchiveMutationLock(navigator.locks, startPersistence)
    : startPersistence();
  if (typeof onEventuallyPersisted === 'function') {
    void Promise.resolve(persistence).then(onEventuallyPersisted, () => undefined);
  }
  const access = window.MementoDirectoryAccess;
  if (access && access.withTimeout) {
    await access.withTimeout(
      () => persistence,
      STORAGE_OPERATION_TIMEOUT_MS,
      '保存浏览器授权记录'
    );
  } else {
    await persistence;
  }
  void persistBrowserStorage();
}
async function listMarkdownFiles(dirHandle, options = {}) {
  if (!window.MementoDashboardOperations) throw new Error('Dashboard 文件操作模块未加载');
  return window.MementoDashboardOperations.readMarkdownFiles(dirHandle, {
    ...options,
    todayDate: options.todayDate || getLocalDate(),
    onProgress: detail => {
      if (!options.isCurrent || options.isCurrent()) {
        const total = detail.discoveredCount ? ` / ${detail.discoveredCount}` : '';
        setStatus(`正在并行读取每日记录…已完成 ${detail.count}${total} 个文件`);
      }
      if (typeof options.onProgress === 'function') options.onProgress(detail);
    },
  });
}

const OPTIONAL_FILE_READ_CONCURRENCY = 3;
const optionalReadQueue = [];
let optionalReadActive = 0;

function pumpOptionalReadQueue() {
  while (optionalReadActive < OPTIONAL_FILE_READ_CONCURRENCY && optionalReadQueue.length) {
    const queued = optionalReadQueue.shift();
    if (!queued.shouldStart()) {
      queued.resolve({ skipped: true });
      continue;
    }
    optionalReadActive++;
    Promise.resolve()
      .then(queued.task)
      .then(queued.resolve, error => queued.resolve({ error }))
      .finally(() => {
        optionalReadActive--;
        pumpOptionalReadQueue();
      });
  }
}

function scheduleOptionalRead(task, shouldStart) {
  return new Promise(resolve => {
    optionalReadQueue.push({ task, shouldStart, resolve });
    pumpOptionalReadQueue();
  });
}

function optionalReadCurrent(options = {}) {
  const generationCurrent = typeof options.isCurrent !== 'function' || options.isCurrent();
  return generationCurrent
    && (!options.coordinator || options.coordinator.canContinue());
}

function staleOptionalFiles(files = []) {
  return { files, issue: '', stale: true };
}

function createOptionalReadCoordinator(options = {}) {
  let fatalError = null;
  const generationCurrent = () => typeof options.isCurrent !== 'function' || options.isCurrent();

  return {
    canContinue: () => !fatalError && generationCurrent(),
    fatalError: () => fatalError,
    fail(error) {
      if (!fatalError) fatalError = error;
      pumpOptionalReadQueue();
    },
    schedule(task) {
      return scheduleOptionalRead(async () => {
        try {
          return await task();
        } catch (error) {
          if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
            fatalError = error;
          }
          throw error;
        }
      }, () => !fatalError && generationCurrent());
    },
  };
}

async function listOptionalTextFiles(dirHandle, options) {
  const entries = [];
  let scanIssue = '';

  try {
    const iterator = dirHandle.entries()[Symbol.asyncIterator]();
    while (optionalReadCurrent(options)) {
      const next = await iterator.next();
      if (!optionalReadCurrent(options)) return staleOptionalFiles();
      if (next.done) break;
      const [name, entry] = next.value;
      if (entry.kind !== 'file' || !options.namePattern.test(name)) continue;
      entries.push({ name, date: name.replace(options.extensionPattern, ''), entry });
    }
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      options.coordinator?.fail(error);
      throw error;
    }
    scanIssue = fileReadIssue(error, options.scanIssue);
  }

  if (!optionalReadCurrent(options)) return staleOptionalFiles();

  const coordinator = options.coordinator || createOptionalReadCoordinator(options);
  const taskOptions = options.coordinator ? options : { ...options, coordinator };
  const results = await Promise.all(entries.map(({ name, date, entry }) =>
    coordinator.schedule(async () => {
      if (!optionalReadCurrent(taskOptions)) return { skipped: true };
      try {
        const file = await entry.getFile();
        if (!optionalReadCurrent(taskOptions)) return { skipped: true };
        const text = await file.text();
        if (!optionalReadCurrent(taskOptions)) return { skipped: true };
        return { file: { name, date, mtime: file.lastModified, text, readIssue: '' } };
      } catch (error) {
        if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
          throw error;
        }
        return {
          file: {
            name,
            date,
            mtime: 0,
            text: '',
            readIssue: fileReadIssue(error, options.fileIssue),
          },
        };
      }
    })
  ));
  if (coordinator.fatalError()) throw coordinator.fatalError();
  const completed = results.map(result => result.file).filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!optionalReadCurrent(taskOptions)) return staleOptionalFiles(completed);
  return { files: completed, issue: scanIssue };
}

async function readOptionalDashboardData(handle, options = {}) {
  // These are optional enhancements. Read them after the main records, but
  // start all three together and still wait for every physical request to
  // settle. File System Access promises cannot be cancelled, so a bare
  // Promise.all rejection would leave hidden work running behind a retry.
  const coordinator = createOptionalReadCoordinator(options);
  const coordinatedOptions = { ...options, coordinator };
  const settled = await Promise.allSettled([
    listDailyReviewFiles(handle, coordinatedOptions),
    listDailyReviewStateFiles(handle, coordinatedOptions),
    readDailyReviewPrompt(handle, coordinatedOptions),
  ]);
  const permissionFailure = settled.find(result => result.status === 'rejected'
    && result.reason
    && (result.reason.name === 'NotAllowedError' || result.reason.name === 'SecurityError'));
  if (permissionFailure) throw permissionFailure.reason;
  const fallbacks = [
    { files: [], issue: '每日总结暂时无法读取。' },
    { files: [], issue: '总结运行状态暂时无法读取。' },
    { hash: '', issue: '当前总结 Prompt 暂时无法读取，现有总结不能判定为已更新。' },
  ];
  const [reviewResult, reviewStateResult, promptResult] = settled.map((result, index) =>
    result.status === 'fulfilled' ? result.value : fallbacks[index]
  );
  return { reviewResult, reviewStateResult, promptResult };
}

function fileReadIssue(error, fallback) {
  if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return '访问总结目录的权限已失效';
  return fallback;
}

async function listDailyReviewFiles(rootHandle, options = {}) {
  if (!optionalReadCurrent(options)) return staleOptionalFiles();
  let dailyDir;
  try {
    const reviewsDir = await rootHandle.getDirectoryHandle('Reviews');
    if (!optionalReadCurrent(options)) return staleOptionalFiles();
    dailyDir = await reviewsDir.getDirectoryHandle('Daily');
  } catch (error) {
    if (error && error.name === 'NotFoundError') return { files: [], issue: '' };
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      options.coordinator?.fail(error);
      throw error;
    }
    return {
      files: [],
      issue: fileReadIssue(error, '无法读取 Daily Review 目录'),
    };
  }
  if (!optionalReadCurrent(options)) return staleOptionalFiles();
  return listOptionalTextFiles(dailyDir, {
    ...options,
    namePattern: /^\d{4}-\d{2}-\d{2}\.md$/,
    extensionPattern: /\.md$/,
    fileIssue: '总结文件暂时无法读取',
    scanIssue: '无法继续读取 Daily Review 目录',
  });
}

async function listDailyReviewStateFiles(rootHandle, options = {}) {
  if (!optionalReadCurrent(options)) return staleOptionalFiles();
  let statusDir;
  try {
    const reviewDir = await rootHandle.getDirectoryHandle('.review');
    if (!optionalReadCurrent(options)) return staleOptionalFiles();
    statusDir = await reviewDir.getDirectoryHandle('status');
  } catch (error) {
    if (error && error.name === 'NotFoundError') return { files: [], issue: '' };
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
      options.coordinator?.fail(error);
      throw error;
    }
    return {
      files: [],
      issue: fileReadIssue(error, '无法读取总结运行状态'),
    };
  }
  if (!optionalReadCurrent(options)) return staleOptionalFiles();
  return listOptionalTextFiles(statusDir, {
    ...options,
    namePattern: /^\d{4}-\d{2}-\d{2}\.json$/,
    extensionPattern: /\.json$/,
    fileIssue: '总结运行状态暂时无法读取',
    scanIssue: '无法继续读取总结运行状态',
  });
}

async function readDailyReviewPrompt(rootHandle, options = {}) {
  const staleResult = { hash: '', issue: '', stale: true };
  if (!optionalReadCurrent(options)) return staleResult;
  try {
    const promptDir = await rootHandle.getDirectoryHandle('.chrome-newtab');
    if (!optionalReadCurrent(options)) return staleResult;
    const promptHandle = await promptDir.getFileHandle('prompts.js');
    if (!optionalReadCurrent(options)) return staleResult;
    const file = await promptHandle.getFile();
    if (!optionalReadCurrent(options)) return staleResult;
    const bytes = await file.arrayBuffer();
    if (!optionalReadCurrent(options)) return staleResult;
    const text = new TextDecoder().decode(bytes);
    // 与 daily-review/review_status.sh 的可用性检查保持一致；hash 覆盖整个文件。
    if (!text.includes("id: 'comprehensive'")) {
      return {
        hash: '',
        issue: '当前 .chrome-newtab/prompts.js 缺少 comprehensive Prompt，现有总结不能判定为已更新。',
      };
    }
    return { hash: await sha256Hex(bytes), issue: '' };
  } catch (error) {
    const missing = error && error.name === 'NotFoundError';
    const permission = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    if (permission) {
      options.coordinator?.fail(error);
      throw error;
    }
    return {
      hash: '',
      issue: missing
        ? '缺少 .chrome-newtab/prompts.js，现有总结不能判定为已更新。'
        : permission
          ? '当前总结 Prompt 因目录权限失效而无法读取，现有总结需要重新校验。'
          : '当前总结 Prompt 暂时无法读取，现有总结不能判定为已更新。',
    };
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function buildSourceHashes(files) {
  // review_status.sh 以 `-s` 要求源记录非空；空文件不能拥有可用 freshness hash。
  const readableSources = (files || []).filter(file => file.bytes && file.bytes.byteLength > 0);
  const pairs = await Promise.all(readableSources.map(async file => [file.date, await sha256Hex(file.bytes)]));
  return Object.fromEntries(pairs);
}

function buildSourceDaySkeleton(files) {
  return Object.fromEntries((files || [])
    .filter(file => file && file.date && file.bytes && file.bytes.byteLength > 0)
    .map(file => [file.date, '']));
}

function sourceMockFromText(text) {
  // review_status.sh 比较源文件的原始行；CRLF 不应被浏览器悄悄解释成 mock。
  const lines = String(text || '').split('\n');
  if (lines[0] !== '---') return false;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index] === '---') break;
    if (lines[index] === 'mock: true') return true;
  }
  return false;
}

function buildSourceMocks(files) {
  return Object.fromEntries((files || [])
    .filter(file => file.bytes && file.bytes.byteLength > 0)
    .map(file => [file.date, sourceMockFromText(file.text)]));
}

// =============================================================
// 2. Markdown parser
// =============================================================

const KNOWN_TAGS = new Set(['TODO', '灵感', '下次再读']);
const WEEKDAY_RE = /^周[一二三四五六日]$/;
const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;
const ENTRY_SPLIT_RE = /\n---\s*\n/;

function parseFile(text, date) {
  const body = text.replace(FRONTMATTER_RE, '');
  const blocks = body.split(ENTRY_SPLIT_RE).map(b => b.trim()).filter(Boolean);
  return blocks.map((block, idx) => parseEntry(block, date, idx)).filter(Boolean);
}

function parseEntry(block, date, index) {
  const lines = block.split('\n');
  const headingLineIdx = lines.findIndex(l => l.startsWith('## '));
  if (headingLineIdx < 0) return null;

  const heading = lines[headingLineIdx].replace(/^##\s+/, '').trim();
  const parts = heading.split(' · ').map(s => s.trim()).filter(Boolean);

  const time = parts[0] || '';
  let weekday = null, source = null, tag = null;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (WEEKDAY_RE.test(p)) weekday = p;
    else if (p.startsWith('#')) tag = p.slice(1);
    else source = source ?? p;
  }

  let bodyLines = lines.slice(headingLineIdx + 1);
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();

  if (!source && bodyLines.length) {
    const last = bodyLines[bodyLines.length - 1];
    if (/^—\s+\S/.test(last)) {
      source = last.replace(/^—\s+/, '').trim();
      bodyLines.pop();
      while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    }
  }

  let note = null;
  for (let i = 0; i < bodyLines.length; i++) {
    if (/^>\s*备注[:：]/.test(bodyLines[i])) {
      note = bodyLines[i].replace(/^>\s*备注[:：]\s*/, '').trim();
      bodyLines.splice(i, 1);
      if (bodyLines[i] !== undefined && !bodyLines[i].trim()) bodyLines.splice(i, 1);
      break;
    }
  }

  let screenshot = null;
  for (let i = 0; i < bodyLines.length; i++) {
    if (/^>\s*!\[/.test(bodyLines[i])) {
      const m = bodyLines[i].match(/!\[[^\]]*\]\(([^)]+)\)/);
      if (m) screenshot = m[1];
      bodyLines.splice(i, 1);
      break;
    }
  }

  if (!tag) {
    for (let i = 0; i < bodyLines.length; i++) {
      const m = bodyLines[i].match(/(?:^|\s)#(TODO|灵感|下次再读)(?:\s|$)/);
      if (m && KNOWN_TAGS.has(m[1])) {
        tag = m[1];
        if (bodyLines[i].trim() === `#${m[1]}`) {
          bodyLines.splice(i, 1);
          if (bodyLines[i] !== undefined && !bodyLines[i].trim()) bodyLines.splice(i, 1);
        }
        break;
      }
    }
  }

  return {
    id: `${date}#${index}`,
    date, time, weekday, source, tag, note, screenshot,
    sourceIndex: index,
    body: bodyLines.join('\n').trim(),
    raw: block,
  };
}

// =============================================================
// 3. 极简 Markdown 渲染 (paragraphs / inline code / list)
//    先 escape 所有 HTML,再补回安全标签,避免 XSS
// =============================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderMarkdown(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  const paragraphs = escaped.split(/\n\s*\n/);
  return paragraphs.map(p => {
    p = p.trim();
    if (!p) return '';
    const lines = p.split('\n');
    // 纯列表段
    if (lines.every(l => /^-\s+/.test(l))) {
      return '<ul>' + lines.map(l =>
        `<li>${inline(l.replace(/^-\s+/, ''))}</li>`
      ).join('') + '</ul>';
    }
    return `<p>${inline(p).replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean).join('');
}

function inline(s) {
  // 行内 code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 加粗 (用得不多,但便宜)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}

// =============================================================
// 4. localStorage · Prompt 选择
// =============================================================

const RANGE_KEY = 'aisec.range';   // A · 时间段 (today/week/month)
const STYLE_KEY = 'aisec.style';   // B · 风格 (prompt id, null=不附)

function getSavedRange() {
  return localStorage.getItem(RANGE_KEY) || 'today';
}
function setSavedRange(id) {
  if (id) localStorage.setItem(RANGE_KEY, id);
}
function getSavedStyle() {
  return localStorage.getItem(STYLE_KEY) || null;
}
function setSavedStyle(id) {
  if (id) localStorage.setItem(STYLE_KEY, id);
  else localStorage.removeItem(STYLE_KEY);
}
function findStyle(id) {
  if (!id || !window.MEMENTO_STYLES) return null;
  return window.MEMENTO_STYLES.find(p => p.id === id) || null;
}
function findRange(id) {
  const ranges = window.MEMENTO_RANGES || [];
  return ranges.find(r => r.id === id) || ranges[0] || { id: 'today', label: '今天', days: 1 };
}

// =============================================================
// 5. State + 渲染
// =============================================================

const state = {
  files: [],
  allEntries: [],
  todayDate: null,
  todayFileText: null,
  todayEntries: [],
  currentFilter: 'all', // 记录优先:默认看见完整的一天
  selectedRange: 'today', // A · 时间段 (today/week/month)
  selectedStyle: null,    // B · 风格 prompt id (null = 不附)
  dirHandle: null,        // ~/AISecretary 目录 handle (照片和总结只读;写归档时懒升级)
  snapshots: [],          // 从每日 Markdown 解析出的“每日第一帧”
  reviews: [],            // 从 Reviews/Daily 解析出的晚间总结
  reviewStates: {},       // 从 .review/status 读取的真实生成状态
  dayCards: [],           // 按日期配对后的照片 + 总结
  reviewReadIssue: '',    // 总结目录级读取异常;不影响主记录和照片
  reviewStatusReadIssue: '', // 状态目录级读取异常;不存在时保持安静
  reviewPromptReadIssue: '', // 当前 Prompt 读取失败时 Review 不能标记为 current
  recordReadIssues: [],   // 单个根 Markdown 读取失败;其他文件继续加载
  recordScanIssue: '',    // 根目录扫描中断时显示已读取的部分结果
  persistenceIssue: '',   // 当前 handle 可用，但 IndexedDB 未确认持久化
  recordSource: 'none',   // none / waiting / cache / partial / fresh / shared
  recordRefreshMessage: '', // 缓存、跨标签页和后台核对状态
  todayResolved: false,   // 今天文件已成功读取，或完整扫描已确认不存在
};

const directoryLoadGate = window.MementoDirectoryAccess.createGenerationGate();
let selectionEpoch = 0;

function renderDashboard() {
  renderDashboardNotice();
  renderRecordSummary(state.todayEntries.length);
  renderStats();
  renderHeatmap();
  renderSectionDivider();
  renderChips();
  renderEntryList();
  bindCopyButton();

}

function renderDashboardNotice() {
  const notice = document.getElementById('dashboard-notice');
  const messages = [];
  const errorMessages = [];
  if (state.recordRefreshMessage) messages.push(state.recordRefreshMessage);
  if (state.recordReadIssues.length) {
    const names = state.recordReadIssues.slice(0, 3).map(issue => issue.name).join('、');
    const more = state.recordReadIssues.length > 3 ? ` 等 ${state.recordReadIssues.length} 个文件` : '';
    errorMessages.push(`有 ${state.recordReadIssues.length} 个每日记录文件暂时无法读取(${names}${more})，其余记录已正常加载。`);
  }
  if (state.recordScanIssue) {
    errorMessages.push(`${state.recordScanIssue} 当前已显示 ${state.files.length} 个已读取的文件；请检查数据目录后刷新重试。`);
  }
  if (state.persistenceIssue) errorMessages.push(state.persistenceIssue);
  messages.push(...errorMessages);
  notice.textContent = messages.join(' ');
  notice.hidden = messages.length === 0;
  notice.classList.toggle('is-neutral', errorMessages.length === 0);
}

function renderRecordSummary(n) {
  const summary = document.getElementById('record-summary');
  if (!state.todayResolved) {
    summary.classList.add('is-empty');
    summary.textContent = '正在确认今天的记录…';
    return;
  }
  if (n === 0) {
    summary.classList.add('is-empty');
    summary.textContent = state.recordSource === 'cache'
      ? '上次读取时，今天还没有记录'
      : '今天还没有记录';
  } else {
    summary.classList.remove('is-empty');
    const prefix = state.recordSource === 'cache' ? '上次读取：今天留下了' : '今天留下了';
    summary.innerHTML = `<span>${prefix} <strong>${n}</strong> 条记录</span>`;
  }
}

// 把所有 entries 聚合成 { 'YYYY-MM-DD': count }
function buildEntriesByDay() {
  const byDay = {};
  for (const e of state.allEntries) {
    byDay[e.date] = (byDay[e.date] || 0) + 1;
  }
  return byDay;
}

function dateOffset(baseDateStr, deltaDays) {
  const d = new Date(baseDateStr + 'T00:00:00');
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderStats() {
  const byDay = buildEntriesByDay();
  let weekCount = 0;
  let activeDays = 0;
  for (let i = 0; i < 7; i++) {
    const dateStr = dateOffset(state.todayDate, -i);
    const n = byDay[dateStr] || 0;
    weekCount += n;
    if (n > 0) activeDays++;
  }
  document.getElementById('stats').innerHTML =
    `本周 <strong>${weekCount}</strong> 条 · ` +
    `近 7 天有记录 <strong>${activeDays}</strong> 天`;
}

function renderHeatmap() {
  const byDay = buildEntriesByDay();
  const cells = [];
  // 89 天前 → 今天,共 90 格
  for (let i = 89; i >= 0; i--) {
    const dateStr = dateOffset(state.todayDate, -i);
    const count = byDay[dateStr] || 0;
    // 阈值划档: 0 / 1-3 / 4-7 / 8-15 / 16+
    const level = count === 0 ? 0
                : count <= 3 ? 1
                : count <= 7 ? 2
                : count <= 15 ? 3 : 4;
    const cls = level === 0 ? '' : ` l${level}`;
    cells.push(`<span class="heat-cell${cls}" title="${dateStr} · ${count} 条"></span>`);
  }
  document.getElementById('heatmap').innerHTML = cells.join('');
}

function renderSectionDivider() {
  const today = state.todayDate;
  // JS 周一=1,周日=0;映射到中文
  const d = new Date(today + 'T00:00:00');
  const idx = (d.getDay() + 6) % 7; // 周一=0
  const wd = '一二三四五六日'[idx];
  document.querySelector('#section-today span').textContent = `今日 · ${today} · 周${wd}`;
}

function renderChips() {
  const chips = document.getElementById('chips');
  const tagCounts = state.todayEntries.reduce((a, e) => {
    if (e.tag) a[e.tag] = (a[e.tag] || 0) + 1;
    return a;
  }, {});
  const items = [
    { key: 'all',      label: `全部记录 · ${state.todayEntries.length}` },
    { key: '灵感',     label: `#灵感 · ${tagCounts['灵感'] || 0}` },
    { key: '下次再读', label: `#下次再读 · ${tagCounts['下次再读'] || 0}` },
    { key: 'TODO',     label: `#TODO · ${tagCounts.TODO || 0}` },
  ];

  chips.innerHTML = items.map(({ key, label }) => {
    const isOn = state.currentFilter === key;
    const cls = `chip ${isOn ? 'is-on' : 'is-off'}`;
    return `<button class="${cls}" data-filter="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
  }).join('');

  chips.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      state.currentFilter = b.dataset.filter;
      renderChips();
      renderEntryList();
    });
  });
}

function renderEntryList() {
  const list = document.getElementById('entry-list');
  const filtered = state.todayEntries
    .filter(e => state.currentFilter === 'all' || e.tag === state.currentFilter)
    .sort(window.MementoDashboardOperations.compareEntriesNewestFirst);

  if (filtered.length === 0) {
    const text = !state.todayResolved
      ? '正在确认今天的记录…'
      : state.todayEntries.length === 0
        ? (state.recordSource === 'cache' ? '上次读取时，今天还没有记录' : '今天还没有记录')
        : '这个分类下还没有记录';
    list.innerHTML = `<div class="empty-state">${text}</div>`;
    return;
  }

  list.innerHTML = filtered.map(renderEntry).join('');
}

function renderEntry(e) {
  const metaParts = [`<span class="entry-time">${escapeHtml(e.time)}</span>`];
  if (e.source) metaParts.push(escapeHtml(e.source));
  if (e.tag) metaParts.push(`<span class="entry-tag">#${escapeHtml(e.tag)}</span>`);

  const noteBlock = e.note
    ? `<div class="entry-note">备注: ${escapeHtml(e.note)}</div>`
    : '';

  return `
    <article class="entry">
      <div class="entry-meta">${metaParts.join(' ')}</div>
      <div class="entry-body">${renderMarkdown(e.body)}</div>
      ${noteBlock}
    </article>
  `;
}

// ----- Prompt 双轴 (A 时间段 × B 风格) -----

// CTA 按钮文字:复制 [时间段] 的 [风格] → AI
function defaultCtaLabel() {
  const range = findRange(state.selectedRange);
  const style = findStyle(state.selectedStyle);
  return style
    ? `复制 ${range.label} 的 ${style.label} → AI`
    : `复制 ${range.label} → AI`;
}

function visibleCtaLabel() {
  const range = findRange(state.selectedRange);
  const style = findStyle(state.selectedStyle);
  return style
    ? `复制当前显示的${range.label} · ${style.label} → AI`
    : `复制当前显示的${range.label} → AI`;
}

function selectedRangeCopyMode() {
  const range = findRange(state.selectedRange);
  return window.MementoDashboardOperations.copyModeForRecordState({
    recordSource: state.recordSource,
    todayResolved: state.todayResolved,
    rangeDays: range.days,
  });
}

function updateCtaLabel() {
  const btn = document.getElementById('copy-btn');
  const label = btn.querySelector('.btn-label');
  const mode = selectedRangeCopyMode();
  btn.disabled = mode === 'blocked';
  btn.dataset.copyMode = mode;
  btn.title = mode === 'visible'
    ? '当前显示的是上次完整记录；今天最新内容仍在后台核对。'
    : mode === 'blocked'
      ? '正在读取今天的记录'
      : '';
  label.textContent = mode === 'fresh'
    ? defaultCtaLabel()
    : mode === 'visible'
      ? visibleCtaLabel()
      : '正在读取今天的记录…';
}

// 填充 A 时间段下拉
function populateRangeSelect() {
  const sel = document.getElementById('range-select');
  if (!sel || !window.MEMENTO_RANGES) return;
  sel.innerHTML = window.MEMENTO_RANGES
    .map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`).join('');
  sel.value = state.selectedRange;
  sel.onchange = () => {
    state.selectedRange = sel.value;
    setSavedRange(state.selectedRange);
    updateCtaLabel();
  };
}

// 填充 B 风格下拉(不含彩蛋)
function populateStyleSelect() {
  const sel = document.getElementById('style-select');
  if (!sel || !window.MEMENTO_STYLES) return;
  const opts = window.MEMENTO_STYLES
    .filter(p => !p.hidden)
    .map(p => `<option value="${escapeHtml(p.id)}">${p.n} · ${escapeHtml(p.label)}</option>`);
  sel.innerHTML = '<option value="">不附</option>' + opts.join('');
  sel.value = state.selectedStyle || '';
  sel.onchange = () => {
    state.selectedStyle = sel.value || null;
    setSavedStyle(state.selectedStyle);
    updateCtaLabel();
  };
}

function populateSelectors() {
  populateRangeSelect();
  populateStyleSelect();
  updateCtaLabel();
}

// 按 A 时间段拼接 md。days=1 只取今天;多天往前回溯,带 `# === 日期 ===` 分隔。
function assembleRangeMd(days) {
  if (days <= 1) return state.todayFileText || '';
  const lines = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = dateOffset(state.todayDate, -i);
    const file = state.files.find(f => f.date === date);
    if (file) {
      lines.push('', `# === ${date} ===`, '', file.text);
    }
  }
  return lines.join('\n').trim();
}

// 组装最终剪贴板内容:[风格 prompt] + 【时间范围】标注 + md。styleId 为空则只给纯 md。
function buildClipboardText(rangeId, styleId) {
  const range = findRange(rangeId);
  const style = findStyle(styleId);
  const md = assembleRangeMd(range.days);
  if (!md) return { text: null, range, style };
  const body = `【时间范围:${range.label}】\n\n${md}`;
  const text = style ? `${style.text}\n\n---\n\n${body}` : body;
  return { text, range, style };
}

function clipboardTextForCopyMode(text, mode) {
  if (mode !== 'visible') return text;
  const status = state.recordSource === 'partial' && state.todayResolved
    ? '【数据状态：今天已同步；所选范围的历史记录仍在后台核对】'
    : '【数据状态：当前显示的是上次完整记录；今天最新内容仍在后台核对】';
  return `${status}\n\n${text}`;
}

async function copyCombo() {
  const btn = document.getElementById('copy-btn');
  const label = btn.querySelector('.btn-label');
  const restore = () => updateCtaLabel();

  let copyMode = selectedRangeCopyMode();
  if (copyMode === 'blocked') {
    updateCtaLabel();
    return;
  }
  const context = captureActiveDirectoryContext();
  if (!context || !await ensureCopyPermission(context)) return;
  if (!directoryContextStillCurrent(context)) return;
  copyMode = selectedRangeCopyMode();
  if (copyMode === 'blocked') return;

  const { text, range, style } = buildClipboardText(state.selectedRange, state.selectedStyle);
  if (!text) {
    label.textContent = range.days <= 1 ? '今天还没记任何东西' : `${range.label}没有任何记录`;
    setTimeout(restore, 1800);
    return;
  }

  try {
    if (!directoryContextStillCurrent(context)) return;
    await navigator.clipboard.writeText(clipboardTextForCopyMode(text, copyMode));
    if (!directoryContextStillCurrent(context)) return;
    label.textContent = copyMode === 'visible'
      ? '✓ 已复制当前显示内容 · ⌘V 粘到 AI'
      : style
        ? `✓ ${range.label} · ${style.label} · ⌘V 粘到 AI`
        : `✓ ${range.label} · ⌘V 粘到 AI`;
    setTimeout(restore, 2200);
  } catch (err) {
    console.error(err);
    label.textContent = '复制失败,请重试';
    setTimeout(restore, 1800);
  }
}

function bindCopyButton() {
  const btn = document.getElementById('copy-btn');
  btn.onclick = copyCombo;
  updateCtaLabel();
}

function captureActiveDirectoryContext() {
  const session = activeCoreLoad;
  if (!session
      || !directoryLoadGate.isCurrent(session.generation)
      || session.selectionEpoch !== selectionEpoch
      || state.dirHandle !== session.handle) return null;
  return {
    session,
    generation: session.generation,
    selectionEpoch,
    handle: session.handle,
  };
}

function directoryContextStillCurrent(context) {
  return Boolean(context
    && activeCoreLoad === context.session
    && directoryLoadGate.isCurrent(context.generation)
    && selectionEpoch === context.selectionEpoch
    && state.dirHandle === context.handle);
}

async function ensureCopyPermission(context) {
  if (!directoryContextStillCurrent(context)) return false;
  try {
    const access = window.MementoDirectoryAccess;
    const storedHandle = access && access.withTimeout
      ? await access.withTimeout(loadHandle, STORAGE_OPERATION_TIMEOUT_MS, '确认当前数据目录')
      : await loadHandle();
    if (!directoryContextStillCurrent(context)) return false;
    const matchesCurrentSelection = Boolean(storedHandle
      && await context.handle.isSameEntry(storedHandle));
    if (!directoryContextStillCurrent(context)) return false;
    if (!matchesCurrentSelection) {
      retireActiveCoreLoad();
      if (!storedHandle) {
        showAccessResult({ kind: 'missing' });
      } else {
        showPersistedSelectionChanged(storedHandle);
      }
      return false;
    }

    const permission = await queryRead(context.handle);
    if (!directoryContextStillCurrent(context)) return false;
    if (permission === 'granted') {
      // A different tab can commit a new directory between the first identity
      // check and the permission continuation. Re-read once at the final copy
      // boundary so a not-yet-delivered BroadcastChannel task cannot leak the
      // previous directory into the clipboard.
      const latestStoredHandle = access && access.withTimeout
        ? await access.withTimeout(loadHandle, STORAGE_OPERATION_TIMEOUT_MS, '再次确认当前数据目录')
        : await loadHandle();
      if (!directoryContextStillCurrent(context)) return false;
      const stillSelected = Boolean(latestStoredHandle
        && await context.handle.isSameEntry(latestStoredHandle));
      if (!directoryContextStillCurrent(context)) return false;
      if (!stillSelected) {
        retireActiveCoreLoad();
        if (latestStoredHandle) showPersistedSelectionChanged(latestStoredHandle);
        else showAccessResult({ kind: 'missing' });
        return false;
      }
      return true;
    }
    rememberedDirectoryHandle = context.handle;
    retireActiveCoreLoad();
    setRegrantUI(permission, context.handle, context.session.contextPromise);
  } catch (error) {
    console.warn('复制前无法确认当前目录与权限', error);
    if (directoryContextStillCurrent(context)) {
      retireActiveCoreLoad();
      showAccessResult({ kind: 'permission-check-error', handle: context.handle, error });
    }
  }
  return false;
}

// ----- Easter egg (记忆卡片 · 彩蛋,也吃 A 时间段) -----

function bindEasterEgg() {
  const btn = document.getElementById('easter-egg');
  if (!btn) return;
  const style = findStyle('card');
  btn.title = style ? 'Memento 模式 · 5 张记忆卡片' : '';
  btn.onclick = copyEasterEgg;
}

async function copyEasterEgg() {
  const btn = document.getElementById('easter-egg');
  const photo = btn.querySelector('.egg-photo');
  const orig = photo.textContent;
  const reset = () => photo.textContent = orig;

  let copyMode = selectedRangeCopyMode();
  if (!findStyle('card') || copyMode === 'blocked') return;
  const context = captureActiveDirectoryContext();
  if (!context || !await ensureCopyPermission(context)) return;
  if (!directoryContextStillCurrent(context)) return;
  copyMode = selectedRangeCopyMode();
  if (copyMode === 'blocked') return;

  // 彩蛋复用当前选中的时间段(本周/本月的卡片更有回忆价值)
  const { text } = buildClipboardText(state.selectedRange, 'card');
  if (!text) {
    photo.textContent = '?';
    setTimeout(reset, 1500);
    return;
  }

  try {
    if (!directoryContextStillCurrent(context)) return;
    await navigator.clipboard.writeText(clipboardTextForCopyMode(text, copyMode));
    if (!directoryContextStillCurrent(context)) return;
    photo.textContent = '✓';
    btn.classList.add('flashed');
    setTimeout(() => { reset(); btn.classList.remove('flashed'); }, 2000);
  } catch (err) {
    console.error(err);
    photo.textContent = '!';
    setTimeout(reset, 1500);
  }
}

// =============================================================
// 5.5 右侧抽屉框架
// =============================================================

let activeDrawerId = null;
let lastDrawerTrigger = null;
let drawerShellInited = false;

function initDrawerShell() {
  if (drawerShellInited) return;
  drawerShellInited = true;

  document.getElementById('drawer-scrim').addEventListener('click', closeSideDrawers);
  document.addEventListener('keydown', (event) => {
    if (!activeDrawerId) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSideDrawers();
      return;
    }
    if (event.key !== 'Tab') return;

    const drawer = document.getElementById(activeDrawerId);
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!drawer.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function openSideDrawer(drawerId, triggerId) {
  initDrawerShell();
  if (activeDrawerId && activeDrawerId !== drawerId) closeSideDrawers(false);

  activeDrawerId = drawerId;
  lastDrawerTrigger = document.getElementById(triggerId);
  document.querySelectorAll('.side-drawer').forEach(drawer => {
    const isOpen = drawer.id === drawerId;
    drawer.classList.toggle('open', isOpen);
    drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  });
  document.querySelectorAll('.edge-tab').forEach(tab => {
    tab.setAttribute('aria-expanded', tab.id === triggerId ? 'true' : 'false');
  });
  document.getElementById('drawer-scrim').classList.add('open');
  document.body.classList.add('drawer-open');
  document.getElementById('app').inert = true;

  requestAnimationFrame(() => {
    const drawer = document.getElementById(drawerId);
    if (activeDrawerId !== drawerId || !drawer.classList.contains('open')) return;
    drawer.querySelector('.drawer-close')?.focus();
  });
}

function closeSideDrawers(restoreFocus = true) {
  const closingDrawerId = activeDrawerId;
  document.querySelectorAll('.side-drawer').forEach(drawer => {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  });
  document.querySelectorAll('.edge-tab').forEach(tab => tab.setAttribute('aria-expanded', 'false'));
  document.getElementById('drawer-scrim').classList.remove('open');
  document.body.classList.remove('drawer-open');
  document.getElementById('app').inert = false;
  activeDrawerId = null;

  if (closingDrawerId === 'archive-drawer') archiveRenderGeneration++;
  if (closingDrawerId === 'daily-summary-drawer') cancelPhotoRender();
  if (restoreFocus) lastDrawerTrigger?.focus();
  if (restoreFocus) lastDrawerTrigger = null;
}

// =============================================================
// 5.6 HTML 归档库 (右侧抽屉)
//     真实文件存 ~/AISecretary/.archives/*.html
//     看列表只用只读权限;上传/删除时才懒升级到读写
// =============================================================

const ARCHIVE_SUBDIR = '.archives';
const ARCHIVE_READ_CONCURRENCY = 3;
const ARCHIVE_TITLE_SCAN_BYTES = 256 * 1024;
const ARCHIVE_CACHE_DECISION_MS = 120;
let archivesInited = false;
let archiveRenderGeneration = 0;
const enqueueArchiveMutation = window.MementoDashboardOperations.createSerialQueue();
const archiveIndexState = {
  session: null,
  items: [],
  ready: false,
  source: 'none',
  liveVerified: false,
  refreshPromise: null,
  refreshId: 0,
  refreshMutationEpoch: -1,
  mutationEpoch: 0,
  cacheContext: null,
  cacheHydrationPromise: null,
};

function resetArchiveIndexState() {
  archiveIndexState.session = null;
  archiveIndexState.items = [];
  archiveIndexState.ready = false;
  archiveIndexState.source = 'none';
  archiveIndexState.liveVerified = false;
  archiveIndexState.refreshPromise = null;
  archiveIndexState.refreshId = 0;
  archiveIndexState.refreshMutationEpoch = -1;
  archiveIndexState.mutationEpoch = 0;
  archiveIndexState.cacheContext = null;
  archiveIndexState.cacheHydrationPromise = null;
}

function archiveReadContextStillCurrent(context) {
  return Boolean(context && directoryContextStillCurrent(context));
}

function ensureArchiveIndexSession(context) {
  if (!archiveReadContextStillCurrent(context)) return false;
  if (archiveIndexState.session === context.session) return true;
  resetArchiveIndexState();
  archiveIndexState.session = context.session;
  return true;
}

function normalizedArchiveItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter(item => item
      && typeof item.name === 'string'
      && !/[\\/\0]/.test(item.name)
      && /\.html?$/i.test(item.name))
    .map(item => ({
      name: item.name,
      title: typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : item.name.replace(/\.html?$/i, ''),
      mtime: Number.isSafeInteger(item.mtime) && item.mtime >= 0 ? item.mtime : 0,
      ...(item.handle ? { handle: item.handle } : {}),
    }))
    .sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name));
}

function installArchiveIndexItems(context, items, source, { liveVerified = false } = {}) {
  if (!ensureArchiveIndexSession(context)) return false;
  // A slow IndexedDB result may arrive after live enumeration has already
  // established the current directory contents. It may fill an empty state,
  // but it must never roll a live/partial list back to stale names.
  if (source === 'cache' && archiveIndexState.source !== 'none') return false;
  archiveIndexState.items = normalizedArchiveItems(items);
  archiveIndexState.ready = true;
  archiveIndexState.source = source;
  archiveIndexState.liveVerified = Boolean(liveVerified);
  updateArchiveIndexView();
  return true;
}

function primeArchiveIndexFromActiveSession() {
  const context = captureActiveDirectoryContext();
  if (!context || !ensureArchiveIndexSession(context)) return false;
  if (archiveIndexState.ready) return true;

  const cached = context.session.bootstrapArchiveIndex;
  if (!cached || !Array.isArray(cached.items)) return false;
  return installArchiveIndexItems(context, cached.items, 'cache');
}

function updateArchiveIndexItem(context, item) {
  if (!ensureArchiveIndexSession(context) || !item || !item.name) return false;
  const items = archiveIndexState.items.filter(current => current.name !== item.name);
  items.push(item);
  archiveIndexState.items = normalizedArchiveItems(items);
  archiveIndexState.ready = true;
  archiveIndexState.source = 'partial';
  updateArchiveIndexView();
  return true;
}

function applyArchiveIndexMutation(context, updateItems) {
  if (!ensureArchiveIndexSession(context) || typeof updateItems !== 'function') return false;
  archiveIndexState.mutationEpoch += 1;
  archiveIndexState.items = normalizedArchiveItems(updateItems([...archiveIndexState.items]));
  archiveIndexState.ready = true;
  archiveIndexState.source = 'partial';
  archiveIndexState.liveVerified = false;
  updateArchiveIndexView();
  persistArchiveIndex(context);
  return true;
}

async function resolveArchiveIndexCacheContext(context) {
  if (!dashboardCacheRepository || !archiveReadContextStillCurrent(context)) return null;
  if (archiveIndexState.session === context.session && archiveIndexState.cacheContext) {
    return archiveIndexState.cacheContext;
  }
  const session = context.session;
  const cacheContext = session.cacheContextReady
    ? session.cacheContext
    : await session.contextPromise;
  if (!archiveReadContextStillCurrent(context)
      || !cacheContext
      || !cacheContext.binding) return null;
  if (ensureArchiveIndexSession(context)) archiveIndexState.cacheContext = cacheContext;
  return cacheContext;
}

async function hydrateArchiveIndexCache(context) {
  if (!ensureArchiveIndexSession(context)) return false;
  if (archiveIndexState.ready) return true;
  if (archiveIndexState.cacheHydrationPromise) return archiveIndexState.cacheHydrationPromise;
  if (!dashboardCacheRepository) return false;
  const session = context.session;
  const hydrationPromise = (async () => {
    try {
      const cacheContext = await resolveArchiveIndexCacheContext(context);
      if (!cacheContext || !archiveReadContextStillCurrent(context)) return false;
      // The archive index is co-read with the core snapshot in the one startup
      // IndexedDB transaction. Reuse that result here; opening the drawer must
      // not launch a second metadata lookup before the live verification.
      session.bootstrapArchiveIndex = cacheContext.archiveIndex || null;
      if (!session.bootstrapArchiveIndex || !archiveReadContextStillCurrent(context)) return false;
      return installArchiveIndexItems(context, session.bootstrapArchiveIndex.items, 'cache');
    } catch (error) {
      console.warn('归档快速缓存不可用，将直接读取本地目录', error);
      return false;
    } finally {
      if (archiveIndexState.session === session
          && archiveIndexState.cacheHydrationPromise === hydrationPromise) {
        archiveIndexState.cacheHydrationPromise = null;
      }
    }
  })();
  archiveIndexState.cacheHydrationPromise = hydrationPromise;
  return hydrationPromise;
}

async function waitForArchiveIndexCache(hydrationPromise) {
  const access = window.MementoDirectoryAccess;
  if (!access || typeof access.withTimeout !== 'function') return hydrationPromise;
  try {
    return await access.withTimeout(
      () => hydrationPromise,
      ARCHIVE_CACHE_DECISION_MS,
      '等待归档列表缓存'
    );
  } catch (error) {
    if (error && error.name === 'TimeoutError') return false;
    throw error;
  }
}

function persistArchiveIndex(context) {
  if (!dashboardCacheRepository
      || typeof dashboardCacheRepository.commitArchiveIndex !== 'function'
      || !archiveReadContextStillCurrent(context)) return;
  const items = archiveIndexState.items.map(({ name, title, mtime }) => ({ name, title, mtime }));
  void resolveArchiveIndexCacheContext(context)
    .then(cacheContext => cacheContext
      ? dashboardCacheRepository.commitArchiveIndex(cacheContext.binding.token, items)
      : null
    )
    .catch(error => console.warn('归档列表缓存保存失败，下次将继续实时读取', error));
}

function setArchiveStatus(message = '', isError = false) {
  const status = document.getElementById('archive-status');
  status.textContent = message;
  status.classList.toggle('is-error', Boolean(message) && isError);
}

function archiveErrorMessage(error, action = '读取') {
  const kind = window.MementoDashboardOperations.errorKind(error);
  if (kind === 'permission') return `归档${action}失败：数据目录权限已失效，请刷新页面后重新允许访问。`;
  if (kind === 'missing') return `归档${action}失败：数据目录或归档文件已移动。`;
  return `归档${action}失败：${shortError(error)}`;
}

async function runArchiveAction(task, action) {
  try {
    return await task();
  } catch (error) {
    console.error(`归档${action}失败`, error);
    setArchiveStatus(archiveErrorMessage(error, action), true);
    return null;
  }
}

function archiveMutationStillCurrent(context) {
  return Boolean(context
    && context.selectionEpoch === selectionEpoch
    && context.handle
    && state.dirHandle === context.handle);
}

async function archiveContextMatchesPersisted(context) {
  if (!archiveMutationStillCurrent(context)) return false;
  const access = window.MementoDirectoryAccess;
  const storedHandle = access && access.withTimeout
    ? await access.withTimeout(loadHandle, STORAGE_OPERATION_TIMEOUT_MS, '确认归档数据目录')
    : await loadHandle();
  if (!archiveMutationStillCurrent(context) || !storedHandle) return false;
  const matches = await context.handle.isSameEntry(storedHandle);
  return Boolean(archiveMutationStillCurrent(context) && matches);
}

function reconcileArchiveSelectionMismatch(context) {
  if (!archiveMutationStillCurrent(context)) return;
  setArchiveStatus('数据目录已在另一页面切换，归档操作已取消。', true);
  void reloadPersistedSelectionAfterBroadcast()
    .catch(error => console.warn('无法同步归档所用的数据目录', error));
}

function runArchiveMutation(task, action) {
  const context = { selectionEpoch, handle: state.dirHandle };
  return enqueueArchiveMutation(() => {
    if (!archiveMutationStillCurrent(context)) return null;
    return runArchiveAction(() => task(context), action);
  });
}

function withArchiveMutationLock(task) {
  // Directory selection commits and archive writes share this cross-tab
  // critical section. Ordinary reads deliberately do not use the lock.
  return window.MementoDashboardOperations.withArchiveMutationLock(navigator.locks, task);
}

async function ensureWritePermission(h = state.dirHandle) {
  if (!h) return false;
  if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function getArchiveDir(create = false, h = state.dirHandle) {
  if (!h) return null;
  try {
    return await h.getDirectoryHandle(ARCHIVE_SUBDIR, { create });
  } catch (error) {
    if (!create && error && error.name === 'NotFoundError') return null;
    throw error;
  }
}

const archiveReadQueue = [];
let archiveReadActive = 0;

function pumpArchiveReadQueue() {
  while (archiveReadActive < ARCHIVE_READ_CONCURRENCY && archiveReadQueue.length) {
    const queued = archiveReadQueue.shift();
    if (!queued.shouldStart()) {
      queued.resolve({ skipped: true });
      continue;
    }
    archiveReadActive++;
    Promise.resolve()
      .then(queued.task)
      .then(queued.resolve, error => queued.resolve({ error }))
      .finally(() => {
        archiveReadActive--;
        pumpArchiveReadQueue();
      });
  }
}

function scheduleArchiveRead(task, shouldStart) {
  return new Promise(resolve => {
    archiveReadQueue.push({ task, shouldStart, resolve });
    pumpArchiveReadQueue();
  });
}

async function enumerateArchiveEntries(context) {
  if (!archiveReadContextStillCurrent(context)) return null;
  const dir = await getArchiveDir(false, context.handle);
  if (!dir) return [];
  const entries = [];
  const iterator = dir.entries()[Symbol.asyncIterator]();
  while (true) {
    if (!archiveReadContextStillCurrent(context)) return null;
    const next = await iterator.next();
    if (!archiveReadContextStillCurrent(context)) return null;
    if (next.done) break;
    const [name, entry] = next.value;
    if (entry.kind === 'file' && /\.html?$/i.test(name)) entries.push({ name, handle: entry });
  }
  return entries;
}

function notifyArchiveItem(callback, item) {
  if (typeof callback !== 'function') return;
  try {
    callback(item);
  } catch (error) {
    console.warn('无法渐进更新归档条目', error);
  }
}

async function readArchiveItems(entries, options = {}) {
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const cachedByName = new Map((Array.isArray(options.cachedItems) ? options.cachedItems : [])
    .filter(item => item && item.name)
    .map(item => [item.name, item]));
  let permissionFailure = null;
  const results = await Promise.all(entries.map(item =>
    scheduleArchiveRead(async () => {
      if (permissionFailure || !isCurrent()) return { skipped: true };
      let file = null;
      try {
        file = await item.handle.getFile();
        if (permissionFailure || !isCurrent()) return { skipped: true };
        const mtime = Number(file.lastModified) || 0;
        const cached = cachedByName.get(item.name);
        let title = cached && cached.mtime === mtime ? cached.title : '';
        if (!title) {
          const titleSource = typeof file.slice === 'function'
            ? file.slice(0, ARCHIVE_TITLE_SCAN_BYTES)
            : file;
          const text = await titleSource.text();
          if (permissionFailure || !isCurrent()) return { skipped: true };
          title = extractTitle(text, item.name.replace(/\.html?$/i, ''));
        }
        const resolved = { ...item, mtime, title };
        notifyArchiveItem(options.onItem, resolved);
        return { item: resolved };
      } catch (error) {
        const kind = window.MementoDashboardOperations.errorKind(error);
        if (kind === 'permission') {
          permissionFailure = error;
          return { error, permissionLost: true };
        }
        if (kind !== 'missing') {
          const cached = cachedByName.get(item.name);
          const fallback = {
            ...item,
            mtime: file ? Number(file.lastModified) || 0 : Number(cached && cached.mtime) || 0,
            title: cached && cached.title || item.name.replace(/\.html?$/i, ''),
          };
          notifyArchiveItem(options.onItem, fallback);
          return { item: fallback };
        }
        return { skipped: true };
      }
    }, () => !permissionFailure && isCurrent())
  ));
  if (!isCurrent()) return null;
  if (permissionFailure) throw permissionFailure;
  return results.map(result => result.item).filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

async function refreshArchiveIndex(context, isRefreshCurrent) {
  const entries = await enumerateArchiveEntries(context);
  if (!entries || !isRefreshCurrent()) return null;

  const cachedByName = new Map(archiveIndexState.items.map(item => [item.name, item]));
  const visibleItems = entries.map(entry => {
    const cached = cachedByName.get(entry.name);
    return {
      ...entry,
      title: cached && cached.title || entry.name.replace(/\.html?$/i, ''),
      mtime: cached && cached.mtime || 0,
    };
  });
  if (!isRefreshCurrent()) return null;
  installArchiveIndexItems(context, visibleItems, 'partial');
  // Persist the useful filename-level result now. A single title read may
  // never settle in Chrome; it must not prevent the next tab from receiving
  // an immediate archive list. The completed pass will replace this index
  // with exact mtimes/titles when available.
  persistArchiveIndex(context);
  // Once filenames are visible, title verification is optional background
  // work. Do not leave the whole drawer looking stuck because one broker call
  // remains pending; an individual unresolved row already says “正在核对”.
  if (activeDrawerId === 'archive-drawer') setArchiveStatus('');

  if (!entries.length) {
    installArchiveIndexItems(context, [], 'live', { liveVerified: true });
    persistArchiveIndex(context);
    return [];
  }

  const items = await readArchiveItems(entries, {
    cachedItems: visibleItems,
    isCurrent: isRefreshCurrent,
    onItem: item => {
      if (isRefreshCurrent()) updateArchiveIndexItem(context, item);
    },
  });
  if (!items || !isRefreshCurrent()) return null;
  installArchiveIndexItems(context, items, 'live', { liveVerified: true });
  if (activeDrawerId === 'archive-drawer') setArchiveStatus('');
  persistArchiveIndex(context);
  return items;
}

function startArchiveIndexRefresh(context, { force = false } = {}) {
  if (!ensureArchiveIndexSession(context)) return null;
  // Reuse one in-flight traversal even after a local mutation. The mutation is
  // already reflected optimistically; spawning another pass could duplicate a
  // Chrome broker request that is itself permanently pending and consume all
  // three read slots.
  if (archiveIndexState.refreshPromise) return archiveIndexState.refreshPromise;
  if (archiveIndexState.liveVerified && !force) return Promise.resolve(archiveIndexState.items);

  archiveIndexState.liveVerified = false;
  const refreshId = archiveIndexState.refreshId + 1;
  const refreshMutationEpoch = archiveIndexState.mutationEpoch;
  archiveIndexState.refreshId = refreshId;
  archiveIndexState.refreshMutationEpoch = refreshMutationEpoch;
  const isRefreshCurrent = () => archiveReadContextStillCurrent(context)
    && archiveIndexState.session === context.session
    && archiveIndexState.refreshId === refreshId
    && archiveIndexState.mutationEpoch === refreshMutationEpoch;
  const refreshPromise = refreshArchiveIndex(context, isRefreshCurrent)
    .catch(error => {
      if (!isRefreshCurrent()) return null;
      console.error('归档后台核对失败', error);
      if (activeDrawerId === 'archive-drawer') {
        if (archiveIndexState.ready) {
          setArchiveStatus(`${archiveErrorMessage(error, '核对')} 继续显示上次列表。`, true);
        } else {
          updateArchiveIndexView();
          setArchiveStatus(archiveErrorMessage(error, '读取'), true);
        }
      }
      return null;
    })
    .finally(() => {
      if (archiveIndexState.session === context.session
          && archiveIndexState.refreshId === refreshId
          && archiveIndexState.refreshPromise === refreshPromise) {
        archiveIndexState.refreshPromise = null;
        archiveIndexState.refreshMutationEpoch = -1;
      }
    });
  archiveIndexState.refreshPromise = refreshPromise;
  return refreshPromise;
}

function extractTitle(htmlText, fallback) {
  const t = htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].replace(/\s+/g, ' ').trim()) return t[1].replace(/\s+/g, ' ').trim();
  const h = htmlText.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h) {
    const s = h[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (s) return s;
  }
  return fallback;
}

function fmtArchiveDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function flashDrop(msg) {
  const drop = document.getElementById('archive-drop');
  const t = drop.querySelector('.ad-text');
  const orig = t.innerHTML;
  t.textContent = msg;
  setTimeout(() => { t.innerHTML = orig; }, 1800);
}

async function saveArchiveFiles(fileList, context) {
  const operations = window.MementoDashboardOperations;
  const files = [...(fileList || [])].filter(file => operations.isArchiveHtmlName(file.name));
  if (!files.length) { flashDrop('只接受 .html 文件'); return; }

  if (!(await ensureWritePermission(context.handle))) {
    setArchiveStatus('未获得读写授权，归档未保存。', true);
    return;
  }
  if (!archiveMutationStillCurrent(context)) return;

  let saved = 0;
  let renamed = 0;
  let failed = 0;
  let fatalError = null;
  let selectionMismatch = false;
  const savedItems = [];
  await withArchiveMutationLock(async () => {
    if (!archiveMutationStillCurrent(context)) return;
    if (!await archiveContextMatchesPersisted(context)) {
      selectionMismatch = archiveMutationStillCurrent(context);
      return;
    }
    // The directory and its contents may have changed in another tab while
    // this tab was waiting. Re-read both only after acquiring the shared lock.
    const dir = await getArchiveDir(true, context.handle);
    if (!dir) throw new Error('无法创建 .archives 目录');

    const existingNames = new Set();
    for await (const [name] of dir.entries()) existingNames.add(name);

    // Keep the whole batch in one critical section: otherwise another tab
    // could claim a later name between two files from this drop.
    for (const file of files) {
      if (!archiveMutationStillCurrent(context)) return;
      try {
        const saveName = operations.uniqueArchiveName(file.name, existingNames);
        const fh = await dir.getFileHandle(saveName, { create: true });
        const w = await fh.createWritable();
        await w.write(file);
        await w.close();
        existingNames.add(saveName);
        savedItems.push({
          name: saveName,
          title: saveName.replace(/\.html?$/i, ''),
          mtime: Date.now(),
          handle: fh,
        });
        if (saveName !== file.name) renamed++;
        saved++;
      } catch (error) {
        failed++;
        console.error('写入归档文件失败', error);
        const kind = operations.errorKind(error);
        if (kind === 'permission' || kind === 'missing') {
          fatalError = error;
          break;
        }
      }
    }
  });

  if (selectionMismatch) {
    reconcileArchiveSelectionMismatch(context);
    return;
  }
  if (!archiveMutationStillCurrent(context)) return;

  flashDrop(saved ? `已存入 ${saved} 份` : '存档失败');
  const details = [];
  if (renamed) details.push(`${renamed} 份同名文件已自动改名`);
  if (failed) details.push(`${failed} 份写入失败`);
  const directoryContext = captureActiveDirectoryContext();
  if (savedItems.length && directoryContext) {
    applyArchiveIndexMutation(directoryContext, currentItems => {
      const savedNames = new Set(savedItems.map(item => item.name));
      return currentItems.filter(item => !savedNames.has(item.name)).concat(savedItems);
    });
    if (activeDrawerId === 'archive-drawer') {
      void startArchiveIndexRefresh(directoryContext, { force: true });
    }
  } else if (activeDrawerId === 'archive-drawer') {
    void renderArchives({ forceRefresh: true });
  }
  if (archiveMutationStillCurrent(context) && details.length) {
    setArchiveStatus(details.join('；'), failed > 0);
  }
  if (fatalError) throw fatalError;
}

function updateArchiveIndexView() {
  const list = document.getElementById('archive-list');
  const countEl = document.getElementById('archive-count');
  if (!list || !countEl) return;
  const items = archiveIndexState.items;
  countEl.textContent = items.length ? String(items.length) : '';

  // The badge can update while the drawer is closed, but rebuilding the hidden
  // list would do work the user cannot see and could disturb a later focus restore.
  if (activeDrawerId !== 'archive-drawer') return;

  if (!archiveIndexState.ready) {
    list.innerHTML = '<div class="archive-empty">正在准备归档列表…</div>';
    return;
  }

  if (!items.length) {
    list.innerHTML = `<div class="archive-empty">还没有归档。<br>把 AI 整理好的 HTML 拖进来。</div>`;
    return;
  }

  list.innerHTML = items.map((it, i) => `
    <div class="archive-item" data-idx="${i}">
      <button type="button" class="archive-open" data-idx="${i}"
              aria-label="打开归档 ${escapeHtml(it.name.replace(/\.html?$/i, ''))}">
        <span class="ai-doc" aria-hidden="true">📄</span>
        <span class="ai-main">
          <span class="ai-title">${escapeHtml(it.title || it.name.replace(/\.html?$/i, ''))}</span>
          <span class="ai-meta">${it.mtime ? fmtArchiveDate(it.mtime) : '正在核对'}</span>
        </span>
        <span class="ai-open" aria-hidden="true" title="在新标签打开">↗</span>
      </button>
      <button type="button" class="ai-del" data-name="${escapeHtml(it.name)}"
              aria-label="删除归档 ${escapeHtml(it.name.replace(/\.html?$/i, ''))}" title="删除">✕</button>
    </div>`).join('');

  list.querySelectorAll('.archive-open').forEach(button => {
    button.addEventListener('click', () => {
      const context = captureActiveDirectoryContext();
      if (!context) return;
      void runArchiveAction(() => openArchive(items[+button.dataset.idx], context), '打开');
    });
  });
  list.querySelectorAll('.ai-del').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const name = btn.dataset.name;
      if (!confirm(`删除归档「${name}」?(会从 .archives 目录移除)`)) return;
      void runArchiveMutation(async context => {
        if (!(await ensureWritePermission(context.handle))) {
          setArchiveStatus('未获得读写授权，归档未删除。', true);
          return;
        }
        if (!archiveMutationStillCurrent(context)) return;
        let selectionMismatch = false;
        await withArchiveMutationLock(async () => {
          if (!archiveMutationStillCurrent(context)) return;
          if (!await archiveContextMatchesPersisted(context)) {
            selectionMismatch = archiveMutationStillCurrent(context);
            return;
          }
          const dir = await getArchiveDir(false, context.handle);
          if (!dir) throw Object.assign(new Error('归档目录不存在'), { name: 'NotFoundError' });
          if (!archiveMutationStillCurrent(context)) return;
          await dir.removeEntry(name);
        });
        if (selectionMismatch) {
          reconcileArchiveSelectionMismatch(context);
          return;
        }
        if (!archiveMutationStillCurrent(context)) return;
        const directoryContext = captureActiveDirectoryContext();
        if (directoryContext) {
          applyArchiveIndexMutation(
            directoryContext,
            currentItems => currentItems.filter(item => item.name !== name)
          );
          if (activeDrawerId === 'archive-drawer') {
            setArchiveStatus('');
            void startArchiveIndexRefresh(directoryContext, { force: true });
          }
        } else if (activeDrawerId === 'archive-drawer') {
          void renderArchives({ forceRefresh: true });
        }
      }, '删除');
    });
  });
}

async function renderArchives({ forceRefresh = false } = {}) {
  const generation = ++archiveRenderGeneration;
  const context = captureActiveDirectoryContext();
  if (!context) {
    document.getElementById('archive-count').textContent = '';
    document.getElementById('archive-list').innerHTML =
      '<div class="archive-empty">归档暂时无法读取。<br>请恢复数据目录访问后重试。</div>';
    setArchiveStatus('归档读取失败：当前数据目录尚未就绪。', true);
    return;
  }

  ensureArchiveIndexSession(context);
  if (archiveIndexState.ready) {
    updateArchiveIndexView();
    // Cached content is already useful content. Freshness verification remains
    // silent unless it actually fails.
    setArchiveStatus('');
  }

  const operations = window.MementoDashboardOperations;
  if (!operations || typeof operations.startCacheFirstRefresh !== 'function') {
    throw new Error('归档快速启动模块未加载');
  }
  await operations.startCacheFirstRefresh({
    cacheFirst: true,
    hydrateCache: () => hydrateArchiveIndexCache(context),
    waitForCache: waitForArchiveIndexCache,
    hasVisibleContent: () => archiveIndexState.ready,
    shouldRefresh: () => forceRefresh || !archiveIndexState.liveVerified,
    showWaiting: () => {
      if (generation !== archiveRenderGeneration
          || activeDrawerId !== 'archive-drawer'
          || !archiveReadContextStillCurrent(context)) return;
      setArchiveStatus('正在读取归档…');
      updateArchiveIndexView();
    },
    afterFirstPaint: afterFirstDashboardPaint,
    startRefresh: () => startArchiveIndexRefresh(context, { force: forceRefresh }),
    isCurrent: () => generation === archiveRenderGeneration
      && activeDrawerId === 'archive-drawer'
      && archiveReadContextStillCurrent(context),
  });
}

// 点击归档 → 在独立 sandbox 页中预览。
// viewer 会先移除任意脚本、刷新/外链和嵌入内容，仅保留静态 HTML/CSS、
// details/summary 和页内锚点；避免 AI 生成的归档通过 location/meta refresh 绕过网络 CSP。
async function openArchive(item, context) {
  if (!archiveMutationStillCurrent(context)) return;
  // 在点击的用户激活尚有效时先打开窗口，再异步读文件。
  const viewer = window.open(chrome.runtime.getURL('viewer.html'), '_blank');
  if (!viewer) {
    setArchiveStatus('无法打开归档，请允许 Memento 打开新标签后重试。', true);
    return;
  }

  try {
    let fileHandle = item && item.handle;
    if (!fileHandle) {
      const dir = await getArchiveDir(false, context.handle);
      if (!dir) throw Object.assign(new Error('归档目录不存在'), { name: 'NotFoundError' });
      if (!archiveMutationStillCurrent(context)) {
        try { viewer.close(); } catch {}
        return;
      }
      // A cross-tab cache intentionally stores metadata only. Resolve exactly
      // the clicked file instead of traversing or re-reading the whole archive.
      fileHandle = await dir.getFileHandle(item.name);
    }
    const file = await fileHandle.getFile();
    const text = await file.text();
    if (!archiveMutationStillCurrent(context)) {
      try { viewer.close(); } catch {}
      return;
    }
    const send = () => {
      if (!archiveMutationStillCurrent(context)) return;
      try { viewer.postMessage({ type: 'memento-html', html: text }, '*'); } catch {}
    };
    const onMsg = (e) => {
      if (e.source !== viewer || !e.data || e.data.type !== 'memento-viewer-ready') return;
      send();
      window.removeEventListener('message', onMsg);
      clearTimeout(cleanupTimer);
    };
    window.addEventListener('message', onMsg);
    const cleanupTimer = setTimeout(() => window.removeEventListener('message', onMsg), 10000);
    // 兜底：即使错过 viewer 的第一次 ready 消息，也主动补发一次。
    setTimeout(send, 500);
  } catch (error) {
    try { viewer.close(); } catch {}
    throw error;
  }
}

function openDrawer() {
  openSideDrawer('archive-drawer', 'archive-tab');
  void runArchiveAction(renderArchives, '读取');
}
function closeDrawer() {
  closeSideDrawers();
}

function initArchives() {
  document.getElementById('archive-tab').hidden = false;
  // Only lightweight metadata is restored here. The directory and HTML files
  // remain untouched until the drawer's post-paint background verification.
  primeArchiveIndexFromActiveSession();
  const context = captureActiveDirectoryContext();
  if (context
      && archiveIndexState.session === context.session
      && archiveIndexState.ready) {
    updateArchiveIndexView();
  } else {
    document.getElementById('archive-count').textContent = '';
  }
  if (archivesInited) return;
  archivesInited = true;

  document.getElementById('archive-tab').addEventListener('click', openDrawer);
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);

  const drop = document.getElementById('archive-drop');
  const input = document.getElementById('archive-input');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    input.click();
  });
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    void runArchiveMutation(context => saveArchiveFiles(files, context), '保存');
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const files = [...e.dataTransfer.files];
    void runArchiveMutation(context => saveArchiveFiles(files, context), '保存');
  });
}

// =============================================================
// 5.7 每日总结 (当天第一帧 + Daily Review + 运行状态)
// =============================================================

let dailySummariesInited = false;
let selectedSummaryMonth = null;
const PHOTO_LOAD_CONCURRENCY = 3;
const PHOTO_CACHE_MAX_ENTRIES = 32;
const PHOTO_THUMBNAIL_MAX_WIDTH = 480;
const PHOTO_VIEWPORT_ROOT_MARGIN = '600px 0px';
const PHOTO_THUMBNAIL_VARIANT = 'w480-webp-q72-v1';
const PHOTO_PERSISTENT_DECISION_MS = 120;
let photoRenderGeneration = 0;
let photoViewportLoader = null;
let photoPermissionLost = false;
let photoPersistentReadDisabled = false;
let photoPersistentWriteDisabled = false;
let dailySummaryDataVersion = 0;
let dailySummaryRenderedVersion = -1;
let dailySummaryRenderedMonth = null;
let dailySummaryRenderedLayout = '';

function createPhotoThumbnailCanvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function encodePhotoThumbnailCanvas(canvas, { type, quality }) {
  if (canvas && typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    if (!canvas || typeof canvas.toBlob !== 'function') {
      reject(new Error('当前浏览器无法编码照片缩略图'));
      return;
    }
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('照片缩略图编码失败'));
    }, type, quality);
  });
}

const preparePhotoForDisplay = window.MementoPhotos.createThumbnailer({
  maxWidth: PHOTO_THUMBNAIL_MAX_WIDTH,
  type: 'image/webp',
  quality: 0.72,
  createImageBitmap: typeof window.createImageBitmap === 'function'
    ? window.createImageBitmap.bind(window)
    : null,
  createCanvas: createPhotoThumbnailCanvas,
  encodeCanvas: encodePhotoThumbnailCanvas,
  onError: error => console.warn('照片缩略图生成失败，将显示原图', error),
});

function photoCacheScopeIsCurrent(scope, isCurrent) {
  return Boolean(scope
    && isCurrent()
    && activeCoreLoad === scope.session
    && directoryLoadGate.isCurrent(scope.session.generation)
    && state.dirHandle === scope.session.handle);
}

async function resolvePhotoCacheScope(isCurrent) {
  if (!photoThumbnailCacheRepository || !isCurrent()) return null;
  const session = activeCoreLoad;
  if (!session
      || !directoryLoadGate.isCurrent(session.generation)
      || state.dirHandle !== session.handle) return null;

  let context = session.cacheContextReady ? session.cacheContext : null;
  if (!context) {
    try {
      const access = window.MementoDirectoryAccess;
      context = access && typeof access.withTimeout === 'function'
        ? await access.withTimeout(
            () => session.contextPromise,
            PHOTO_PERSISTENT_DECISION_MS,
            '等待照片缩略图缓存身份'
          )
        : await session.contextPromise;
    } catch (error) {
      if (error && error.name === 'TimeoutError') return null;
      throw error;
    }
  }
  if (!context || !context.binding || !photoCacheScopeIsCurrent({ session }, isCurrent)) return null;
  return { session, bindingToken: context.binding.token };
}

async function loadPersistentPhoto(record, isCurrent) {
  if (photoPersistentReadDisabled) return null;
  const scope = await resolvePhotoCacheScope(isCurrent);
  if (!scope) return null;
  const readThumbnail = () => photoThumbnailCacheRepository.get(
    scope.bindingToken,
    record.assetName,
    PHOTO_THUMBNAIL_VARIANT
  );
  const access = window.MementoDirectoryAccess;
  // IndexedDB is only an acceleration layer. If a browser/storage hiccup
  // keeps this optional read pending, fall back to the source photo instead
  // of turning the cache itself into a new loading bottleneck.
  const hit = access && typeof access.withTimeout === 'function'
    ? await access.withTimeout(
        readThumbnail,
        PHOTO_PERSISTENT_DECISION_MS,
        '读取照片缩略图缓存'
      )
    : await readThumbnail();
  if (!hit || !photoCacheScopeIsCurrent(scope, isCurrent)) return null;
  return {
    blob: hit.blob,
    sourceSize: hit.sourceSize,
    sourceLastModified: hit.sourceLastModified,
  };
}

async function storePersistentPhoto(thumbnail, sourceFile, record, isCurrent) {
  if (photoPersistentWriteDisabled
      || !thumbnail
      || thumbnail.type !== 'image/webp') return { stored: false, reason: 'ineligible' };
  const scope = await resolvePhotoCacheScope(isCurrent);
  if (!scope || !photoCacheScopeIsCurrent(scope, isCurrent)) {
    return { stored: false, reason: 'stale' };
  }
  return photoThumbnailCacheRepository.put({
    bindingToken: scope.bindingToken,
    assetName: record.assetName,
    variant: PHOTO_THUMBNAIL_VARIANT,
    blob: thumbnail,
    sourceSize: Number(sourceFile && sourceFile.size) || 0,
    sourceLastModified: Number(sourceFile && sourceFile.lastModified) || 0,
  });
}

async function deletePersistentPhoto(record) {
  if (!photoThumbnailCacheRepository || !record || !record.assetName) return;
  const scope = await resolvePhotoCacheScope(() => true);
  if (!scope || !photoCacheScopeIsCurrent(scope, () => true)) return;
  await photoThumbnailCacheRepository.delete(
    scope.bindingToken,
    record.assetName,
    PHOTO_THUMBNAIL_VARIANT
  );
}

const photoAssetLoader = window.MementoPhotos.createAssetLoader({
  concurrency: PHOTO_LOAD_CONCURRENCY,
  maxEntries: PHOTO_CACHE_MAX_ENTRIES,
  prepareFile: preparePhotoForDisplay,
  loadPersistent: loadPersistentPhoto,
  storePersistent: storePersistentPhoto,
  onPersistentError(error, record, stage) {
    if (stage === 'read') photoPersistentReadDisabled = true;
    if (stage === 'write') photoPersistentWriteDisabled = true;
    console.warn(`照片持久缓存${stage === 'read' ? '读取' : '写入'}失败，本页改用实时照片`, error, record);
  },
  createObjectURL: file => URL.createObjectURL(file),
  revokeObjectURL: url => URL.revokeObjectURL(url),
});

function cancelPhotoRender() {
  photoRenderGeneration++;
  if (photoViewportLoader) photoViewportLoader.stop();
  photoViewportLoader = null;
  document.querySelectorAll('.day-photo[data-photo-state="loading"]').forEach(figure => {
    figure.dataset.photoState = 'idle';
  });
}

function releasePhotoObjectUrls() {
  cancelPhotoRender();
  photoAssetLoader.clear();
  if (photoThumbnailCacheRepository) photoThumbnailCacheRepository.clearMemory();
  photoPermissionLost = false;
  photoPersistentReadDisabled = false;
  photoPersistentWriteDisabled = false;
  dailySummaryRenderedVersion = -1;
  dailySummaryRenderedMonth = null;
  dailySummaryRenderedLayout = '';
}

function markDailySummaryDataChanged() {
  dailySummaryDataVersion++;
}

function dailySummaryMonthKeys() {
  return [...new Set(state.dayCards.map(day => window.MementoDailySummaries.monthKey(day)).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a));
}

function formatSummaryMonth(month) {
  const match = String(month || '').match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : month;
}

function formatDayDate(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[2])}.${Number(match[3])}` : date;
}

function formatDayWeekday(day) {
  if (day.photo && day.photo.weekday) return day.photo.weekday;
  const parsed = new Date(`${day.dayKey}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return '';
  return `周${'日一二三四五六'[parsed.getDay()]}`;
}

function formatPhotoAlt(record) {
  const match = String(record.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const day = match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : record.date;
  return `${day} ${record.time} 的每日第一帧`;
}

function compactObservedTime(value) {
  const match = String(value || '').match(/T(\d{2}:\d{2})/);
  return match ? match[1] : String(value || '');
}

function photoContext(record) {
  const parts = [];
  if (record.timezone) parts.push(record.timezone);
  if (record.observedAt) parts.push(`天气 ${compactObservedTime(record.observedAt)}`);
  if (record.source) parts.push(`首条 ${record.source}`);
  return parts.join(' / ');
}

function renderSummaryMonthOptions() {
  const select = document.getElementById('daily-summary-month');
  const months = dailySummaryMonthKeys();
  if (!months.length) {
    selectedSummaryMonth = null;
    select.innerHTML = '<option>暂无总结</option>';
    select.disabled = true;
    return;
  }

  if (!selectedSummaryMonth || !months.includes(selectedSummaryMonth)) selectedSummaryMonth = months[0];
  select.disabled = false;
  select.innerHTML = months.map(month =>
    `<option value="${escapeHtml(month)}"${month === selectedSummaryMonth ? ' selected' : ''}>${escapeHtml(formatSummaryMonth(month))}</option>`
  ).join('');
}

function renderDailySummaryCount() {
  const count = state.dayCards.length;
  document.getElementById('daily-summary-count').textContent = count ? String(count) : '';
}

function dailySummaryStatusMessages() {
  return [
    state.reviewReadIssue,
    state.reviewStatusReadIssue,
    state.reviewPromptReadIssue,
  ].filter(Boolean);
}

function renderDailySummaryStatus(extraMessages = []) {
  document.getElementById('daily-summary-status').textContent = [
    ...dailySummaryStatusMessages(),
    ...extraMessages.filter(Boolean),
  ].join(' ');
}

function summaryPhotoLayout(day) {
  const photo = day && day.photo;
  return {
    dayKey: day && day.dayKey || '',
    assetName: photo && photo.assetName || '',
    time: photo && photo.time || '',
    weekday: photo && photo.weekday || '',
    weather: photo && photo.weather || '',
    timezone: photo && photo.timezone || '',
    observedAt: photo && photo.observedAt || '',
    source: photo && photo.source || '',
    issues: photo && photo.issues || [],
  };
}

function dailySummaryDaysForSelectedMonth() {
  return state.dayCards.filter(day => window.MementoDailySummaries.monthKey(day) === selectedSummaryMonth);
}

function dailySummaryLayoutSignature(days) {
  return JSON.stringify((days || []).map(summaryPhotoLayout));
}

function compactGeneratedTime(value) {
  const match = String(value || '').match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function meaningfulReviewText(value) {
  const text = String(value || '').trim();
  return text && text !== '无' ? text : '';
}

function reviewLead(review) {
  if (!review) return '';
  for (const key of ['scene', 'insights', 'personal', 'actionClues']) {
    const text = meaningfulReviewText(review.sections[key]);
    if (text) return text;
  }
  return '';
}

function reviewSectionMarkup(title, text) {
  const content = meaningfulReviewText(text);
  if (!content) return '';
  return `
    <section class="review-section">
      <h4>${escapeHtml(title)}</h4>
      <div class="review-section-body">${renderMarkdown(content)}</div>
    </section>`;
}

function fullReviewMarkup(review) {
  if (!review) return '';
  const sections = [
    ['工作与生活现场', review.sections.scene],
    ['灵感与想法', review.sections.insights],
    ['个人记录/情绪', review.sections.personal],
    ['行动线索', review.sections.actionClues],
    ['我的补充', review.sections.supplement],
    ['已忽略', review.sections.ignored],
  ].map(([title, text]) => reviewSectionMarkup(title, text)).join('');
  return sections || '<p class="review-format-note">这份总结没有可展示的正文。</p>';
}

function reviewStatus(day) {
  if (day.summaryStatus === 'failed') {
    return {
      tone: 'failed',
      text: '生成失败',
      title: day.reviewState && day.reviewState.message || '上次总结生成未完成',
    };
  }
  if (day.summaryStatus === 'stale') return { tone: 'updated', text: '记录有更新', title: '现有总结未包含当天最新记录' };
  if (day.summaryStatus === 'rebuild') {
    const issues = [
      ...(day.review && day.review.issues || []),
      ...(day.contractIssues || []),
    ];
    return { tone: 'updated', text: '待重建', title: issues.length ? issues.join('。') : '总结合同无法校验' };
  }
  if (day.summaryStatus === 'current') {
    const title = day.freshness === 'unknown'
      ? '总结已存在，但当前缺少来源哈希，暂时无法校验'
      : day.review && day.review.issues.length ? day.review.issues.join('。') : '';
    return { tone: 'current', text: '总结已更新', title };
  }
  return { tone: 'quiet', text: '待总结', title: '' };
}

function reviewStatusMarkup(status) {
  const title = status.title ? ` title="${escapeHtml(status.title)}"` : '';
  return `<p class="day-review-status is-${status.tone}"${title}>${escapeHtml(status.text)}</p>`;
}

function shouldOfferReviewRerun(day) {
  if (day.summaryStatus === 'failed' || day.summaryStatus === 'stale' || day.summaryStatus === 'rebuild') return true;
  return day.summaryStatus === 'pending' && day.dayKey < state.todayDate;
}

function reviewRerunMarkup(day) {
  if (!shouldOfferReviewRerun(day)) return '';
  return `<button type="button" class="day-review-rerun" data-review-rerun="${escapeHtml(day.dayKey)}">复制补跑指令</button>`;
}

function dailyReviewRerunPrompt(dayKey) {
  return `请在 ~/AISecretary 中为 Memento 补跑 ${dayKey} 的 Daily Review，严格按 .review/DAILY_REVIEW.md 执行并完成校验。`;
}

function bindDailyReviewRerunActions(container) {
  container.querySelectorAll('[data-review-rerun]').forEach(button => {
    button.addEventListener('click', async () => {
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(dailyReviewRerunPrompt(button.dataset.reviewRerun));
        button.textContent = '已复制，粘贴给 Codex';
      } catch (error) {
        console.error(error);
        button.textContent = '复制失败，请重试';
      }
      setTimeout(() => { button.textContent = original; }, 1800);
    });
  });
}

function dayReviewMarkup(day) {
  const status = reviewStatus(day);
  if (!day.review) {
    return `
      <section class="day-review is-empty">
        ${reviewStatusMarkup(status)}
        <h3>当天总结</h3>
        <p class="day-review-empty-copy">${day.summaryStatus === 'failed'
          ? '上次生成没有完成，原始记录仍然安全保留。'
          : '当天记录已经保留，总结生成后会显示在这里。'}</p>
        ${reviewRerunMarkup(day)}
      </section>`;
  }

  const lead = reviewLead(day.review);
  const generated = compactGeneratedTime(day.review.generatedAt);
  return `
    <section class="day-review">
      ${reviewStatusMarkup(status)}
      <h3>当天总结</h3>
      <div class="day-review-preview">${lead ? renderMarkdown(lead) : '<p>这份总结没有提取出明显主题。</p>'}</div>
      <details class="day-review-details">
        <summary>展开完整总结</summary>
        <div class="day-review-full">${fullReviewMarkup(day.review)}</div>
      </details>
      <p class="day-review-meta">${generated ? `生成于 ${escapeHtml(generated)}` : '生成时间未记录'}${day.review.sourceMock ? ' / 模拟来源' : ''}</p>
      ${reviewRerunMarkup(day)}
    </section>`;
}

function dayPhotoMarkup(day, index) {
  const record = day.photo;
  if (!record) return '';
  const context = photoContext(record);
  const issue = record.issues.length ? record.issues.join('。') : '';
  const photoState = record.assetName ? 'idle' : 'error';
  const media = record.assetName
    ? '<span class="day-photo-file-error">滚动到附近时加载照片</span>'
    : `<span class="day-photo-file-error">${escapeHtml(issue || '照片引用缺失')}</span>`;
  return `
    <figure class="day-photo" data-day-photo-index="${index}" data-photo-state="${photoState}" title="${escapeHtml(issue)}">
      <div class="day-photo-media">${media}</div>
      <figcaption class="day-photo-caption">
        <time datetime="${escapeHtml(`${record.date}T${record.time}`)}">${escapeHtml(record.time || '时间未记录')}</time>
        <p class="day-photo-weather">${escapeHtml(record.weather)}</p>
        ${context ? `<p class="day-photo-context">${escapeHtml(context)}</p>` : ''}
      </figcaption>
    </figure>`;
}

function dayCardMarkup(day, index) {
  const weekday = formatDayWeekday(day);
  const classes = day.photo ? 'day-card' : 'day-card has-no-photo';
  return `
    <article class="${classes}" data-day-index="${index}" data-day-key="${escapeHtml(day.dayKey)}">
      <header class="day-card-head">
        <time datetime="${escapeHtml(day.dayKey)}">${escapeHtml(formatDayDate(day.dayKey))}</time>
        ${weekday ? `<span>${escapeHtml(weekday)}</span>` : ''}
      </header>
      <div class="day-card-body">
        ${dayPhotoMarkup(day, index)}
        ${dayReviewMarkup(day)}
      </div>
    </article>`;
}

function setDayPhotoError(figure, message) {
  if (!figure) return;
  figure.dataset.photoState = 'error';
  const media = figure.querySelector('.day-photo-media');
  if (media) media.innerHTML = `<span class="day-photo-file-error">${escapeHtml(message)}</span>`;
}

function throwIfPhotoDirectoryChanged(isCurrent) {
  if (typeof isCurrent === 'function' && !isCurrent()) {
    const error = new Error('照片目录已经切换');
    error.name = 'AbortError';
    throw error;
  }
}

async function readDayPhotoFile(record, resolveAssetsDir, isCurrent) {
  throwIfPhotoDirectoryChanged(isCurrent);
  const assetsDir = await resolveAssetsDir();
  throwIfPhotoDirectoryChanged(isCurrent);
  const handle = await assetsDir.getFileHandle(record.assetName);
  throwIfPhotoDirectoryChanged(isCurrent);
  return handle.getFile();
}

async function renderDayPhotoAsset(record, figure, asset, generation, isCurrent = () => true) {
  if (!figure || !asset || !asset.url) return { ok: false, reason: '照片文件不可用' };
  const renderIsCurrent = () => generation === photoRenderGeneration
    && isCurrent()
    && figure.isConnected;
  try {
    if (!renderIsCurrent()) return { ok: false, stale: true };

    const img = document.createElement('img');
    img.alt = formatPhotoAlt(record);
    img.loading = 'eager';
    img.decoding = 'async';
    const media = figure.querySelector('.day-photo-media');
    media.replaceChildren(img);
    const legacyLoad = typeof img.decode !== 'function'
      ? new Promise((resolve, reject) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', reject, { once: true });
        })
      : null;
    img.src = asset.url;

    try {
      if (typeof img.decode === 'function') await img.decode();
      else await legacyLoad;
    } catch {
      if (!renderIsCurrent()) return { ok: false, stale: true };
      photoAssetLoader.deleteAsset(record, asset.url);
      void deletePersistentPhoto(record).catch(() => {});
      setDayPhotoError(figure, '图片无法显示');
      return { ok: false, reason: '图片无法显示' };
    }

    if (!renderIsCurrent()) return { ok: false, stale: true };
    figure.dataset.photoState = 'ready';
    return { ok: true };
  } catch (error) {
    const message = '图片无法显示';
    setDayPhotoError(figure, message);
    return { ok: false, reason: message, error };
  }
}

function canReuseRenderedDailySummary(days, layout) {
  return dailySummaryRenderedVersion === dailySummaryDataVersion
    && dailySummaryRenderedMonth === selectedSummaryMonth
    && dailySummaryRenderedLayout === layout
    && document.getElementById('daily-summary-list').childElementCount > 0;
}

function refreshDailySummaryOptionalView(options = {}) {
  if (activeDrawerId !== 'daily-summary-drawer') return false;
  renderSummaryMonthOptions();
  renderDailySummaryCount();
  renderDailySummaryStatus();

  const days = dailySummaryDaysForSelectedMonth();
  const layout = dailySummaryLayoutSignature(days);
  const list = document.getElementById('daily-summary-list');
  const cards = [...list.querySelectorAll('.day-card')];
  const sameLayout = dailySummaryRenderedMonth === selectedSummaryMonth
    && dailySummaryRenderedLayout === layout
    && cards.length === days.length
    && cards.every((card, index) => card.dataset.dayKey === days[index].dayKey);
  if (!sameLayout) {
    if (options.renderOnMismatch !== false) void renderDailySummaryList({ force: true });
    return false;
  }

  cards.forEach((card, index) => {
    const current = card.querySelector('.day-review');
    const template = document.createElement('template');
    template.innerHTML = dayReviewMarkup(days[index]).trim();
    const updated = template.content.firstElementChild;
    current.replaceWith(updated);
    bindDailyReviewRerunActions(updated);
  });
  document.getElementById('daily-summary-meta').textContent = `${days.length} 天`;
  dailySummaryRenderedVersion = dailySummaryDataVersion;
  return true;
}

function startDailySummaryPhotoViewport(days, generation) {
  const list = document.getElementById('daily-summary-list');
  const items = days
    .map((day, index) => ({ day, index }))
    .filter(item => item.day.photo && item.day.photo.assetName);
  if (!items.length) return;
  if (photoPermissionLost) {
    for (const item of items) {
      const figure = list.querySelector(`[data-day-index="${item.index}"] .day-photo`);
      if (figure && figure.dataset.photoState !== 'ready') setDayPhotoError(figure, '照片读取已暂停');
    }
    renderDailySummaryStatus(['照片访问权限已失效，请刷新页面并重新允许数据目录访问。']);
    return;
  }

  let assetsDirPromise = null;
  let directoryError = null;
  const failures = new Map();
  const resolveAssetsDir = () => {
    if (!assetsDirPromise) {
      assetsDirPromise = state.dirHandle.getDirectoryHandle('assets')
        .catch(error => {
          directoryError = error;
          throw error;
        });
    }
    return assetsDirPromise;
  };
  const renderPhotoIssues = () => {
    const results = [...failures.values()];
    const permissionLost = results.some(result => result && result.permissionLost)
      || (directoryError
        && (directoryError.name === 'NotAllowedError' || directoryError.name === 'SecurityError'));
    const messages = [];
    if (permissionLost) messages.push('照片访问权限已失效，请刷新页面并重新允许数据目录访问。');
    else if (directoryError) messages.push('照片目录暂时不可用。');
    else if (results.length) messages.push(`${results.length} 张照片暂时无法显示。`);
    renderDailySummaryStatus(messages);
  };

  let controller = null;
  controller = window.MementoPhotos.createViewportLoader({
    createObserver: typeof IntersectionObserver === 'function'
      ? callback => new IntersectionObserver(callback, {
          root: list,
          rootMargin: PHOTO_VIEWPORT_ROOT_MARGIN,
          threshold: 0.01,
        })
      : null,
    isCurrent: () => generation === photoRenderGeneration
      && photoViewportLoader === controller,
    async load(item, figure, viewportIsCurrent) {
      const [result] = await photoAssetLoader.loadBatch([item.day.photo], {
        isCurrent: () => viewportIsCurrent()
          && figure.isConnected
          && list.contains(figure),
        canStart: () => !directoryError,
        loadFile: (record, isDirectoryCurrent) =>
          readDayPhotoFile(record, resolveAssetsDir, isDirectoryCurrent),
        onReady: (asset, record) => renderDayPhotoAsset(
          record,
          figure,
          asset,
          generation,
          viewportIsCurrent
        ),
      });
      return result || { ok: false, reason: '照片暂时无法显示' };
    },
    onState(figure, item, photoState, result) {
      if (generation !== photoRenderGeneration || !figure.isConnected) return;
      if (result && result.permissionLost) photoPermissionLost = true;
      figure.dataset.photoState = photoState;
      if (photoState === 'loading') {
        const media = figure.querySelector('.day-photo-media');
        if (media) media.innerHTML = '<span class="day-photo-file-error">正在生成轻量缩略图</span>';
      } else if (photoState === 'error') {
        const message = result && result.terminal
          ? '照片读取已暂停'
          : result && (result.skipped ? '照片读取已暂停' : result.reason)
            || '照片暂时不可用';
        setDayPhotoError(figure, message);
        if (!result || !result.skipped) failures.set(item.day.photo.assetName, result || {});
        renderPhotoIssues();
      } else if (photoState === 'ready') {
        failures.delete(item.day.photo.assetName);
        renderPhotoIssues();
      }
    },
  });
  photoViewportLoader = controller;

  for (const item of items) {
    const card = list.querySelector(`[data-day-index="${item.index}"]`);
    const figure = card && card.querySelector('.day-photo');
    if (!figure || (figure.dataset.photoState === 'ready' && figure.querySelector('img'))) continue;
    figure.dataset.photoState = 'idle';
    const media = figure.querySelector('.day-photo-media');
    if (media) media.innerHTML = '<span class="day-photo-file-error">滚动到附近时加载照片</span>';
    controller.observe(figure, item);
  }
}

async function renderDailySummaryList(options = {}) {
  renderSummaryMonthOptions();
  renderDailySummaryCount();
  const days = dailySummaryDaysForSelectedMonth();
  const layout = dailySummaryLayoutSignature(days);
  cancelPhotoRender();
  const generation = photoRenderGeneration;
  if (!options.force && canReuseRenderedDailySummary(days, layout)) {
    renderDailySummaryStatus();
    document.getElementById('daily-summary-meta').textContent = `${days.length} 天`;
    startDailySummaryPhotoViewport(days, generation);
    return;
  }

  const list = document.getElementById('daily-summary-list');
  const meta = document.getElementById('daily-summary-meta');
  renderDailySummaryStatus();

  if (!state.dayCards.length) {
    meta.textContent = '0 天';
    list.innerHTML = `
      <div class="daily-summary-empty">
        <strong>还没有每日总结</strong>
        第一次记录后，这一天会先出现在这里；照片和总结准备好后会自动补齐。
      </div>`;
    dailySummaryRenderedVersion = dailySummaryDataVersion;
    dailySummaryRenderedMonth = selectedSummaryMonth;
    dailySummaryRenderedLayout = layout;
    return;
  }

  meta.textContent = `${days.length} 天`;
  list.innerHTML = days.map(dayCardMarkup).join('');
  bindDailyReviewRerunActions(list);
  dailySummaryRenderedVersion = dailySummaryDataVersion;
  dailySummaryRenderedMonth = selectedSummaryMonth;
  dailySummaryRenderedLayout = layout;
  startDailySummaryPhotoViewport(days, generation);
}

function openDailySummaryDrawer() {
  openSideDrawer('daily-summary-drawer', 'daily-summary-tab');
  if (dailySummaryRenderedVersion !== dailySummaryDataVersion) {
    refreshDailySummaryOptionalView({ renderOnMismatch: false });
  }
  void renderDailySummaryList();
}

function initDailySummaries() {
  document.getElementById('daily-summary-tab').hidden = false;
  renderDailySummaryCount();
  if (dailySummariesInited) return;
  dailySummariesInited = true;

  document.getElementById('daily-summary-tab').addEventListener('click', openDailySummaryDrawer);
  document.getElementById('daily-summary-drawer-close').addEventListener('click', closeSideDrawers);
  document.getElementById('daily-summary-month').addEventListener('change', event => {
    selectedSummaryMonth = event.target.value;
    void renderDailySummaryList({ force: true });
  });
  window.addEventListener('pagehide', releasePhotoObjectUrls);
}

// =============================================================
// 6. 主流程
// =============================================================

const grantBtn = document.getElementById('grant-btn');
const grantSection = document.getElementById('grant-section');
const hero = document.getElementById('hero');
const statusEl = document.getElementById('status');
const dashboardSection = document.getElementById('dashboard-section');
const btnLabelGrant = grantBtn.querySelector('.btn-label');
const grantTitle = grantSection.querySelector('h2');
const grantHelp = grantSection.querySelector('.muted');
let rememberedDirectoryHandle = null;
let forceFolderPicker = false;

function setStatus(text, tone = 'muted') {
  statusEl.textContent = text;
  statusEl.style.color = tone === 'accent' ? 'var(--accent)'
                        : tone === 'ink'    ? 'var(--ink)'
                        : 'var(--ink-muted)';
}

function setGrantBusy(busy) {
  grantBtn.disabled = busy;
  grantBtn.setAttribute('aria-busy', String(busy));
}

function quarantineDirectoryActions() {
  selectionEpoch += 1;
  state.dirHandle = null;
  state.files = [];
  state.allEntries = [];
  state.todayFileText = null;
  state.todayEntries = [];
  state.snapshots = [];
  state.reviews = [];
  state.reviewStates = {};
  state.dayCards = [];
  state.recordSource = 'none';
  state.todayResolved = false;

  archiveRenderGeneration += 1;
  resetArchiveIndexState();
  releasePhotoObjectUrls();
  for (const id of [
    'entry-list',
    'chips',
    'heatmap',
    'archive-list',
    'daily-summary-list',
  ]) document.getElementById(id)?.replaceChildren();
  for (const id of [
    'record-summary',
    'stats',
    'dashboard-notice',
    'archive-count',
    'archive-status',
    'daily-summary-count',
    'daily-summary-status',
    'daily-summary-meta',
  ]) {
    const element = document.getElementById(id);
    if (element) element.textContent = '';
  }
}

function showGrantUI({ title, help, label, status, tone = 'muted', forcePicker = false }) {
  retireActiveCoreLoad();
  quarantineDirectoryActions();
  closeSideDrawers(false);
  hero.hidden = false;
  grantSection.hidden = false;
  dashboardSection.hidden = true;
  document.getElementById('archive-tab').hidden = true;
  document.getElementById('daily-summary-tab').hidden = true;
  grantTitle.textContent = title;
  grantHelp.innerHTML = help;
  btnLabelGrant.textContent = label;
  forceFolderPicker = forcePicker;
  setStatus(status, tone);
}

function shortError(error) {
  if (!error) return '未知错误';
  return error.message || error.name || String(error);
}

function setRestoreStage(stage) {
  const messages = {
    'load-handle': '正在读取浏览器授权记录…',
    'query-permission': '正在检查数据目录权限…',
    'load-directory': '正在读取 Memento 数据文件…',
  };
  setStatus(messages[stage] || '正在恢复数据目录…');
  btnLabelGrant.textContent = '正在恢复…';
}

function retireActiveCoreLoad() {
  if (!activeCoreLoad) return;
  directoryLoadGate.invalidate(activeCoreLoad.generation);
  activeCoreLoad = null;
}

function showPersistedSelectionChanged(storedHandle) {
  rememberedDirectoryHandle = storedHandle;
  showGrantUI({
    title: '数据目录已在另一页面切换',
    help: '另一个 Memento 页面选择了新的数据目录。旧页面已停止使用之前的记录，点击后加载当前目录。',
    label: '加载当前数据目录',
    status: '已停止使用旧目录，等待加载当前目录',
  });
}

function setRegrantUI(permission = 'prompt', handle = rememberedDirectoryHandle, contextPromise = null) {
  if (permission === 'denied') {
    void invalidateFastStartCache(handle, contextPromise)
      .catch(error => console.warn('无法清除已撤权目录缓存', error));
    showGrantUI({
      title: '数据目录访问已被关闭',
      help: 'Chrome 仍记得之前的目录,但当前不允许继续访问。请重新选择 <code>~/AISecretary</code>。',
      label: '重新选择数据目录',
      status: '目录权限已被移除',
      tone: 'accent',
      forcePicker: true,
    });
    return;
  }

  showGrantUI({
    title: '请确认访问已保存的数据目录',
    help: 'Chrome 已记住 <code>~/AISecretary</code>,无需重新查找目录。点击后若浏览器询问授权期限,请选择“允许每次访问”。',
    label: '允许访问',
    status: '已记住数据目录,等待权限确认',
  });
}

function getLocalDate() {
  // 用本地时区取今天,与 append_text.sh 的 `date +%Y-%m-%d` 一致;
  // 不能用 toISOString().slice(0,10),那是 UTC,跨日会与文件名错开。
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let activeCoreLoad = null;
let coreRefreshChannel = null;
let persistedSelectionReloadId = 0;
let selectionFlowId = 0;
try {
  if (dashboardCacheRepository && typeof BroadcastChannel === 'function') {
    coreRefreshChannel = new BroadcastChannel(CORE_REFRESH_CHANNEL_NAME);
  }
} catch (error) {
  console.warn('无法建立 Dashboard 跨标签页刷新通道', error);
}

function selectionFlowStillCurrent(flowId) {
  return flowId === selectionFlowId;
}

function completeCoverage(files) {
  return {
    enumerationDone: true,
    discoveredCount: files.length,
    completedCount: files.length,
    complete: true,
  };
}

function commitCoreRecordView(handle, generation, recordResult, options) {
  if (!directoryLoadGate.isCurrent(generation)) return false;
  const files = [...(recordResult.files || [])].sort((a, b) => b.date.localeCompare(a.date));
  const today = options.today || getLocalDate();
  const todayFile = files.find(file => file.date === today);
  const allEntries = files.flatMap(file => parseFile(file.text, file.date));
  const snapshots = window.MementoPhotos
    ? window.MementoPhotos.collectSnapshotRecords(files)
    : [];
  const sourceMocks = buildSourceMocks(files);
  const initialDayCards = window.MementoDailySummaries
    ? window.MementoDailySummaries.buildDayCards(snapshots, [], buildSourceDaySkeleton(files), {}, {
        sourceMocks,
        promptHash: '',
        promptIssue: '',
      })
    : [];
  const coverage = recordResult.coverage || {};
  const todayResolved = options.todayResolved !== undefined
    ? options.todayResolved
    : Boolean(todayFile) || Boolean(coverage.enumerationDone);

  return directoryLoadGate.commit(generation, () => {
    state.files = files;
    state.allEntries = allEntries;
    state.todayDate = today;
    state.todayFileText = todayFile ? todayFile.text : null;
    state.todayEntries = allEntries.filter(entry => entry.date === today);
    state.selectedRange = getSavedRange();
    state.selectedStyle = getSavedStyle();
    state.dirHandle = handle;
    state.snapshots = snapshots;
    state.reviews = [];
    state.reviewStates = {};
    state.dayCards = initialDayCards;
    markDailySummaryDataChanged();
    state.reviewReadIssue = '';
    state.reviewStatusReadIssue = '';
    state.reviewPromptReadIssue = '';
    state.recordReadIssues = recordResult.issues || [];
    state.recordScanIssue = recordResult.issue || '';
    state.recordSource = options.source;
    state.recordRefreshMessage = options.message || '';
    state.todayResolved = todayResolved;

    hero.hidden = true;
    grantSection.hidden = true;
    dashboardSection.hidden = false;

    populateSelectors();
    bindEasterEgg();
    if (options.source !== 'waiting') {
      // The archive badge belongs to the cached first paint. Prime it before
      // the rail is revealed so the number never pops in one frame later.
      primeArchiveIndexFromActiveSession();
      initArchives();
      initDailySummaries();
    }
    renderDashboard();
    if (activeDrawerId === 'daily-summary-drawer') void renderDailySummaryList({ force: true });
  });
}

async function hydrateOptionalDashboardData(handle, generation, files) {
  const sourceHashes = await buildSourceHashes(files);
  if (!directoryLoadGate.isCurrent(generation)) return;
  const sourceMocks = buildSourceMocks(files);
  const snapshots = window.MementoPhotos
    ? window.MementoPhotos.collectSnapshotRecords(files)
    : [];

  setStatus('正在补充每日总结…');
  const { reviewResult, reviewStateResult, promptResult } = await readOptionalDashboardData(handle, {
    isCurrent: () => directoryLoadGate.isCurrent(generation),
  });
  if (!directoryLoadGate.isCurrent(generation)) return;

  const reviews = window.MementoDailySummaries
    ? window.MementoDailySummaries.collectReviewRecords(reviewResult.files)
    : [];
  const reviewStates = window.MementoDailySummaries
    ? window.MementoDailySummaries.collectReviewStates(reviewStateResult.files)
    : {};
  const dayCards = window.MementoDailySummaries
    ? window.MementoDailySummaries.buildDayCards(snapshots, reviews, sourceHashes, reviewStates, {
        sourceMocks,
        promptHash: promptResult.hash,
        promptIssue: promptResult.issue,
      })
    : [];

  directoryLoadGate.commit(generation, () => {
    state.reviews = reviews;
    state.reviewStates = reviewStates;
    state.dayCards = dayCards;
    markDailySummaryDataChanged();
    state.reviewReadIssue = reviewResult.issue;
    state.reviewStatusReadIssue = reviewStateResult.issue;
    state.reviewPromptReadIssue = promptResult.issue;
    initDailySummaries();
    refreshDailySummaryOptionalView();
  });
}

function cacheContextForHandle(handle, suppliedContextPromise) {
  if (suppliedContextPromise) return suppliedContextPromise;
  if (!dashboardCacheRepository) return Promise.resolve(null);
  return dashboardCacheRepository.readBootstrap()
    .then(bootstrap => dashboardCacheRepository.resolveBootstrap(handle, bootstrap))
    .catch(error => {
      console.warn('快速启动缓存不可用，将使用实时读取', error);
      return null;
    });
}

function mergeFilesWithTodayProbe(session, cachedFiles) {
  return window.MementoDashboardOperations.mergeCachedFilesWithTodayProbe(cachedFiles, {
    todayDate: session.today,
    file: session.todayFile,
    resolved: session.todayProbeResolved,
    probedAt: session.todayProbeAt,
  });
}

async function startCacheHydration(session) {
  try {
    const context = await session.contextPromise;
    session.cacheContextReady = true;
    session.cacheContext = context;
    if (!context || !directoryLoadGate.isCurrent(session.generation)) return false;
    const liveAlreadyVerified = state.recordSource === 'fresh' || state.recordSource === 'shared';
    // The normal fast path inherits the permission check immediately before
    // loadAndRender. If cache validation missed its short decision window,
    // re-check before a much later result reveals cached records or metadata.
    if (session.cacheDecisionExpired
        && !liveAlreadyVerified
        && (context.cache || context.archiveIndex)
        && !await permissionStillGranted(session)) return false;
    if (!directoryLoadGate.isCurrent(session.generation)) return false;

    session.bootstrapArchiveIndex = context.archiveIndex || null;
    if (state.dirHandle === session.handle) primeArchiveIndexFromActiveSession();
    if (liveAlreadyVerified) return false;
    if (!context.cache) return false;

    // Normally cache hydration is a hard barrier before the live scan starts.
    // Keep the merge defensive anyway: if a future fallback lets today's file
    // arrive first, preserve that fresh file and fill only historical days from
    // the last-known-good snapshot.
    const files = mergeFilesWithTodayProbe(session, context.cache.files);
    const hasLiveToday = Boolean(session.todayFile);
    session.cacheShown = commitCoreRecordView(session.handle, session.generation, {
      files,
      issues: [],
      issue: '',
      coverage: completeCoverage(files),
    }, {
      source: hasLiveToday ? 'partial' : 'cache',
      message: hasLiveToday
        ? '今天的记录已核对；其他历史记录仍显示上次的完整结果。'
        : '正在显示上次完整记录；后台正在核对最新文件。',
      todayResolved: true,
      today: session.today,
    });
    return Boolean(session.cacheShown);
  } catch (error) {
    session.cacheContextReady = true;
    session.cacheContext = null;
    session.bootstrapArchiveIndex = null;
    console.warn('快速启动缓存不可用，继续实时读取', error);
    return false;
  }
}

async function waitForStartupCache(session, hydrationPromise) {
  const access = window.MementoDirectoryAccess;
  if (!access || typeof access.withTimeout !== 'function') return hydrationPromise;
  try {
    return await access.withTimeout(
      () => hydrationPromise,
      CACHE_FIRST_DECISION_MS,
      '等待快速启动缓存'
    );
  } catch (error) {
    if (!error || error.name !== 'TimeoutError') throw error;
    // Do not cancel the real lookup: late hydration can still replace waiting
    // or merge with live today. This flag makes that late reveal re-check the
    // directory permission first.
    session.cacheDecisionExpired = true;
    return false;
  }
}

async function permissionStillGranted(session) {
  let permission;
  try {
    permission = await queryRead(session.handle);
  } catch (error) {
    if (directoryLoadGate.isCurrent(session.generation)) {
      directoryLoadGate.invalidate(session.generation);
      showAccessResult({ kind: 'permission-check-error', handle: session.handle, error });
    }
    return false;
  }
  if (permission === 'granted') return directoryLoadGate.isCurrent(session.generation);
  if (directoryLoadGate.isCurrent(session.generation)) {
    directoryLoadGate.invalidate(session.generation);
    rememberedDirectoryHandle = session.handle;
    setRegrantUI(permission, session.handle, session.contextPromise);
  }
  return false;
}

async function produceCoreRecords(session) {
  const recordResult = await listMarkdownFiles(session.handle, {
    todayDate: session.today,
    seedFiles: session.todayFile ? [session.todayFile] : [],
    isCurrent: () => directoryLoadGate.isCurrent(session.generation),
    onFile: detail => {
      if (!directoryLoadGate.isCurrent(session.generation)) return;
      // Today is the only partial result that changes first-screen utility.
      // Historical files converge in the final commit instead of reparsing and
      // repainting the whole dashboard once per completed file.
      if (!detail.isToday) return;
      if (session.todayProbeResolved) return;
      session.todayFile = detail.file;
      session.todayProbeResolved = true;
      session.todayProbeAt = Date.now();
      const files = session.cacheShown
        ? state.files
          .filter(file => file.name !== detail.file.name)
          .concat(detail.file)
        : [detail.file];
      session.liveShown = commitCoreRecordView(session.handle, session.generation, {
        files,
        issues: [],
        issue: '',
        coverage: {
          enumerationDone: false,
          discoveredCount: detail.discoveredCount,
          completedCount: detail.completedCount,
          complete: false,
        },
      }, {
        source: 'partial',
        message: session.cacheShown
          ? '今天的记录已核对；其他历史记录仍显示上次的完整结果。'
          : '今天的记录已显示；历史记录仍在后台核对。',
        todayResolved: true,
        today: session.today,
      });
    },
  });

  if (!directoryLoadGate.isCurrent(session.generation)) return { ...recordResult, stale: true };
  const complete = Boolean(recordResult.coverage && recordResult.coverage.complete);
  if (complete) {
    session.liveShown = commitCoreRecordView(session.handle, session.generation, recordResult, {
      source: 'fresh',
      message: '',
      todayResolved: true,
      today: session.today,
    });
    if (session.liveShown) {
      scheduleOptionalHydration(session, recordResult.files);
    }
  } else if (session.cacheShown) {
    directoryLoadGate.commit(session.generation, () => {
      state.recordReadIssues = recordResult.issues || [];
      state.recordScanIssue = recordResult.issue || '';
      state.recordRefreshMessage = state.recordSource === 'partial' && state.todayResolved
        ? '今天的记录已核对；本轮历史记录核对未完整结束，仍保留上次结果。'
        : '本轮核对没有完整结束，继续保留上次的完整记录。';
      renderDashboardNotice();
      updateCtaLabel();
    });
  } else {
    const todayReadFailed = (recordResult.issues || [])
      .some(issue => issue.name === `${session.today}.md`);
    session.liveShown = commitCoreRecordView(session.handle, session.generation, recordResult, {
      source: 'partial',
      message: '本轮只完成了部分文件读取；已显示能够确认的记录。',
      todayResolved: Boolean(recordResult.files.find(file => file.date === session.today))
        || Boolean(recordResult.coverage && recordResult.coverage.enumerationDone && !todayReadFailed),
      today: session.today,
    });
  }
  return recordResult;
}

async function readTodayRecord(session) {
  if (!directoryLoadGate.isCurrent(session.generation)) return { stale: true };
  const operations = window.MementoDashboardOperations;
  try {
    return await operations.readTodayMarkdownFile(session.handle, session.today, {
      isCurrent: () => directoryLoadGate.isCurrent(session.generation),
    });
  } catch (error) {
    const kind = operations.errorKind(error);
    if (kind === 'permission' || kind === 'missing') throw error;
    // The complete scan still gets one independent chance to read today. A
    // transient point-read failure must not strand the historical refresh.
    console.warn('今日记录直读失败，将由后台完整核对重试', error);
    session.todayProbeIssue = error;
    return { failed: true, error };
  }
}

function commitTodayRecord(session, result) {
  if (!result || result.stale || !directoryLoadGate.isCurrent(session.generation)) {
    return false;
  }
  if (result.failed) return false;

  session.todayProbeResolved = true;
  session.todayProbeAt = Date.now();
  session.todayFile = result.file || null;
  const files = mergeFilesWithTodayProbe(session, state.files);
  session.liveShown = commitCoreRecordView(session.handle, session.generation, {
    files,
    issues: [],
    issue: '',
    coverage: {
      enumerationDone: false,
      discoveredCount: files.length,
      completedCount: 1,
      complete: false,
    },
  }, {
    source: 'partial',
    message: result.file
      ? '今天的记录已同步；历史记录仍在后台核对。'
      : '已确认今天暂无记录；历史记录仍在后台核对。',
    todayResolved: true,
    today: session.today,
  });
  return Boolean(session.liveShown);
}

function scheduleOptionalHydration(session, files) {
  if (session.optionalHydrationStarted || !directoryLoadGate.isCurrent(session.generation)) return;
  session.optionalHydrationStarted = true;
  void hydrateOptionalDashboardData(session.handle, session.generation, files)
    .catch(error => handleOptionalReadError(session, error));
}

function handleOptionalReadError(session, error) {
  if (!directoryLoadGate.isCurrent(session.generation)) return;
  const access = window.MementoDirectoryAccess;
  if (access && access.isPermissionError(error)) {
    void permissionStillGranted(session).then(stillGranted => {
      if (!stillGranted || !directoryLoadGate.isCurrent(session.generation)) return;
      directoryLoadGate.commit(session.generation, () => {
        state.reviewReadIssue = `每日总结暂时无法读取: ${shortError(error)}`;
        if (activeDrawerId === 'daily-summary-drawer') renderDailySummaryStatus();
      });
    });
    return;
  }
  console.warn('每日总结增强数据读取失败', error);
  directoryLoadGate.commit(session.generation, () => {
    state.reviewReadIssue = `每日总结暂时无法读取: ${shortError(error)}`;
    if (activeDrawerId === 'daily-summary-drawer') renderDailySummaryStatus();
  });
}

async function persistCompleteSnapshot(session, recordResult) {
  if (!dashboardCacheRepository) return { stored: false, reason: 'cache-unavailable' };
  if (!directoryLoadGate.isCurrent(session.generation)) return { stored: false, reason: 'stale-session' };
  // Cache is optional. If its bootstrap lookup is still pending when live has
  // completed, give the already-started IDB read one short grace period. This
  // never starts or duplicates a File System Access request.
  if (!session.cacheContextReady) {
    const access = window.MementoDirectoryAccess;
    if (!access || !access.withTimeout) return { stored: false, reason: 'context-pending' };
    try {
      const context = await access.withTimeout(
        () => session.contextPromise,
        CACHE_CONTEXT_GRACE_MS,
        '等待快速缓存上下文'
      );
      session.cacheContextReady = true;
      session.cacheContext = context;
    } catch {
      return { stored: false, reason: 'context-pending' };
    }
  }
  const context = session.cacheContext;
  if (!context || !context.writable || !context.binding) {
    return { stored: false, reason: context?.reason || 'cache-readonly' };
  }
  if (!directoryLoadGate.isCurrent(session.generation)) return { stored: false, reason: 'stale-session' };
  const stored = await dashboardCacheRepository.commitComplete(context.binding.token, {
    ...recordResult,
    scanDate: session.today,
  });
  if (stored.stored && coreRefreshChannel) {
    coreRefreshChannel.postMessage({
      type: 'core-snapshot-committed',
      bindingToken: context.binding.token,
      committedAt: stored.snapshot.committedAt,
      scanDate: session.today,
    });
  }
  return stored;
}

async function reloadSharedSnapshot(session, publication = null) {
  if (!dashboardCacheRepository || !directoryLoadGate.isCurrent(session.generation)) return false;
  const bootstrap = await dashboardCacheRepository.readBootstrap();
  const context = await dashboardCacheRepository.resolveBootstrap(session.handle, bootstrap);
  if (!context.cache || !directoryLoadGate.isCurrent(session.generation)) return false;
  if (!await permissionStillGranted(session)) return false;
  if (state.recordSource === 'fresh' || state.recordSource === 'shared') return true;
  const sharedFresh = Boolean(publication
    && context.binding
    && publication.bindingToken === context.binding.token
    && publication.committedAt === context.cache.committedAt
    && publication.scanDate === session.today
    && context.cache.scanDate === session.today);
  const verifiedShared = sharedFresh;
  if (publication && !verifiedShared) return false;
  if (!verifiedShared && session.liveShown) return false;
  const files = mergeFilesWithTodayProbe(session, context.cache.files);
  session.cacheShown = commitCoreRecordView(session.handle, session.generation, {
    files,
    issues: [],
    issue: '',
    coverage: completeCoverage(context.cache.files),
  }, {
    source: verifiedShared ? 'shared' : 'cache',
    message: verifiedShared ? '' : '正在显示上次完整记录；另一页面正在核对最新文件。',
    todayResolved: true,
    today: session.today,
  });
  if (verifiedShared && session.cacheShown) {
    // The leader may have started its full scan before this Tab's exact today
    // probe. Build optional drawers from the same merged files now visible on
    // screen, otherwise the record list can be fresh while Daily Summary still
    // reflects the leader's older copy of today's Markdown.
    scheduleOptionalHydration(session, files);
  }
  return Boolean(session.cacheShown);
}

function keepCurrentViewAfterCoreError(session, error) {
  if (!directoryLoadGate.isCurrent(session.generation)) return;
  console.error('Memento 核心记录刷新失败', error);
  if (state.recordSource === 'cache' || state.recordSource === 'partial'
      || state.recordSource === 'fresh' || state.recordSource === 'shared') {
    directoryLoadGate.commit(session.generation, () => {
      state.recordScanIssue = `最新记录核对失败: ${shortError(error)}`;
      state.recordRefreshMessage = state.recordSource === 'cache'
        ? '继续显示上次的完整记录。'
        : state.recordRefreshMessage;
      renderDashboardNotice();
      updateCtaLabel();
    });
    return;
  }
  directoryLoadGate.invalidate(session.generation);
  showAccessResult({ kind: 'read-error', handle: session.handle, error });
}

function handleCoreRefreshError(session, error) {
  if (!directoryLoadGate.isCurrent(session.generation)) return;
  const access = window.MementoDirectoryAccess;
  if (access && access.isPermissionError(error)) {
    void permissionStillGranted(session).then(stillGranted => {
      if (stillGranted) keepCurrentViewAfterCoreError(session, error);
    });
    return;
  }
  if (access && access.isStaleHandleError(error)) {
    directoryLoadGate.invalidate(session.generation);
    showAccessResult({
      kind: 'directory-missing',
      handle: session.handle,
      cacheContextPromise: session.contextPromise,
      error,
    });
    return;
  }
  keepCurrentViewAfterCoreError(session, error);
}

async function produceCoordinatedCoreRecords(session, coordination) {
  const recordResult = await produceCoreRecords(session);
  const complete = Boolean(recordResult
    && recordResult.coverage
    && recordResult.coverage.complete);
  let snapshotResult = { stored: false, reason: coordination.shared ? 'incomplete' : 'local-only' };
  if (coordination.shared && complete && directoryLoadGate.isCurrent(session.generation)) {
    try {
      // Keep the Web Lock until the complete snapshot is committed and its
      // publication is sent. Followers never race a half-published refresh.
      snapshotResult = await persistCompleteSnapshot(session, recordResult);
    } catch (error) {
      console.warn('完整快照保存失败，下次将继续实时读取', error);
      snapshotResult = { stored: false, reason: 'commit-error', error };
    }
  }
  return { recordResult, snapshotResult };
}

function scheduleCoreRefresh(session) {
  if (!directoryLoadGate.isCurrent(session.generation)) return;
  const operations = window.MementoDashboardOperations;
  const canShare = Boolean(coreRefreshChannel
    && navigator.locks
    && typeof navigator.locks.request === 'function');
  const lockManager = canShare ? navigator.locks : null;
  // Every Tab performs one exact today probe before asking for the global
  // history lock. A reloaded page therefore sees a new append even when an old
  // document still owns the non-cancellable full-scan lock.
  const refreshPromise = operations.startTodayFirstRefresh({
    isCurrent: () => directoryLoadGate.isCurrent(session.generation),
    readToday: () => readTodayRecord(session),
    commitToday: result => commitTodayRecord(session, result),
    startHistory: () => operations.coordinateCoreRefresh(
      lockManager,
      coordination => {
        session.coordinationRole = coordination.role;
        return produceCoordinatedCoreRecords(session, coordination);
      }
    ),
  }).then(result => result.stale ? { role: 'stale' } : result.historyResult);

  void refreshPromise.then(result => {
    if (!directoryLoadGate.isCurrent(session.generation)) return;
    if (result.role === 'stale') return;
    session.coordinationRole = result.role;
    if (result.role === 'follower') {
      directoryLoadGate.commit(session.generation, () => {
        state.recordRefreshMessage = session.todayProbeResolved
          ? '今天的记录已同步；另一页面正在后台核对历史记录。'
          : state.recordSource === 'cache'
            ? '正在显示上次完整记录；另一页面正在核对最新文件。'
            : '另一 Memento 页面正在读取最新记录，完成后会自动显示；若长时间无变化，请关闭其他 Memento 页面后刷新。';
        renderDashboardNotice();
        updateCtaLabel();
      });
      // Cache hydration has already had its own bounded opportunity and keeps
      // running if late. Do not immediately re-read the same IndexedDB state
      // or query permission a second time; the leader's publication message
      // will trigger one exact, token-checked reload when data really changes.
    }
  }).catch(error => {
    handleCoreRefreshError(session, error);
  });
}

function afterFirstDashboardPaint() {
  if (typeof requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      resolve();
    };
    // One rAF callback still runs before paint. The second frame proves the
    // cached DOM had a paint opportunity before any root-directory traversal.
    const fallback = setTimeout(finish, 120);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

async function loadAndRenderLocked(
  handle,
  generation,
  suppliedContextPromise = null,
  { cacheFirst = true } = {}
) {
  if (!directoryLoadGate.isCurrent(generation)) return { stale: true };
  const sessionSelectionEpoch = ++selectionEpoch;
  const session = {
    handle,
    generation,
    selectionEpoch: sessionSelectionEpoch,
    today: getLocalDate(),
    cacheShown: false,
    liveShown: false,
    todayFile: null,
    todayProbeResolved: false,
    todayProbeAt: 0,
    todayProbeIssue: null,
    cacheContext: null,
    cacheContextReady: false,
    bootstrapArchiveIndex: null,
    cacheDecisionExpired: false,
    contextPromise: cacheContextForHandle(handle, suppliedContextPromise),
    coordinationRole: 'pending',
    optionalHydrationStarted: false,
  };
  activeCoreLoad = session;
  state.persistenceIssue = '';
  const operations = window.MementoDashboardOperations;
  if (!operations || typeof operations.startCacheFirstRefresh !== 'function') {
    throw new Error('Dashboard 快速启动模块未加载');
  }
  const startup = await operations.startCacheFirstRefresh({
    cacheFirst,
    hydrateCache: () => startCacheHydration(session),
    waitForCache: hydrationPromise => waitForStartupCache(session, hydrationPromise),
    hasVisibleContent: () => state.dirHandle === handle
      && ['cache', 'partial', 'fresh', 'shared'].includes(state.recordSource),
    shouldRefresh: () => !(state.dirHandle === handle
      && (state.recordSource === 'fresh' || state.recordSource === 'shared')),
    showWaiting: () => commitCoreRecordView(handle, generation, {
      files: [],
      issues: [],
      issue: '',
      coverage: { enumerationDone: false, discoveredCount: 0, completedCount: 0, complete: false },
    }, {
      source: 'waiting',
      message: '正在并行读取最新记录…',
      todayResolved: false,
      today: session.today,
    }),
    afterFirstPaint: afterFirstDashboardPaint,
    startRefresh: () => scheduleCoreRefresh(session),
    isCurrent: () => directoryLoadGate.isCurrent(generation) && activeCoreLoad === session,
  });
  return {
    stale: Boolean(startup.stale),
    scheduled: Boolean(startup.started),
    cacheShown: Boolean(startup.cacheHit),
  };
}

function loadAndRender(handle, generation, suppliedContextPromise = null, options = {}) {
  return loadAndRenderLocked(handle, generation, suppliedContextPromise, options);
}

if (coreRefreshChannel) {
  coreRefreshChannel.onmessage = event => {
    const data = event.data || {};
    if (data.type === 'selection-changed') {
      void reloadPersistedSelectionAfterBroadcast()
        .catch(error => console.warn('无法加载跨标签页选择的目录', error));
      return;
    }
    const session = activeCoreLoad;
    if (!session) return;
    if (data.type !== 'core-snapshot-committed') return;
    const publication = {
      bindingToken: typeof data.bindingToken === 'string' ? data.bindingToken : '',
      committedAt: Number.isSafeInteger(data.committedAt) ? data.committedAt : -1,
      scanDate: typeof data.scanDate === 'string' ? data.scanDate : '',
    };
    void reloadSharedSnapshot(session, publication)
      .catch(error => console.warn('跨标签页快照更新失败', error));
  };
}

async function reloadPersistedSelectionAfterBroadcast() {
  const flowId = ++selectionFlowId;
  const reloadId = ++persistedSelectionReloadId;
  // Invalidate even a restore/picker flow that has not created a session yet.
  directoryLoadGate.begin();
  retireActiveCoreLoad();
  showGrantUI({
    title: '数据目录正在同步切换',
    help: '另一个 Memento 页面选择了数据目录。旧页面已停用，正在加载当前保存的目录。',
    label: '正在加载…',
    status: '正在读取当前数据目录…',
  });
  setGrantBusy(true);

  try {
    const access = window.MementoDirectoryAccess;
    const storedHandle = access && access.withTimeout
      ? await access.withTimeout(loadHandle, STORAGE_OPERATION_TIMEOUT_MS, '读取当前数据目录')
      : await loadHandle();
    if (!selectionFlowStillCurrent(flowId) || reloadId !== persistedSelectionReloadId) return;
    if (!storedHandle) {
      showAccessResult({ kind: 'missing' });
      return;
    }
    rememberedDirectoryHandle = storedHandle;

    let permission;
    try {
      permission = await queryRead(storedHandle);
    } catch (error) {
      if (selectionFlowStillCurrent(flowId) && reloadId === persistedSelectionReloadId) {
        showAccessResult({ kind: 'permission-check-error', handle: storedHandle, error });
      }
      return;
    }
    if (!selectionFlowStillCurrent(flowId) || reloadId !== persistedSelectionReloadId) return;
    if (permission !== 'granted') {
      showAccessResult({ kind: 'permission-required', handle: storedHandle, permission });
      return;
    }
    await loadSelectedDirectory(storedHandle, null, flowId);
  } catch (error) {
    if (selectionFlowStillCurrent(flowId) && reloadId === persistedSelectionReloadId) {
      showAccessResult({ kind: 'storage-error', error });
    }
  } finally {
    if (selectionFlowStillCurrent(flowId) && reloadId === persistedSelectionReloadId) {
      setGrantBusy(false);
    }
  }
}

window.addEventListener('pagehide', () => {
  retireActiveCoreLoad();
  quarantineDirectoryActions();
  if (coreRefreshChannel) {
    coreRefreshChannel.onmessage = null;
    coreRefreshChannel.close();
    coreRefreshChannel = null;
  }
}, { once: true });
window.addEventListener('pageshow', event => {
  if (event.persisted) window.location.reload();
});

function showAccessResult(result) {
  if (result.handle) rememberedDirectoryHandle = result.handle;

  switch (result.kind) {
    case 'ready':
      return;
    case 'missing':
      rememberedDirectoryHandle = null;
      showGrantUI({
        title: '首次使用需要选择数据目录',
        help: '请选择 Memento 数据目录(默认 <code>~/AISecretary</code>)。Chrome 会在本机记住这个目录;如果询问授权期限,请选择“允许每次访问”。',
        label: '选择数据目录',
        status: '尚未选择数据目录',
        forcePicker: true,
      });
      return;
    case 'permission-required':
      setRegrantUI(
        result.permission,
        result.handle,
        activeCoreLoad && activeCoreLoad.handle === result.handle
          ? activeCoreLoad.contextPromise
          : null
      );
      return;
    case 'storage-error':
      rememberedDirectoryHandle = null;
      console.error('读取目录授权记录失败', result.error);
      const storageTimedOut = result.error && result.error.name === 'TimeoutError';
      showGrantUI({
        title: storageTimedOut ? '浏览器授权记录读取超时' : '无法恢复上次的数据目录',
        help: storageTimedOut
          ? '已经定位到 Chrome 的 IndexedDB 授权记录没有按时返回,不是数据文件过多。可以重新选择 <code>~/AISecretary</code> 尝试覆盖这条记录。'
          : '浏览器本地授权记录读取失败,这不是“从未授权”。请重新选择 <code>~/AISecretary</code>;如果仍失败,页面会显示具体错误。',
        label: '重新选择数据目录',
        status: `授权记录读取失败: ${shortError(result.error)}`,
        tone: 'accent',
        forcePicker: true,
      });
      return;
    case 'permission-check-error':
      console.error('检查目录权限失败', result.error);
      showGrantUI({
        title: '无法确认数据目录权限',
        help: '上次保存的目录句柄无法正常检查。请重新选择 <code>~/AISecretary</code> 建立新的授权。',
        label: '重新选择数据目录',
        status: `权限检查失败: ${shortError(result.error)}`,
        tone: 'accent',
        forcePicker: true,
      });
      return;
    case 'directory-missing':
      void invalidateFastStartCache(
        result.handle,
        result.cacheContextPromise
          || (activeCoreLoad && activeCoreLoad.handle === result.handle
            ? activeCoreLoad.contextPromise
            : null)
      ).catch(cacheError => console.warn('无法清除失效目录缓存', cacheError));
      console.error('保存的数据目录或文件已不存在', result.error);
      showGrantUI({
        title: '原数据目录无法读取',
        help: '目录可能已移动、改名,或其中的文件刚刚被移除。请重新选择当前的 <code>~/AISecretary</code>。',
        label: '重新选择数据目录',
        status: `原目录不可用: ${shortError(result.error)}`,
        tone: 'accent',
        forcePicker: true,
      });
      return;
    case 'read-error':
    default:
      console.error('Memento 数据加载失败', result.error);
      showGrantUI({
        title: '数据目录已授权,但加载失败',
        help: '目录授权仍然存在。可以先重试;若持续失败,请根据下方错误检查对应文件,无需反复重新授权。',
        label: '重试加载',
        status: `数据加载失败: ${shortError(result.error)}`,
        tone: 'accent',
      });
  }
}

async function tryAutoLoad() {
  const flowId = ++selectionFlowId;
  const generation = directoryLoadGate.begin();
  retireActiveCoreLoad();
  setGrantBusy(true);
  try {
    if (!window.MementoDirectoryAccess) throw new Error('目录授权恢复模块未加载');
    // Start the larger snapshot transaction in parallel with the small handle
    // lookup and permission check. The handle path remains independent, so a
    // slow/corrupt snapshot cannot turn into a false "missing permission" UI.
    const bootstrapPromise = dashboardCacheRepository
      ? dashboardCacheRepository.readBootstrap().catch(error => {
          console.warn('无法预读快速启动缓存，将使用实时读取', error);
          return null;
        })
      : Promise.resolve(null);
    let restoredContextPromise = null;
    const result = await window.MementoDirectoryAccess.restore({
      loadHandle: async () => {
        const handle = await loadHandle();
        if (handle && dashboardCacheRepository) {
          restoredContextPromise = bootstrapPromise.then(bootstrap => bootstrap
            ? dashboardCacheRepository.resolveBootstrap(handle, bootstrap)
            : null
          ).catch(error => {
            console.warn('快速启动缓存校验失败，将使用实时读取', error);
            return null;
          });
        }
        return handle;
      },
      queryPermission: queryRead,
      loadDirectory: handle => {
        if (!selectionFlowStillCurrent(flowId) || !directoryLoadGate.isCurrent(generation)) {
          return { stale: true };
        }
        return loadAndRender(handle, generation, restoredContextPromise);
      },
      onStage: stage => {
        if (selectionFlowStillCurrent(flowId) && directoryLoadGate.isCurrent(generation)) {
          setRestoreStage(stage);
        }
      },
      // The access module applies this only to IndexedDB handle recovery;
      // permission and file-system calls are awaited directly.
      timeoutMs: STORAGE_OPERATION_TIMEOUT_MS,
    });
    if (!selectionFlowStillCurrent(flowId) || !directoryLoadGate.isCurrent(generation)) return;
    if (result.kind !== 'ready') directoryLoadGate.invalidate(generation);
    showAccessResult(result);
  } catch (error) {
    if (!selectionFlowStillCurrent(flowId)) return;
    directoryLoadGate.invalidate(generation);
    showAccessResult({ kind: 'read-error', error });
  } finally {
    if (selectionFlowStillCurrent(flowId)) setGrantBusy(false);
  }
}

async function loadSelectedDirectory(
  handle,
  cacheContextPromise = null,
  flowId = selectionFlowId,
  options = {}
) {
  if (!selectionFlowStillCurrent(flowId)) return { ok: false, stale: true, generation: null };
  const generation = directoryLoadGate.begin();
  try {
    setRestoreStage('load-directory');
    const result = await loadAndRender(handle, generation, cacheContextPromise, options);
    if (!selectionFlowStillCurrent(flowId)) {
      directoryLoadGate.invalidate(generation);
      return { ok: false, stale: true, generation };
    }
    return { ok: !result?.stale, stale: Boolean(result?.stale), generation };
  } catch (error) {
    const current = selectionFlowStillCurrent(flowId) && directoryLoadGate.isCurrent(generation);
    directoryLoadGate.invalidate(generation);
    if (!current) return { ok: false, stale: true, generation, error };
    const access = window.MementoDirectoryAccess;
    const kind = access && access.isPermissionError(error)
      ? 'permission-required'
      : access && access.isStaleHandleError(error)
        ? 'directory-missing'
        : 'read-error';
    showAccessResult({ kind, handle, permission: 'prompt', error });
    return { ok: false, stale: false, generation, error };
  }
}

grantBtn.addEventListener('click', async () => {
  if (grantBtn.disabled) return;
  const flowId = ++selectionFlowId;
  // A permission prompt or picker can overlap an earlier restore before that
  // restore created activeCoreLoad. Fence it immediately, not only via UI.
  directoryLoadGate.begin();
  retireActiveCoreLoad();
  quarantineDirectoryActions();
  setGrantBusy(true);

  try {
    // requestPermission/showDirectoryPicker 依赖当前点击的用户激活。
    // 自动恢复阶段已把 handle 缓存在内存,这里不能先等待一次 IndexedDB。
    if (rememberedDirectoryHandle && !forceFolderPicker) {
      let permission;
      try {
        // requestPermission may legitimately wait while the user reads the
        // Chrome prompt. It is not cancellable, so it must not use a timer.
        permission = await requestRead(rememberedDirectoryHandle);
      } catch (error) {
        if (!selectionFlowStillCurrent(flowId)) return;
        if (error.name === 'AbortError') return;
        console.error('请求目录权限失败', error);
        showGrantUI({
          title: '未能发起目录授权',
          help: 'Chrome 没有完成这次权限请求。请再点一次重试;若仍失败,再重新选择数据目录。',
          label: '重试允许访问',
          status: `授权请求失败: ${shortError(error)}`,
          tone: 'accent',
        });
        return;
      }

      if (!selectionFlowStillCurrent(flowId)) return;
      if (permission === 'granted') {
        await loadSelectedDirectory(rememberedDirectoryHandle, null, flowId);
        return;
      }

      // 当前点击的用户激活通常已结束，不在这里接着打开 picker。
      // 只有明确 denied 才清缓存并要求重选；prompt 继续保留句柄。
      setRegrantUI(
        permission,
        rememberedDirectoryHandle,
        activeCoreLoad && activeCoreLoad.handle === rememberedDirectoryHandle
          ? activeCoreLoad.contextPromise
          : null
      );
      return;
    }

    const handle = await pickFolder();
    if (!selectionFlowStillCurrent(flowId)) return;
    rememberedDirectoryHandle = handle;
    forceFolderPicker = false;
    const operations = window.MementoDashboardOperations;
    let preparedSelection = null;
    if (dashboardCacheRepository) {
      try {
        preparedSelection = dashboardCacheRepository.prepareSelection(handle);
      } catch (error) {
        console.warn('快速启动缓存初始化失败，当前目录仍会实时加载', error);
      }
    }
    const notifySelectionPersisted = () => {
      if (coreRefreshChannel) {
        try {
          coreRefreshChannel.postMessage({
            type: 'selection-changed',
            bindingToken: preparedSelection?.binding?.token || '',
          });
        } catch (error) {
          console.warn('无法广播已保存的数据目录', error);
        }
      }
      if (selectionFlowStillCurrent(flowId)
          && state.persistenceIssue
          && activeCoreLoad
          && activeCoreLoad.handle === handle
          && state.dirHandle === handle) {
        state.persistenceIssue = '';
        renderDashboardNotice();
      }
      // BroadcastChannel never echoes to its sender. If this picker became
      // stale while its queued transaction was waiting, reconcile this page
      // with the actual persisted winner as well.
      if (!selectionFlowStillCurrent(flowId)) {
        void reloadPersistedSelectionAfterBroadcast()
          .catch(error => console.warn('无法协调晚到的数据目录保存', error));
      }
    };
    const selection = await operations.loadWhilePersisting(handle, {
      load: currentHandle => loadSelectedDirectory(
        currentHandle,
        preparedSelection ? preparedSelection.contextPromise : null,
        flowId,
        { cacheFirst: false }
      ),
      persist: currentHandle => persistSelectedDirectoryHandle(
        currentHandle,
        preparedSelection,
        notifySelectionPersisted
      ),
    });
    if (!selectionFlowStillCurrent(flowId)) return;
    if (!selection.persistence.ok) {
      console.error('目录已加载，但授权记录未持久化', selection.persistence.error);
      const loadResult = selection.loadResult;
      if (loadResult.ok && directoryLoadGate.isCurrent(loadResult.generation)) {
        const timedOut = selection.persistence.error && selection.persistence.error.name === 'TimeoutError';
        state.persistenceIssue = timedOut
          ? `当前目录已正常加载，但 Chrome 未按时确认保存授权记录；下次打开时可能需重新选择。`
          : `当前目录已正常加载，但授权记录未保存；下次打开时需重新选择。`;
        renderDashboardNotice();
      }
    }
  } catch (error) {
    if (!selectionFlowStillCurrent(flowId)) return;
    if (error.name === 'AbortError') return;
    console.error('选择或保存数据目录失败', error);
    const pickerBlocked = error.name === 'SecurityError';
    showGrantUI({
      title: pickerBlocked ? 'Chrome 未能打开目录选择器' : '数据目录授权未保存',
      help: pickerBlocked
        ? '目录选择器必须由一次有效点击打开。请关闭其他弹窗后再试。'
        : '选择目录后,浏览器未能保存授权记录。请重试;该错误不会再被当成“从未授权”。',
      label: '重试选择数据目录',
      status: `目录授权失败: ${shortError(error)}`,
      tone: 'accent',
      forcePicker: true,
    });
  } finally {
    if (selectionFlowStillCurrent(flowId)) setGrantBusy(false);
  }
});

void tryAutoLoad();
