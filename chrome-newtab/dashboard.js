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

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
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
  const handle = await window.showDirectoryPicker({ mode: 'read' });
  await saveHandle(handle);
  return handle;
}
async function listMarkdownFiles(dirHandle) {
  const files = [];
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind !== 'file') continue;
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const file = await entry.getFile();
    const bytes = await file.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    files.push({ name, date: name.replace(/\.md$/, ''), mtime: file.lastModified, text, bytes });
  }
  return files.sort((a, b) => b.date.localeCompare(a.date));
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
    return { files: [], issue: fileReadIssue(error, '无法读取 Daily Review 目录') };
  }

  const files = [];
  try {
    for await (const [name, entry] of dailyDir.entries()) {
      if (entry.kind !== 'file' || !/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      const date = name.replace(/\.md$/, '');
      try {
        const file = await entry.getFile();
        files.push({ name, date, mtime: file.lastModified, text: await file.text(), readIssue: '' });
      } catch (error) {
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
    return { files, issue: fileReadIssue(error, '无法继续读取 Daily Review 目录') };
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
    return { files: [], issue: fileReadIssue(error, '无法读取总结运行状态') };
  }

  const files = [];
  try {
    for await (const [name, entry] of statusDir.entries()) {
      if (entry.kind !== 'file' || !/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const date = name.replace(/\.json$/, '');
      try {
        const file = await entry.getFile();
        files.push({ name, date, mtime: file.lastModified, text: await file.text(), readIssue: '' });
      } catch (error) {
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
    return { files, issue: fileReadIssue(error, '无法继续读取总结运行状态') };
  }
  return { files: files.sort((a, b) => b.date.localeCompare(a.date)), issue: '' };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function buildSourceHashes(files) {
  const pairs = await Promise.all((files || []).map(async file => [file.date, await sha256Hex(file.bytes)]));
  return Object.fromEntries(pairs);
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
};

function renderDashboard() {
  renderRecordSummary(state.todayEntries.length);
  renderStats();
  renderHeatmap();
  renderSectionDivider();
  renderChips();
  renderEntryList();
  bindCopyButton();

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
  } catch {
    return null;
  }
}

async function listArchives() {
  const dir = await getArchiveDir(false);
  if (!dir) return [];
  const items = [];
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file') continue;
    if (!/\.html?$/i.test(name)) continue;
    let mtime = 0;
    try { mtime = (await entry.getFile()).lastModified; } catch {}
    items.push({ name, mtime, handle: entry });
  }
  return items.sort((a, b) => b.mtime - a.mtime);
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
  const files = [...(fileList || [])].filter(f => /\.html?$/i.test(f.name) || f.type === 'text/html');
  if (!files.length) { flashDrop('只接受 .html 文件'); return; }

  if (!(await ensureWritePermission())) { flashDrop('需要读写授权才能存档'); return; }
  const dir = await getArchiveDir(true);
  if (!dir) { flashDrop('无法创建 .archives 目录'); return; }

  let saved = 0;
  for (const file of files) {
    try {
      const text = await file.text();
      const fh = await dir.getFileHandle(file.name, { create: true });
      const w = await fh.createWritable();
      await w.write(text);
      await w.close();
      saved++;
    } catch (e) { console.error(e); }
  }
  flashDrop(saved ? `已存入 ${saved} 份` : '存档失败');
  await renderArchives();
}

async function renderArchives() {
  const list = document.getElementById('archive-list');
  const countEl = document.getElementById('archive-count');
  const items = await listArchives();

  countEl.textContent = items.length ? String(items.length) : '';

  if (!items.length) {
    list.innerHTML = `<div class="archive-empty">还没有归档。<br>把 AI 整理好的 HTML 拖进来。</div>`;
    return;
  }

  list.innerHTML = items.map((it, i) => `
    <div class="archive-item" data-idx="${i}">
      <span class="ai-doc" aria-hidden="true">📄</span>
      <span class="ai-main">
        <span class="ai-title">${escapeHtml(it.name.replace(/\.html?$/i, ''))}</span>
        <span class="ai-meta">${fmtArchiveDate(it.mtime)}</span>
      </span>
      <span class="ai-open" aria-hidden="true" title="在新标签打开">↗</span>
      <button class="ai-del" data-name="${escapeHtml(it.name)}" title="删除">✕</button>
    </div>`).join('');

  // 异步把文件名换成 HTML <title>
  items.forEach(async (it, i) => {
    try {
      const text = await (await it.handle.getFile()).text();
      const el = list.querySelector(`.archive-item[data-idx="${i}"] .ai-title`);
      if (el) el.textContent = extractTitle(text, it.name.replace(/\.html?$/i, ''));
    } catch {}
  });

  list.querySelectorAll('.archive-item').forEach(row => {
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.ai-del')) return;
      openArchive(items[+row.dataset.idx]);
    });
  });
  list.querySelectorAll('.ai-del').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const name = btn.dataset.name;
      if (!confirm(`删除归档「${name}」?(会从 .archives 目录移除)`)) return;
      if (!(await ensureWritePermission())) return;
      const dir = await getArchiveDir(false);
      if (dir) { try { await dir.removeEntry(name); } catch (e) { console.error(e); } }
      await renderArchives();
    });
  });
}

// 点击归档 → 在沙箱页新标签里完整渲染 HTML
// 为什么不用 blob URL:blob: 会继承扩展页的 CSP(script-src 'self'),
// 内联 <script>/onclick 等交互组件全被掐死(本地双击能用、归档打开就废)。
// 改走 manifest sandbox.pages 里的 viewer.html:它有独立、允许内联脚本的 CSP,
// 主页面把 HTML 文本 postMessage 进去由它渲染,交互组件恢复正常。
async function openArchive(item) {
  try {
    const text = await (await item.handle.getFile()).text();
    const w = window.open(chrome.runtime.getURL('viewer.html'), '_blank');
    if (!w) { flashDrop('请允许弹窗后重试'); return; }
    const send = () => { try { w.postMessage({ type: 'memento-html', html: text }, '*'); } catch {} };
    const onMsg = (e) => {
      if (e.source !== w || !e.data || e.data.type !== 'memento-viewer-ready') return;
      send();
      window.removeEventListener('message', onMsg);
    };
    window.addEventListener('message', onMsg);
    // 兜底:若个别 Chrome 版本抹掉 sandbox 页的 opener 致握手丢失,延时主动推一次
    setTimeout(send, 500);
  } catch (e) { console.error(e); }
}

function openDrawer() {
  openSideDrawer('archive-drawer', 'archive-tab');
  renderArchives();
}
function closeDrawer() {
  closeSideDrawers();
}

function initArchives() {
  document.getElementById('archive-tab').hidden = false;
  if (archivesInited) { renderArchives(); return; }
  archivesInited = true;

  document.getElementById('archive-tab').addEventListener('click', openDrawer);
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);

  const drop = document.getElementById('archive-drop');
  const input = document.getElementById('archive-input');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { saveArchiveFiles(input.files); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    saveArchiveFiles(e.dataTransfer.files);
  });

  renderArchives();
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
  if (day.summaryStatus === 'failed' || day.summaryStatus === 'stale') return true;
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

async function loadDayPhoto(record, card, assetsDir, generation) {
  if (!record || !record.assetName || !card) return { ok: false, reason: record?.issues[0] || '照片引用缺失' };
  try {
    const handle = await assetsDir.getFileHandle(record.assetName);
    const file = await handle.getFile();
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
    const permissionLost = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    const message = permissionLost ? '访问权限已失效' : '照片文件不存在';
    setDayPhotoError(card, message);
    return { ok: false, permissionLost, reason: message };
  }
}

async function renderDailySummaryList() {
  releasePhotoObjectUrls();
  const generation = photoRenderGeneration;
  renderSummaryMonthOptions();

  const list = document.getElementById('daily-summary-list');
  const status = document.getElementById('daily-summary-status');
  const meta = document.getElementById('daily-summary-meta');
  const statusMessages = [state.reviewReadIssue, state.reviewStatusReadIssue].filter(Boolean);
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

  let assetsDir;
  try {
    assetsDir = await state.dirHandle.getDirectoryHandle('assets');
  } catch (error) {
    if (generation !== photoRenderGeneration) return;
    const permissionLost = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    statusMessages.push(permissionLost ? '照片访问权限已失效，请重新允许数据目录。' : '照片目录暂时不可用。');
    daysWithPhotos.forEach(({ index }) => setDayPhotoError(list.querySelector(`[data-day-index="${index}"]`), '照片暂时不可用'));
    status.textContent = statusMessages.join(' ');
    return;
  }

  const results = await Promise.all(daysWithPhotos.map(({ day, index }) =>
    loadDayPhoto(day.photo, list.querySelector(`[data-day-index="${index}"]`), assetsDir, generation)
  ));
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

function setStatus(text, tone = 'muted') {
  statusEl.textContent = text;
  statusEl.style.color = tone === 'accent' ? 'var(--accent)'
                        : tone === 'ink'    ? 'var(--ink)'
                        : 'var(--ink-muted)';
}

function setRegrantUI() {
  document.querySelector('.grant-card h2').textContent = '请重新允许一次访问';
  document.querySelector('.grant-card .muted').innerHTML =
    '浏览器记住了上次选的 <code>~/AISecretary</code>,但每次重启后,出于安全原因需要你再点一次确认。';
  btnLabelGrant.textContent = '重新允许访问';
}

function getLocalDate() {
  // 用本地时区取今天,与 append_text.sh 的 `date +%Y-%m-%d` 一致;
  // 不能用 toISOString().slice(0,10),那是 UTC,跨日会与文件名错开。
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadAndRender(handle) {
  const [files, reviewResult, reviewStateResult] = await Promise.all([
    listMarkdownFiles(handle),
    listDailyReviewFiles(handle),
    listDailyReviewStateFiles(handle),
  ]);
  const sourceHashes = await buildSourceHashes(files);
  const today = getLocalDate();
  const todayFile = files.find(f => f.date === today);

  state.files = files;
  state.allEntries = files.flatMap(f => parseFile(f.text, f.date));
  state.todayDate = today;
  state.todayFileText = todayFile ? todayFile.text : null;
  state.todayEntries = state.allEntries.filter(e => e.date === today);
  state.selectedRange = getSavedRange();
  state.selectedStyle = getSavedStyle();
  state.dirHandle = handle;
  state.snapshots = window.MementoPhotos
    ? window.MementoPhotos.collectSnapshotRecords(files)
    : [];
  state.reviews = window.MementoDailySummaries
    ? window.MementoDailySummaries.collectReviewRecords(reviewResult.files)
    : [];
  state.reviewStates = window.MementoDailySummaries
    ? window.MementoDailySummaries.collectReviewStates(reviewStateResult.files)
    : {};
  state.dayCards = window.MementoDailySummaries
    ? window.MementoDailySummaries.buildDayCards(state.snapshots, state.reviews, sourceHashes, state.reviewStates)
    : [];
  state.reviewReadIssue = reviewResult.issue;
  state.reviewStatusReadIssue = reviewStateResult.issue;

  // 切换 UI:隐藏 grant + hero,显示 dashboard
  hero.hidden = true;
  grantSection.hidden = true;
  dashboardSection.hidden = false;

  populateSelectors();
  bindEasterEgg();
  initArchives();
  initDailySummaries();
  renderDashboard();
}

async function tryAutoLoad() {
  const handle = await loadHandle().catch(() => null);
  if (!handle) return;

  const perm = await queryRead(handle).catch(() => 'denied');
  if (perm === 'granted') {
    await loadAndRender(handle);
  } else {
    setRegrantUI();
    setStatus('已记住授权,需你点一次允许', 'muted');
  }
}

grantBtn.addEventListener('click', async () => {
  try {
    let handle = await loadHandle().catch(() => null);

    if (handle) {
      const perm = await requestRead(handle);
      if (perm === 'granted') {
        await loadAndRender(handle);
        return;
      }
    }

    handle = await pickFolder();
    await loadAndRender(handle);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus('出错: ' + err.message, 'accent');
  }
});

tryAutoLoad();
