// AISecretary Dashboard
// Commit 2: 数据层 — IndexedDB handle 持久化 + File System Access + markdown parser
//
// 本 commit 不渲染主 UI,只把 entries 结构化输出到 Console。
// Commit 3 把这里的数据接到 DOM。

// =============================================================
// 0. IndexedDB · 存放 directoryHandle
//    Chrome 86+ 支持 FileSystemDirectoryHandle 走 structured clone
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
  // 必须由用户点击触发,否则 SecurityError
  const handle = await window.showDirectoryPicker({ mode: 'read' });
  await saveHandle(handle);
  return handle;
}

async function listMarkdownFiles(dirHandle) {
  const files = [];
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind !== 'file') continue;
    // 只认 YYYY-MM-DD.md
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
    const file = await entry.getFile();
    const text = await file.text();
    files.push({
      name,
      date: name.replace(/\.md$/, ''),
      mtime: file.lastModified,
      text,
    });
  }
  return files.sort((a, b) => b.date.localeCompare(a.date)); // 新到旧
}

// =============================================================
// 2. Markdown parser · entry 提取
//    格式: heading 是 `## HH:MM · 周X [· 来源] [· #标签]`
//    旧条目可能用 `— 来源` 后缀替代 heading 内的来源段
// =============================================================

const KNOWN_TAGS = new Set(['TODO', '灵感', '下次再读']);
const WEEKDAY_RE = /^周[一二三四五六日]$/;
const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n/;
const ENTRY_SPLIT_RE = /\n---\s*\n/;

function parseFile(text, date) {
  const body = text.replace(FRONTMATTER_RE, '');
  const blocks = body.split(ENTRY_SPLIT_RE)
    .map(b => b.trim())
    .filter(Boolean);

  return blocks
    .map((block, idx) => parseEntry(block, date, idx))
    .filter(Boolean);
}

function parseEntry(block, date, index) {
  const lines = block.split('\n');
  const headingLineIdx = lines.findIndex(l => l.startsWith('## '));
  if (headingLineIdx < 0) return null;

  // ---- heading ----
  const heading = lines[headingLineIdx].replace(/^##\s+/, '').trim();
  const parts = heading.split(' · ').map(s => s.trim()).filter(Boolean);

  const time = parts[0] || '';
  let weekday = null, source = null, tag = null;

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (WEEKDAY_RE.test(p)) weekday = p;
    else if (p.startsWith('#')) tag = p.slice(1);
    else source = source ?? p; // 第一个非周X/非标签段作为来源
  }

  // ---- body ----
  let bodyLines = lines.slice(headingLineIdx + 1);
  // 去首尾空行
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();

  // 旧格式:正文末尾 "— SourceName" (此前没在 heading 中标 source 时才认)
  if (!source && bodyLines.length) {
    const last = bodyLines[bodyLines.length - 1];
    if (/^—\s+\S/.test(last)) {
      source = last.replace(/^—\s+/, '').trim();
      bodyLines.pop();
      while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    }
  }

  // 备注: blockquote
  let note = null;
  for (let i = 0; i < bodyLines.length; i++) {
    if (/^>\s*备注[:：]/.test(bodyLines[i])) {
      note = bodyLines[i].replace(/^>\s*备注[:：]\s*/, '').trim();
      bodyLines.splice(i, 1);
      // 同步去掉相邻空行,避免主体出现孤立空白
      if (bodyLines[i] !== undefined && !bodyLines[i].trim()) bodyLines.splice(i, 1);
      break;
    }
  }

  // 截图引用: > ![原截图](./assets/...)
  let screenshot = null;
  for (let i = 0; i < bodyLines.length; i++) {
    if (/^>\s*!\[/.test(bodyLines[i])) {
      const m = bodyLines[i].match(/!\[[^\]]*\]\(([^)]+)\)/);
      if (m) screenshot = m[1];
      bodyLines.splice(i, 1);
      break;
    }
  }

  // 兼容:heading 没标签时,扫 body 看有没有 "#TODO" / "#灵感" / "#下次再读"
  if (!tag) {
    for (let i = 0; i < bodyLines.length; i++) {
      const m = bodyLines[i].match(/(?:^|\s)#(TODO|灵感|下次再读)(?:\s|$)/);
      if (m && KNOWN_TAGS.has(m[1])) {
        tag = m[1];
        // 若整行就是 "#tag" 一个孤立词,删除它(避免重复显示)
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
    date,
    time,
    weekday,
    source,
    tag,
    note,
    screenshot,
    body: bodyLines.join('\n').trim(),
    raw: block,
  };
}

// =============================================================
// 3. 主流程
// =============================================================

const grantBtn = document.getElementById('grant-btn');
const grantSection = document.getElementById('grant-section');
const statusEl = document.getElementById('status');
const btnLabel = grantBtn.querySelector('.btn-label');

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
  btnLabel.textContent = '重新允许访问';
}

async function loadAndReport(handle) {
  const files = await listMarkdownFiles(handle);
  const today = new Date().toISOString().slice(0, 10);

  // 解析所有文件
  const allEntries = [];
  for (const f of files) {
    const entries = parseFile(f.text, f.date);
    allEntries.push(...entries);
  }
  const todayEntries = allEntries.filter(e => e.date === today);

  // 统计
  const tagCounts = allEntries.reduce((acc, e) => {
    if (e.tag) acc[e.tag] = (acc[e.tag] || 0) + 1;
    return acc;
  }, {});
  const todoTotal = tagCounts['TODO'] || 0;

  // Console.log 出来,Commit 2 里程碑
  console.group('=== AISecretary Dashboard · 数据快照 ===');
  console.log('Today:', today);
  console.log('Files:', files.length, files.map(f => f.name));
  console.log('All entries:', allEntries.length);
  console.log('Today entries:', todayEntries.length);
  console.log('Tag counts:', tagCounts);
  console.log('--- Today (full) ---');
  console.table(todayEntries.map(e => ({
    time: e.time, source: e.source, tag: e.tag,
    body_preview: (e.body || '').slice(0, 40),
  })));
  console.log('--- Raw entries ---', todayEntries);
  console.groupEnd();

  // 暂时把状态行变成"数据加载预览",Commit 3 替换成完整 UI
  grantSection.style.display = 'none';
  setStatus(
    `✓ 已加载 ${files.length} 个 md · 今日 ${todayEntries.length} 条 · ` +
    `TODO 共 ${todoTotal} · 详见 DevTools Console`,
    'ink'
  );
}

async function tryAutoLoad() {
  const handle = await loadHandle().catch(() => null);
  if (!handle) return; // 第一次,展示默认 grant UI

  const perm = await queryRead(handle).catch(() => 'denied');
  if (perm === 'granted') {
    await loadAndReport(handle);
  } else {
    setRegrantUI();
    setStatus('已记住授权,需你点一次允许', 'muted');
  }
}

grantBtn.addEventListener('click', async () => {
  try {
    let handle = await loadHandle().catch(() => null);

    if (handle) {
      // 有存量 handle:用户手势下尝试 requestPermission
      const perm = await requestRead(handle);
      if (perm === 'granted') {
        await loadAndReport(handle);
        return;
      }
      // 失败,降级到 picker
    }

    handle = await pickFolder();
    await loadAndReport(handle);
  } catch (err) {
    if (err.name === 'AbortError') return; // 用户取消选择
    console.error(err);
    setStatus('出错: ' + err.message, 'accent');
  }
});

tryAutoLoad();
