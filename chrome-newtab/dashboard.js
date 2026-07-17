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
async function persistSelectedDirectoryHandle(handle) {
  const access = window.MementoDirectoryAccess;
  if (access && access.withTimeout) {
    await access.withTimeout(
      () => saveHandle(handle),
      STORAGE_OPERATION_TIMEOUT_MS,
      '保存浏览器授权记录'
    );
  } else {
    await saveHandle(handle);
  }
  void persistBrowserStorage();
}
async function listMarkdownFiles(dirHandle) {
  if (!window.MementoDashboardOperations) throw new Error('Dashboard 文件操作模块未加载');
  return window.MementoDashboardOperations.readMarkdownFiles(dirHandle, {
    onProgress: ({ count }) => {
      setStatus(`正在读取每日记录…已完成 ${count} 个文件`);
    },
  });
}

async function readOptionalDashboardData(handle) {
  // These are optional enhancements. Read them after the main records, but
  // await Chrome directly: File System Access promises are not cancellable,
  // so a timer would only hide a still-running browser request.
  const reviewResult = await listDailyReviewFiles(handle);
  const reviewStateResult = await listDailyReviewStateFiles(handle);
  const promptResult = await readDailyReviewPrompt(handle);
  return { reviewResult, reviewStateResult, promptResult };
}

function fileReadIssue(error, fallback) {
  if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return '访问总结目录的权限已失效';
  return fallback;
}

async function listDailyReviewFiles(rootHandle) {
  let dailyDir;
  try {
    const reviewsDir = await rootHandle.getDirectoryHandle('Reviews');
    dailyDir = await reviewsDir.getDirectoryHandle('Daily');
  } catch (error) {
    if (error && error.name === 'NotFoundError') return { files: [], issue: '' };
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw error;
    return {
      files: [],
      issue: fileReadIssue(error, '无法读取 Daily Review 目录'),
    };
  }

  const files = [];
  const iterator = dailyDir.entries()[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const [name, entry] = next.value;
      if (entry.kind !== 'file' || !/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      const date = name.replace(/\.md$/, '');
      try {
        const file = await entry.getFile();
        const text = await file.text();
        files.push({ name, date, mtime: file.lastModified, text, readIssue: '' });
      } catch (error) {
        if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
          throw error;
        }
        files.push({
          name,
          date,
          mtime: 0,
          text: '',
          readIssue: fileReadIssue(error, '总结文件暂时无法读取'),
        });
      }
    }
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw error;
    return {
      files: files.sort((a, b) => b.date.localeCompare(a.date)),
      issue: fileReadIssue(error, '无法继续读取 Daily Review 目录'),
    };
  }
  return { files: files.sort((a, b) => b.date.localeCompare(a.date)), issue: '' };
}

async function listDailyReviewStateFiles(rootHandle) {
  let statusDir;
  try {
    const reviewDir = await rootHandle.getDirectoryHandle('.review');
    statusDir = await reviewDir.getDirectoryHandle('status');
  } catch (error) {
    if (error && error.name === 'NotFoundError') return { files: [], issue: '' };
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw error;
    return {
      files: [],
      issue: fileReadIssue(error, '无法读取总结运行状态'),
    };
  }

  const files = [];
  const iterator = statusDir.entries()[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const [name, entry] = next.value;
      if (entry.kind !== 'file' || !/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const date = name.replace(/\.json$/, '');
      try {
        const file = await entry.getFile();
        const text = await file.text();
        files.push({ name, date, mtime: file.lastModified, text, readIssue: '' });
      } catch (error) {
        if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
          throw error;
        }
        files.push({
          name,
          date,
          mtime: 0,
          text: '',
          readIssue: fileReadIssue(error, '总结运行状态暂时无法读取'),
        });
      }
    }
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) throw error;
    return {
      files: files.sort((a, b) => b.date.localeCompare(a.date)),
      issue: fileReadIssue(error, '无法继续读取总结运行状态'),
    };
  }
  return { files: files.sort((a, b) => b.date.localeCompare(a.date)), issue: '' };
}

async function readDailyReviewPrompt(rootHandle) {
  try {
    const promptDir = await rootHandle.getDirectoryHandle('.chrome-newtab');
    const promptHandle = await promptDir.getFileHandle('prompts.js');
    const file = await promptHandle.getFile();
    const bytes = await file.arrayBuffer();
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
    if (permission) throw error;
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
};

const directoryLoadGate = window.MementoDirectoryAccess.createGenerationGate();

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
  if (state.recordReadIssues.length) {
    const names = state.recordReadIssues.slice(0, 3).map(issue => issue.name).join('、');
    const more = state.recordReadIssues.length > 3 ? ` 等 ${state.recordReadIssues.length} 个文件` : '';
    messages.push(`有 ${state.recordReadIssues.length} 个每日记录文件暂时无法读取(${names}${more})，其余记录已正常加载。`);
  }
  if (state.recordScanIssue) {
    messages.push(`${state.recordScanIssue} 当前已显示 ${state.files.length} 个已读取的文件；请检查数据目录后刷新重试。`);
  }
  if (state.persistenceIssue) messages.push(state.persistenceIssue);
  notice.textContent = messages.join(' ');
  notice.hidden = messages.length === 0;
}

function renderRecordSummary(n) {
  const summary = document.getElementById('record-summary');
  if (n === 0) {
    summary.classList.add('is-empty');
    summary.textContent = '今天还没有记录';
  } else {
    summary.classList.remove('is-empty');
    summary.innerHTML = `<span>今天留下了 <strong>${n}</strong> 条记录</span>`;
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

  let filtered = state.todayEntries;
  if (state.currentFilter !== 'all') {
    filtered = filtered.filter(e => e.tag === state.currentFilter);
  }

  if (filtered.length === 0) {
    const text = state.todayEntries.length === 0
      ? '今天还没有记录'
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

function updateCtaLabel() {
  const btn = document.getElementById('copy-btn');
  const label = btn.querySelector('.btn-label');
  label.textContent = defaultCtaLabel();
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

async function copyCombo() {
  const btn = document.getElementById('copy-btn');
  const label = btn.querySelector('.btn-label');
  const restore = () => label.textContent = defaultCtaLabel();

  const { text, range, style } = buildClipboardText(state.selectedRange, state.selectedStyle);
  if (!text) {
    label.textContent = range.days <= 1 ? '今天还没记任何东西' : `${range.label}没有任何记录`;
    setTimeout(restore, 1800);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    label.textContent = style
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

  if (!findStyle('card')) return;

  // 彩蛋复用当前选中的时间段(本周/本月的卡片更有回忆价值)
  const { text } = buildClipboardText(state.selectedRange, 'card');
  if (!text) {
    photo.textContent = '?';
    setTimeout(reset, 1500);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
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

  if (closingDrawerId === 'daily-summary-drawer') releasePhotoObjectUrls();
  if (restoreFocus) lastDrawerTrigger?.focus();
  if (restoreFocus) lastDrawerTrigger = null;
}

// =============================================================
// 5.6 HTML 归档库 (右侧抽屉)
//     真实文件存 ~/AISecretary/.archives/*.html
//     看列表只用只读权限;上传/删除时才懒升级到读写
// =============================================================

const ARCHIVE_SUBDIR = '.archives';
let archivesInited = false;
let archiveRenderGeneration = 0;
const enqueueArchiveMutation = window.MementoDashboardOperations.createSerialQueue();

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

function runArchiveMutation(task, action) {
  return enqueueArchiveMutation(() => runArchiveAction(task, action));
}

function withArchiveMutationLock(task) {
  // Writes still need a cross-tab critical section for conflict-free names
  // and deletion. Ordinary reads deliberately do not share this lock.
  return window.MementoDashboardOperations.withArchiveMutationLock(navigator.locks, task);
}

async function ensureWritePermission() {
  const h = state.dirHandle;
  if (!h) return false;
  if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function getArchiveDir(create = false) {
  const h = state.dirHandle;
  if (!h) return null;
  try {
    return await h.getDirectoryHandle(ARCHIVE_SUBDIR, { create });
  } catch (error) {
    if (!create && error && error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function listArchives(generation) {
  if (generation !== archiveRenderGeneration) return null;
  const dir = await getArchiveDir(false);
  if (!dir) return [];
  const items = [];
  const iterator = dir.entries()[Symbol.asyncIterator]();
  while (true) {
    if (generation !== archiveRenderGeneration) return null;
    const next = await iterator.next();
    if (next.done) break;
    const [name, entry] = next.value;
    if (entry.kind !== 'file') continue;
    if (!/\.html?$/i.test(name)) continue;
    let mtime = 0;
    try {
      mtime = (await entry.getFile()).lastModified;
    } catch (error) {
      const kind = window.MementoDashboardOperations.errorKind(error);
      if (kind === 'permission') throw error;
      if (kind === 'missing') continue;
    }
    items.push({ name, mtime, handle: entry });
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

async function hydrateArchiveTitles(items, list, generation) {
  try {
    for (let index = 0; index < items.length; index++) {
      if (generation !== archiveRenderGeneration) return;
      const item = items[index];
      try {
        const file = await item.handle.getFile();
        const text = await file.text();
        if (generation !== archiveRenderGeneration) return;
        const title = list.querySelector(`.archive-item[data-idx="${index}"] .ai-title`);
        if (title) title.textContent = extractTitle(text, item.name.replace(/\.html?$/i, ''));
      } catch (error) {
        if (window.MementoDashboardOperations.errorKind(error) === 'permission') throw error;
      }
    }
  } catch (error) {
    if (generation !== archiveRenderGeneration) return;
    setArchiveStatus(archiveErrorMessage(error, '读取'), true);
  }
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

async function saveArchiveFiles(fileList) {
  const operations = window.MementoDashboardOperations;
  const files = [...(fileList || [])].filter(file => operations.isArchiveHtmlName(file.name));
  if (!files.length) { flashDrop('只接受 .html 文件'); return; }

  if (!(await ensureWritePermission())) {
    setArchiveStatus('未获得读写授权，归档未保存。', true);
    return;
  }

  let saved = 0;
  let renamed = 0;
  let failed = 0;
  let fatalError = null;
  await withArchiveMutationLock(async () => {
    // The directory and its contents may have changed in another tab while
    // this tab was waiting. Re-read both only after acquiring the shared lock.
    const dir = await getArchiveDir(true);
    if (!dir) throw new Error('无法创建 .archives 目录');

    const existingNames = new Set();
    for await (const [name] of dir.entries()) existingNames.add(name);

    // Keep the whole batch in one critical section: otherwise another tab
    // could claim a later name between two files from this drop.
    for (const file of files) {
      try {
        const saveName = operations.uniqueArchiveName(file.name, existingNames);
        const fh = await dir.getFileHandle(saveName, { create: true });
        const w = await fh.createWritable();
        await w.write(file);
        await w.close();
        existingNames.add(saveName);
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

  flashDrop(saved ? `已存入 ${saved} 份` : '存档失败');
  const details = [];
  if (renamed) details.push(`${renamed} 份同名文件已自动改名`);
  if (failed) details.push(`${failed} 份写入失败`);
  await renderArchives();
  if (details.length) setArchiveStatus(details.join('；'), failed > 0);
  if (fatalError) throw fatalError;
}

async function renderArchives() {
  const generation = ++archiveRenderGeneration;
  const list = document.getElementById('archive-list');
  const countEl = document.getElementById('archive-count');
  setArchiveStatus('正在读取归档…');

  let items;
  try {
    items = await listArchives(generation);
    if (items === null) return;
  } catch (error) {
    if (generation !== archiveRenderGeneration) return;
    console.error('读取归档列表失败', error);
    countEl.textContent = '';
    list.innerHTML = '<div class="archive-empty">归档暂时无法读取。<br>请根据上方提示恢复访问。</div>';
    setArchiveStatus(archiveErrorMessage(error, '读取'), true);
    return;
  }
  if (generation !== archiveRenderGeneration) return;

  countEl.textContent = items.length ? String(items.length) : '';
  setArchiveStatus('');

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
          <span class="ai-title">${escapeHtml(it.name.replace(/\.html?$/i, ''))}</span>
          <span class="ai-meta">${fmtArchiveDate(it.mtime)}</span>
        </span>
        <span class="ai-open" aria-hidden="true" title="在新标签打开">↗</span>
      </button>
      <button type="button" class="ai-del" data-name="${escapeHtml(it.name)}"
              aria-label="删除归档 ${escapeHtml(it.name.replace(/\.html?$/i, ''))}" title="删除">✕</button>
    </div>`).join('');

  // 列表先显示，再逐个补齐归档标题。
  void hydrateArchiveTitles(items, list, generation);

  list.querySelectorAll('.archive-open').forEach(button => {
    button.addEventListener('click', () => {
      void runArchiveAction(() => openArchive(items[+button.dataset.idx]), '打开');
    });
  });
  list.querySelectorAll('.ai-del').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const name = btn.dataset.name;
      if (!confirm(`删除归档「${name}」?(会从 .archives 目录移除)`)) return;
      void runArchiveMutation(async () => {
        if (!(await ensureWritePermission())) {
          setArchiveStatus('未获得读写授权，归档未删除。', true);
          return;
        }
        await withArchiveMutationLock(async () => {
          const dir = await getArchiveDir(false);
          if (!dir) throw Object.assign(new Error('归档目录不存在'), { name: 'NotFoundError' });
          await dir.removeEntry(name);
        });
        await renderArchives();
      }, '删除');
    });
  });
}

// 点击归档 → 在独立 sandbox 页中预览。
// viewer 会先移除任意脚本、刷新/外链和嵌入内容，仅保留静态 HTML/CSS、
// details/summary 和页内锚点；避免 AI 生成的归档通过 location/meta refresh 绕过网络 CSP。
async function openArchive(item) {
  // 在点击的用户激活尚有效时先打开窗口，再异步读文件。
  const viewer = window.open(chrome.runtime.getURL('viewer.html'), '_blank');
  if (!viewer) {
    setArchiveStatus('无法打开归档，请允许 Memento 打开新标签后重试。', true);
    return;
  }

  try {
    const file = await item.handle.getFile();
    const text = await file.text();
    const send = () => { try { viewer.postMessage({ type: 'memento-html', html: text }, '*'); } catch {} };
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
  // 归档列表只在用户打开抽屉时读取。新标签页启动阶段主动扫描
  // .archives 会与每日记录争抢 Chrome 的 File System Access broker。
  document.getElementById('archive-count').textContent = '';
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
    void runArchiveMutation(() => saveArchiveFiles(files), '保存');
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const files = [...e.dataTransfer.files];
    void runArchiveMutation(() => saveArchiveFiles(files), '保存');
  });
}

// =============================================================
// 5.7 每日总结 (当天第一帧 + Daily Review + 运行状态)
// =============================================================

let dailySummariesInited = false;
let selectedSummaryMonth = null;
let photoRenderGeneration = 0;
const photoObjectUrls = new Set();

function releasePhotoObjectUrls() {
  photoRenderGeneration++;
  photoObjectUrls.forEach(url => URL.revokeObjectURL(url));
  photoObjectUrls.clear();
}

function revokePhotoObjectUrl(url) {
  if (!photoObjectUrls.delete(url)) return;
  URL.revokeObjectURL(url);
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
  const media = record.assetName
    ? '<span class="day-photo-file-error">正在读取照片</span>'
    : `<span class="day-photo-file-error">${escapeHtml(issue || '照片引用缺失')}</span>`;
  return `
    <figure class="day-photo" data-day-photo-index="${index}" title="${escapeHtml(issue)}">
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
    <article class="${classes}" data-day-index="${index}">
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

function setDayPhotoError(card, message) {
  if (!card) return;
  const media = card.querySelector('.day-photo-media');
  if (media) media.innerHTML = `<span class="day-photo-file-error">${escapeHtml(message)}</span>`;
}

async function readDayPhotoFile(record, assetsDir) {
  if (!record || !record.assetName) return { ok: false, reason: record?.issues[0] || '照片引用缺失' };
  try {
    const handle = await assetsDir.getFileHandle(record.assetName);
    const file = await handle.getFile();
    return { ok: true, file };
  } catch (error) {
    const permissionLost = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    return {
      ok: false,
      error,
      permissionLost,
      reason: permissionLost ? '访问权限已失效' : '照片文件不存在',
    };
  }
}

async function renderDayPhotoFile(record, card, file, generation) {
  if (!card || !file) return { ok: false, reason: '照片文件不可用' };
  try {
    const url = URL.createObjectURL(file);
    if (generation !== photoRenderGeneration) {
      URL.revokeObjectURL(url);
      return { ok: false, stale: true };
    }
    photoObjectUrls.add(url);

    const img = document.createElement('img');
    img.alt = formatPhotoAlt(record);
    img.loading = 'eager';
    img.decoding = 'async';
    const media = card.querySelector('.day-photo-media');
    media.replaceChildren(img);
    const legacyLoad = typeof img.decode !== 'function'
      ? new Promise((resolve, reject) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', reject, { once: true });
        })
      : null;
    img.src = url;

    try {
      if (typeof img.decode === 'function') await img.decode();
      else await legacyLoad;
    } catch {
      revokePhotoObjectUrl(url);
      if (generation !== photoRenderGeneration) return { ok: false, stale: true };
      setDayPhotoError(card, '图片无法显示');
      return { ok: false, reason: '图片无法显示' };
    }

    if (generation !== photoRenderGeneration) {
      revokePhotoObjectUrl(url);
      return { ok: false, stale: true };
    }
    return { ok: true };
  } catch (error) {
    const message = '图片无法显示';
    setDayPhotoError(card, message);
    return { ok: false, reason: message, error };
  }
}

async function renderDailySummaryList() {
  releasePhotoObjectUrls();
  const generation = photoRenderGeneration;
  renderSummaryMonthOptions();

  const list = document.getElementById('daily-summary-list');
  const status = document.getElementById('daily-summary-status');
  const meta = document.getElementById('daily-summary-meta');
  const statusMessages = [
    state.reviewReadIssue,
    state.reviewStatusReadIssue,
    state.reviewPromptReadIssue,
  ].filter(Boolean);
  status.textContent = statusMessages.join(' ');

  if (!state.dayCards.length) {
    meta.textContent = '0 天';
    list.innerHTML = `
      <div class="daily-summary-empty">
        <strong>还没有每日总结</strong>
        第一次记录后，这一天会先出现在这里；照片和总结准备好后会自动补齐。
      </div>`;
    return;
  }

  const days = state.dayCards.filter(day => window.MementoDailySummaries.monthKey(day) === selectedSummaryMonth);
  meta.textContent = `${days.length} 天`;
  list.innerHTML = days.map(dayCardMarkup).join('');
  bindDailyReviewRerunActions(list);

  const daysWithPhotos = days.map((day, index) => ({ day, index })).filter(item => item.day.photo);
  if (!daysWithPhotos.length) return;

  let photoRead;
  try {
    if (generation !== photoRenderGeneration) return;
    let assetsDir;
    try {
      assetsDir = await state.dirHandle.getDirectoryHandle('assets');
    } catch (error) {
      photoRead = { reads: [], directoryError: error };
    }

    if (!photoRead) {
      const reads = [];
      for (const item of daysWithPhotos) {
        if (generation !== photoRenderGeneration) return;
        const result = await readDayPhotoFile(item.day.photo, assetsDir);
        reads.push({ ...item, result });
        if (result.permissionLost) break;
      }
      photoRead = { reads };
    }
  } catch (error) {
    if (generation !== photoRenderGeneration) return;
    const permissionLost = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    statusMessages.push(permissionLost
      ? '照片访问权限已失效，请重新允许数据目录。'
      : '照片目录暂时不可用。');
    daysWithPhotos.forEach(({ index }) => setDayPhotoError(list.querySelector(`[data-day-index="${index}"]`), '照片暂时不可用'));
    status.textContent = statusMessages.join(' ');
    return;
  }

  if (photoRead.stale || generation !== photoRenderGeneration) return;

  if (photoRead.directoryError) {
    const error = photoRead.directoryError;
    const permissionLost = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    statusMessages.push(permissionLost
      ? '照片访问权限已失效，请重新允许数据目录。'
      : '照片目录暂时不可用。');
    daysWithPhotos.forEach(({ index }) => setDayPhotoError(list.querySelector(`[data-day-index="${index}"]`), '照片暂时不可用'));
    status.textContent = statusMessages.join(' ');
    return;
  }

  const attempted = new Set(photoRead.reads.map(({ index }) => index));
  daysWithPhotos
    .filter(({ index }) => !attempted.has(index))
    .forEach(({ index }) => setDayPhotoError(list.querySelector(`[data-day-index="${index}"]`), '照片读取已暂停'));

  const results = [];
  for (const { day, index, result } of photoRead.reads) {
    const card = list.querySelector(`[data-day-index="${index}"]`);
    if (!result.ok) {
      setDayPhotoError(card, result.reason || '照片暂时不可用');
      results.push(result);
      continue;
    }
    results.push(await renderDayPhotoFile(day.photo, card, result.file, generation));
  }
  if (generation !== photoRenderGeneration) return;

  const failed = results.filter(result => !result.ok && !result.stale);
  if (failed.some(result => result.permissionLost)) statusMessages.push('照片访问权限已失效，请重新允许数据目录。');
  else if (failed.length) statusMessages.push(`${failed.length} 张照片暂时无法显示。`);
  status.textContent = statusMessages.join(' ');
}

function openDailySummaryDrawer() {
  openSideDrawer('daily-summary-drawer', 'daily-summary-tab');
  renderDailySummaryList();
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
    renderDailySummaryList();
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

function showGrantUI({ title, help, label, status, tone = 'muted', forcePicker = false }) {
  hero.hidden = false;
  grantSection.hidden = false;
  dashboardSection.hidden = true;
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

function setRegrantUI(permission = 'prompt') {
  if (permission === 'denied') {
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

async function loadAndRenderLocked(handle, generation) {
  if (!directoryLoadGate.isCurrent(generation)) return { stale: true };
  setStatus('正在扫描每日记录…');
  const recordResult = await listMarkdownFiles(handle);
  const files = recordResult.files;
  const sourceHashes = await buildSourceHashes(files);
  const sourceMocks = buildSourceMocks(files);
  const today = getLocalDate();
  const todayFile = files.find(f => f.date === today);
  const allEntries = files.flatMap(f => parseFile(f.text, f.date));
  const snapshots = window.MementoPhotos
    ? window.MementoPhotos.collectSnapshotRecords(files)
    : [];
  const initialDayCards = window.MementoDailySummaries
    ? window.MementoDailySummaries.buildDayCards(snapshots, [], sourceHashes, {}, {
        sourceMocks,
        promptHash: '',
        promptIssue: '',
      })
    : [];

  if (!directoryLoadGate.isCurrent(generation)) return { stale: true };
  directoryLoadGate.commit(generation, () => {
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
    const optionalSkipped = recordResult.issue ? '主记录扫描中断，本轮已跳过每日总结读取。' : '';
    state.reviewReadIssue = optionalSkipped;
    state.reviewStatusReadIssue = '';
    state.reviewPromptReadIssue = '';
    state.recordReadIssues = recordResult.issues;
    state.recordScanIssue = recordResult.issue;
    state.persistenceIssue = '';

    // 切换 UI:隐藏 grant + hero,显示 dashboard
    hero.hidden = true;
    grantSection.hidden = true;
    dashboardSection.hidden = false;

    populateSelectors();
    bindEasterEgg();
    initArchives();
    initDailySummaries();
    renderDashboard();
  });

  // 主记录是新标签页的关键路径；Review、状态和 Prompt 都是可选增强。
  // 先把主界面交给用户，再按顺序读取可选目录，避免任何一路拖垮整页。
  if (recordResult.issue || !directoryLoadGate.isCurrent(generation)) {
    return {
      stale: !directoryLoadGate.isCurrent(generation),
      degraded: Boolean(recordResult.issue),
    };
  }

  setStatus('正在补充每日总结…');
  const optionalData = await readOptionalDashboardData(handle);
  const { reviewResult, reviewStateResult, promptResult } = optionalData;
  if (!directoryLoadGate.isCurrent(generation)) {
    return { stale: true };
  }

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
    state.reviewReadIssue = reviewResult.issue;
    state.reviewStatusReadIssue = reviewStateResult.issue;
    state.reviewPromptReadIssue = promptResult.issue;
    initDailySummaries();
    if (activeDrawerId === 'daily-summary-drawer') void renderDailySummaryList();
  });
  return { stale: false, degraded: false };
}

async function loadAndRender(handle, generation) {
  return loadAndRenderLocked(handle, generation);
}

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
      setRegrantUI(result.permission);
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
  const generation = directoryLoadGate.begin();
  setGrantBusy(true);
  try {
    if (!window.MementoDirectoryAccess) throw new Error('目录授权恢复模块未加载');
    const result = await window.MementoDirectoryAccess.restore({
      loadHandle,
      queryPermission: queryRead,
      loadDirectory: handle => loadAndRender(handle, generation),
      onStage: setRestoreStage,
      // The access module applies this only to IndexedDB handle recovery;
      // permission and file-system calls are awaited directly.
      timeoutMs: STORAGE_OPERATION_TIMEOUT_MS,
    });
    if (result.kind !== 'ready') directoryLoadGate.invalidate(generation);
    showAccessResult(result);
  } catch (error) {
    directoryLoadGate.invalidate(generation);
    showAccessResult({ kind: 'read-error', error });
  } finally {
    setGrantBusy(false);
  }
}

async function loadSelectedDirectory(handle) {
  const generation = directoryLoadGate.begin();
  try {
    setRestoreStage('load-directory');
    const result = await loadAndRender(handle, generation);
    return { ok: !result?.stale, stale: Boolean(result?.stale), generation };
  } catch (error) {
    const current = directoryLoadGate.isCurrent(generation);
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

      if (permission === 'granted') {
        await loadSelectedDirectory(rememberedDirectoryHandle);
        return;
      }

      // 权限弹窗被拒绝后,当前点击的用户激活通常已结束。
      // 不在这里接着打开 picker;下一次点击再重新选择。
      setRegrantUI('denied');
      return;
    }

    const handle = await pickFolder();
    rememberedDirectoryHandle = handle;
    forceFolderPicker = false;
    const operations = window.MementoDashboardOperations;
    const selection = await operations.loadWhilePersisting(handle, {
      load: loadSelectedDirectory,
      persist: persistSelectedDirectoryHandle,
    });
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
    setGrantBusy(false);
  }
});

void tryAutoLoad();
