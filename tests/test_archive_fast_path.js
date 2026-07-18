import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../chrome-newtab/dashboard.js', import.meta.url), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`${name}(`);
  const end = source.indexOf(`${nextName}(`, start + name.length);
  assert.ok(start >= 0 && end > start, `${name} is present before ${nextName}`);
  return source.slice(start, end);
}

const refresh = functionSource('async function refreshArchiveIndex', 'function startArchiveIndexRefresh');
const installSkeleton = refresh.indexOf("installArchiveIndexItems(context, visibleItems, 'partial')");
const persistSkeleton = refresh.indexOf('persistArchiveIndex(context)', installSkeleton);
const awaitTitles = refresh.indexOf('await readArchiveItems(entries');
assert.ok(
  installSkeleton >= 0 && awaitTitles > installSkeleton,
  'archive filenames/cached metadata are painted before any full title batch can settle'
);
assert.ok(
  persistSkeleton > installSkeleton && persistSkeleton < awaitTitles,
  'a permanently pending title cannot prevent the next tab from caching the visible filename list'
);
assert.ok(
  refresh.includes('onItem: item =>')
    && refresh.includes('updateArchiveIndexItem(context, item)'),
  'each resolved title updates one visible row progressively'
);

const hydrate = functionSource('async function hydrateArchiveIndexCache', 'async function waitForArchiveIndexCache');
assert.ok(
  hydrate.includes('dashboardCacheRepository.readArchiveIndex')
    && hydrate.includes("installArchiveIndexItems(context, cached.items, 'cache')"),
  'a new tab can install the persistent metadata index without reading archive HTML'
);

const cacheWait = functionSource('async function waitForArchiveIndexCache', 'function persistArchiveIndex');
assert.ok(
  cacheWait.includes('ARCHIVE_CACHE_DECISION_MS') && source.includes('const ARCHIVE_CACHE_DECISION_MS = 120;'),
  'a slow IndexedDB lookup cannot hold the archive drawer indefinitely'
);

const renderStart = source.indexOf('async function renderArchives');
const renderEnd = source.indexOf('// 点击归档', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'archive render flow is present');
const render = source.slice(renderStart, renderEnd);
for (const contract of [
  'operations.startCacheFirstRefresh({',
  'hydrateCache: () => hydrateArchiveIndexCache(context)',
  'waitForCache: waitForArchiveIndexCache',
  'hasVisibleContent: () => archiveIndexState.ready',
  'afterFirstPaint: afterFirstDashboardPaint',
  'startRefresh: () => startArchiveIndexRefresh(context',
]) {
  assert.ok(render.includes(contract), `archive render keeps cache-first contract: ${contract}`);
}
assert.ok(
  render.includes('archiveIndexState.liveVerified'),
  'same-tab verified archive state can skip another directory refresh'
);

const close = functionSource('function closeSideDrawers', 'function resetArchiveIndexState');
assert.equal(
  close.includes('resetArchiveIndexState()'),
  false,
  'closing and reopening the drawer preserves the in-memory archive index'
);

const quarantine = functionSource('function quarantineDirectoryActions', 'function showGrantUI');
assert.ok(
  quarantine.includes('resetArchiveIndexState()'),
  'switching/revoking the actual data directory clears the archive index'
);

const open = functionSource('async function openArchive', 'function openDrawer');
assert.ok(
  open.includes('item.handle')
    && open.includes('getArchiveDir(false, context.handle)')
    && open.includes('getFileHandle(item.name)'),
  'a cached metadata-only row resolves exactly one file only when the user opens it'
);

// Exercise the real same-session refresh gate separately from DOM/FSA. A
// verified list must be reused on reopen, and an in-flight verification must
// be shared instead of spawning another directory traversal.
const refreshGateStart = source.indexOf('function startArchiveIndexRefresh');
const refreshGateEnd = source.indexOf('function extractTitle', refreshGateStart);
assert.ok(refreshGateStart >= 0 && refreshGateEnd > refreshGateStart);
const refreshGate = new Function(`
  const archiveIndexState = {
    session: null,
    items: [],
    ready: false,
    source: 'none',
    liveVerified: false,
    refreshPromise: null,
    refreshId: 0,
    mutationEpoch: 0,
    refreshMutationEpoch: -1,
  };
  let refreshCount = 0;
  let blocked = false;
  let releaseBlocked = null;
  const context = { session: {} };
  function ensureArchiveIndexSession(candidate) {
    if (archiveIndexState.session && archiveIndexState.session !== candidate.session) return false;
    archiveIndexState.session = candidate.session;
    return true;
  }
  function archiveReadContextStillCurrent(candidate) { return candidate === context; }
  function updateArchiveIndexView() {}
  function setArchiveStatus() {}
  function archiveErrorMessage() { return 'error'; }
  let activeDrawerId = null;
  async function refreshArchiveIndex() {
    refreshCount++;
    if (blocked) await new Promise(resolve => { releaseBlocked = resolve; });
    archiveIndexState.items = [{ name: 'cached.html', title: 'Cached', mtime: 1 }];
    archiveIndexState.ready = true;
    archiveIndexState.liveVerified = true;
    return archiveIndexState.items;
  }
  ${source.slice(refreshGateStart, refreshGateEnd)}
  return {
    context,
    startArchiveIndexRefresh,
    getRefreshCount: () => refreshCount,
    block() { blocked = true; },
    release() { blocked = false; releaseBlocked(); },
  };
`)();

await refreshGate.startArchiveIndexRefresh(refreshGate.context);
assert.equal(refreshGate.getRefreshCount(), 1);
await refreshGate.startArchiveIndexRefresh(refreshGate.context);
assert.equal(refreshGate.getRefreshCount(), 1, 'verified same-tab reopen performs zero new FSA refreshes');

refreshGate.block();
const firstPending = refreshGate.startArchiveIndexRefresh(refreshGate.context, { force: true });
const reopenedPending = refreshGate.startArchiveIndexRefresh(refreshGate.context);
assert.equal(firstPending, reopenedPending, 'reopen shares the existing archive refresh promise');
assert.equal(refreshGate.getRefreshCount(), 2);
refreshGate.release();
await firstPending;

console.log('✓ archive fast path: cache-first paint, same-tab reuse, and one-file-on-open contracts');
