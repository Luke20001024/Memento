import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../chrome-newtab/dashboard.js', import.meta.url), 'utf8');

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const asyncStart = source.indexOf(`async function ${name}`);
  const resolvedStart = start >= 0 && (asyncStart < 0 || start < asyncStart) ? start : asyncStart;
  assert.ok(resolvedStart >= 0, `${name} exists`);
  const endCandidates = [
    source.indexOf(`\nfunction ${nextName}`, resolvedStart + 1),
    source.indexOf(`\nasync function ${nextName}`, resolvedStart + 1),
  ].filter(index => index > resolvedStart);
  assert.ok(endCandidates.length, `${name} has a stable boundary`);
  return source.slice(resolvedStart, Math.min(...endCandidates));
}

const cacheHydration = functionSource('startCacheHydration', 'waitForStartupCache');
assert.ok(
  cacheHydration.includes("normalizeReviewData(context.reviewCache, 'cache')")
    && cacheHydration.includes('commitReviewDataToVisibleState('),
  'a directory-bound Review snapshot is installed without waiting for a live Review scan'
);
assert.ok(
  cacheHydration.indexOf('commitReviewDataToVisibleState(')
    < cacheHydration.indexOf('if (!context.cache) return false;'),
  'Review cache remains useful even when the larger raw-record cache misses'
);

const monthHydration = functionSource('hydrateOptionalDashboardData', 'cacheContextForHandle');
for (const contract of [
  'datePrefix: month',
  'onReviewFile: file => commitReviewFileDelta',
  'onReviewStateFile: file => commitReviewFileDelta',
  'replaceReviewMonth',
  'persistReviewData',
]) {
  assert.ok(monthHydration.includes(contract), `selected-month hydration keeps contract: ${contract}`);
}

const openDrawer = functionSource('openDailySummaryDrawer', 'initDailySummaries');
assert.ok(
  openDrawer.includes('scheduleSummaryMonthHydration(activeCoreLoad, selectedSummaryMonth)'),
  'opening Daily Summary starts only the visible month reconciliation'
);

const coreRefresh = functionSource('produceCoreRecords', 'readTodayRecord');
assert.ok(
  coreRefresh.includes("activeDrawerId === 'daily-summary-drawer'")
    && coreRefresh.includes('scheduleSummaryMonthHydration(session, selectedSummaryMonth)'),
  'a background core refresh does not eagerly scan Review directories while the drawer is closed'
);
assert.equal(
  source.includes('scheduleOptionalHydration'),
  false,
  'the former all-history optional hydration path is retired'
);

console.log('✓ daily summary fast path: cache-first paint, drawer-gated selected-month reads, and progressive Review cards');
