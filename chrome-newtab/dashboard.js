// Memento · Chrome 新标签页 Dashboard
// - TODO 大字提醒 (跨所有日期统计,localStorage 记完成态)
// - 大号"复制今天 → AI"按钮 (clipboard API)
// - Entry 列表 (默认筛 #TODO,chip 切换)
// - 统计 + 90 天热力图 + favicon 数字徽章
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
    const text = await file.text();
    files.push({ name, date: name.replace(/\.md$/, ''), mtime: file.lastModified, text });
  }
  return files.sort((a, b) => b.date.localeCompare(a.date));
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
// 4. localStorage · TODO 完成态
// =============================================================

const DONE_KEY = 'aisec.done';
const RANGE_KEY = 'aisec.range';   // A · 时间段 (today/week/month)
const STYLE_KEY = 'aisec.style';   // B · 风格 (prompt id, null=不附)

function getDoneIds() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); }
  catch { return new Set(); }
}
function setDoneIds(set) {
  localStorage.setItem(DONE_KEY, JSON.stringify([...set]));
}
function toggleDone(id) {
  const set = getDoneIds();
  if (set.has(id)) set.delete(id); else set.add(id);
  setDoneIds(set);
}

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
  currentFilter: 'TODO', // 默认强提醒筛选
  selectedRange: 'today', // A · 时间段 (today/week/month)
  selectedStyle: null,    // B · 风格 prompt id (null = 不附)
  dirHandle: null,       // ~/AISecretary 目录 handle (写归档时用)
};

// SVG 内嵌图标 (Tabler 风格,统一 stroke 2)
const SVG = {
  flame: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 12c2 -2.96 0 -7 -1 -8c0 3.038 -1.773 4.741 -3 6c-1.226 1.26 -2 3.24 -2 5a6 6 0 1 0 12 0c0 -1.532 -1.056 -3.94 -2 -5c-1.786 3 -2.791 3 -4 2z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5l10 -10"/></svg>`,
};

function renderDashboard() {
  const doneIds = getDoneIds();
  const openTodoCount = state.allEntries.filter(e => e.tag === 'TODO' && !doneIds.has(e.id)).length;

  renderTodoBanner(openTodoCount);
  renderStats();
  renderHeatmap();
  renderSectionDivider();
  renderChips();
  renderEntryList();
  bindCopyButton();

  updateFavicon(openTodoCount);
  updateTitle(openTodoCount);
}

function renderTodoBanner(n) {
  const banner = document.getElementById('todo-banner');
  if (n === 0) {
    banner.classList.add('is-clear');
    banner.innerHTML = `${SVG.check}<span>所有 TODO 已清空</span>`;
  } else {
    banner.classList.remove('is-clear');
    banner.innerHTML = `${SVG.flame}<span>${n} 个未完成 TODO</span>`;
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
  const todayCount = state.todayEntries.length;
  let weekCount = 0;
  let activeDays = 0;
  for (let i = 0; i < 7; i++) {
    const dateStr = dateOffset(state.todayDate, -i);
    const n = byDay[dateStr] || 0;
    weekCount += n;
    if (n > 0) activeDays++;
  }
  document.getElementById('stats').innerHTML =
    `今日 <strong>${todayCount}</strong> 条 · ` +
    `本周 <strong>${weekCount}</strong> 条 · ` +
    `活跃 <strong>${activeDays}/7</strong> 天`;
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

// favicon: canvas 画 16×16 圆形红底白字徽章
function updateFavicon(n) {
  const size = 32; // 视网膜
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (n === 0) {
    // 清空状态: 灰底空盒,不抢注意力
    ctx.fillStyle = '#EDEAE3';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7A766F';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(10, 17);
    ctx.lineTo(15, 22);
    ctx.lineTo(23, 11);
    ctx.stroke();
  } else {
    // 红底白字
    ctx.fillStyle = '#C73E1D';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fill();

    const text = n > 99 ? '99+' : String(n);
    ctx.fillStyle = '#FAFAF7';
    const fontSize = text.length >= 3 ? 13 : text.length === 2 ? 18 : 22;
    ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 1);
  }

  const url = canvas.toDataURL('image/png');
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = url;
}

function updateTitle(n) {
  document.title = n === 0 ? 'Memento' : `${n} TODO · Memento`;
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
    { key: 'all',      label: `全部 · ${state.todayEntries.length}` },
    { key: 'TODO',     label: `#TODO · ${tagCounts.TODO || 0}`,         variant: 'todo' },
    { key: '灵感',     label: `#灵感 · ${tagCounts['灵感'] || 0}` },
    { key: '下次再读', label: `#下次再读 · ${tagCounts['下次再读'] || 0}` },
  ];

  chips.innerHTML = items.map(({ key, label, variant }) => {
    const isOn = state.currentFilter === key;
    let cls = 'chip ';
    if (isOn) cls += 'is-on';
    else if (variant === 'todo') cls += 'is-todo';
    else cls += 'is-off';
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
      ? '今天还没记任何东西'
      : '这个筛选下没有内容';
    list.innerHTML = `<div class="empty-state">${text}</div>`;
    return;
  }

  const doneIds = getDoneIds();
  list.innerHTML = filtered.map(e => renderEntry(e, doneIds.has(e.id))).join('');

  // bind TODO 勾选
  list.querySelectorAll('.todo-check').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.id;
      toggleDone(id);
      renderDashboard(); // 完成态变化影响 banner + 列表
    });
  });
}

function renderEntry(e, isDone) {
  const metaParts = [`<span class="entry-time">${escapeHtml(e.time)}</span>`];
  if (e.source) metaParts.push(escapeHtml(e.source));
  if (e.tag) metaParts.push(`<span class="entry-tag">#${escapeHtml(e.tag)}</span>`);

  const checkBtn = e.tag === 'TODO'
    ? `<button class="todo-check ${isDone ? 'is-done' : ''}" data-id="${escapeHtml(e.id)}" title="标记完成/撤销">${SVG.check}</button>`
    : '';

  const noteBlock = e.note
    ? `<div class="entry-note">备注: ${escapeHtml(e.note)}</div>`
    : '';

  return `
    <article class="entry">
      ${checkBtn}
      <div class="entry-meta">${metaParts.join(' ')}</div>
      <div class="entry-body${isDone ? ' is-done' : ''}">${renderMarkdown(e.body)}</div>
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
// 5.5 HTML 归档库 (右侧抽屉)
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
  document.getElementById('archive-drawer').classList.add('open');
  document.getElementById('drawer-scrim').classList.add('open');
  renderArchives();
}
function closeDrawer() {
  document.getElementById('archive-drawer').classList.remove('open');
  document.getElementById('drawer-scrim').classList.remove('open');
}

function initArchives() {
  document.getElementById('archive-tab').hidden = false;
  if (archivesInited) { renderArchives(); return; }
  archivesInited = true;

  document.getElementById('archive-tab').addEventListener('click', openDrawer);
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);

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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('archive-drawer').classList.contains('open')) closeDrawer();
  });

  renderArchives();
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
  const files = await listMarkdownFiles(handle);
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

  // 切换 UI:隐藏 grant + hero,显示 dashboard
  hero.hidden = true;
  grantSection.hidden = true;
  dashboardSection.hidden = false;

  populateSelectors();
  bindEasterEgg();
  initArchives();
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
