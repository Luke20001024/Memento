import assert from 'node:assert/strict';
import fs from 'node:fs';

const dashboard = fs.readFileSync(new URL('../chrome-newtab/dashboard.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../chrome-newtab/dashboard.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../chrome-newtab/dashboard.html', import.meta.url), 'utf8');
const demo = fs.readFileSync(new URL('../docs/Memento.html', import.meta.url), 'utf8');

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `${startText} is present before ${endText}`);
  return source.slice(start, end);
}

const renderHeatmap = between(dashboard, 'function renderHeatmap()', 'function formatRecordDate');
for (const contract of [
  'operations.buildHeatmapDays(',
  'class="heat-item${selectedClass}"',
  'class="heat-cell${levelClass}"',
  'data-date="${day.date}"',
  'aria-label="${escapeHtml(ariaLabel)}"',
  'aria-current="date"',
  'tabindex="${day.selected ? \'0\' : \'-1\'}"',
  'class="heat-tooltip"',
  'bindHeatmapInteractions(heatmap)',
]) {
  assert.ok(renderHeatmap.includes(contract), `heatmap rendering keeps contract: ${contract}`);
}

const selectSource = between(dashboard, 'function selectHeatmapDate', 'function bindHeatmapInteractions');
for (const forbidden of [
  'getFile(',
  'getFileHandle(',
  'listMarkdownFiles',
  'readTodayMarkdownFile',
  'dashboardCacheRepository',
  'renderDashboard(',
]) {
  assert.equal(
    selectSource.includes(forbidden),
    false,
    `selecting a heatmap day performs zero physical/cache work: ${forbidden}`
  );
}

const selectionHarness = new Function(`
  const state = { selectedDate: '2026-07-18', currentFilter: '灵感' };
  const calls = { update: 0, render: 0, scroll: 0 };
  function heatmapDateIsVisible(date) { return /^2026-07-(1[0-8])$/.test(date); }
  function updateHeatmapSelection() { calls.update++; }
  function renderSelectedDateSection() { calls.render++; }
  function scrollToSelectedDateSection() { calls.scroll++; }
  ${selectSource}
  return { state, calls, selectHeatmapDate };
`)();

assert.equal(selectionHarness.selectHeatmapDate('2026-07-14', { scroll: true }), true);
assert.deepEqual(selectionHarness.state, { selectedDate: '2026-07-14', currentFilter: 'all' });
assert.deepEqual(selectionHarness.calls, { update: 1, render: 1, scroll: 1 });

selectionHarness.state.currentFilter = 'TODO';
assert.equal(selectionHarness.selectHeatmapDate('2026-07-14'), true);
assert.equal(selectionHarness.state.currentFilter, 'TODO', 'reselecting the same day preserves its tag filter');
assert.deepEqual(selectionHarness.calls, { update: 2, render: 2, scroll: 1 });

assert.equal(selectionHarness.selectHeatmapDate('2026-06-01', { scroll: true }), false);
assert.deepEqual(selectionHarness.calls, { update: 2, render: 2, scroll: 1 });

const interaction = between(dashboard, 'function bindHeatmapInteractions', 'function renderChips');
for (const contract of [
  "event.target.closest('.heat-item')",
  "selectHeatmapDate(button.dataset.date, { scroll: true })",
  "['ArrowLeft', 'ArrowRight', 'Home', 'End']",
  'candidate.tabIndex = index === targetIndex ? 0 : -1',
  'focus({ preventScroll: true })',
]) {
  assert.ok(interaction.includes(contract), `heatmap input keeps contract: ${contract}`);
}

const commit = between(dashboard, 'function commitCoreRecordView', 'async function hydrateOptionalDashboardData');
assert.ok(
  commit.includes('state.selectedDate = state.selectedDate')
    && commit.includes('state.selectedDate >= dateOffset(today, -89)')
    && commit.includes('? state.selectedDate')
    && commit.includes(': today'),
  'cache, partial, and fresh commits preserve a selected date inside the 90-day window'
);
const quarantine = between(dashboard, 'function quarantineDirectoryActions', 'function showGrantUI');
assert.ok(quarantine.includes('state.selectedDate = null'), 'switching directory clears the old selection');

for (const contract of [
  'grid-template-columns: repeat(90, minmax(2px, 1fr))',
  'min-height: 40px',
  'transform: scaleY(var(--heat-scale))',
  'transform-origin: center bottom',
  '.heat-item:has(+ .heat-item:is(:hover, :focus-within))',
  '--heat-scale: 2.65',
  '.heat-tooltip',
  '@media (prefers-reduced-motion: reduce)',
  '--heat-scale: 1 !important',
]) {
  assert.ok(css.includes(contract), `heatmap motion keeps contract: ${contract}`);
}
const heatCellCss = between(css, '.heat-cell {', '.heat-cell.l1');
assert.equal(heatCellCss.includes('height 180ms'), false, 'height is never animated');
assert.equal(heatCellCss.includes('width 180ms'), false, 'width is never animated');

assert.ok(
  html.includes('id="heatmap" class="heatmap" role="list"')
    && html.includes('aria-label="过去 90 天记录热力图"')
    && html.includes('id="record-date-label" aria-live="polite"'),
  'the heatmap and changing date label expose accessible names'
);

const demoHeatmap = between(demo, 'function renderHeatmap()', 'function updateHeatmapSelection');
for (const contract of [
  'for (var i = 0; i < 90; i += 1)',
  'demoDateOffset(demoTodayDate, i - 89)',
  'recordsForDate(date).length',
  "make('span', 'heat-item'",
  "make('button', 'heat-cell'",
  "make('span', 'heat-tooltip')",
  "button.setAttribute('aria-label'",
]) {
  assert.ok(demoHeatmap.includes(contract), `single-file demo heatmap keeps contract: ${contract}`);
}
assert.equal(demoHeatmap.includes('var active ='), false, 'demo heat levels come from record counts, not a second hard-coded source');

const demoEntries = between(demo, 'function renderEntries(filter)', 'function renderHeatmap()');
assert.ok(
  demoEntries.includes('recordsForDate(selectedDate)')
    && demoEntries.includes("entry.tag === filter")
    && demoEntries.includes('right.time.localeCompare(left.time)'),
  'demo details use the selected in-memory day, current tag, and newest-first order'
);

const demoSelectSource = between(demo, 'function selectDemoDate', 'function updateCopyLabel');
for (const forbidden of [
  'renderHeatmap(',
  'fetch(',
  'indexedDB',
  'getFile(',
  'getFileHandle(',
  'srcdoc',
]) {
  assert.equal(
    demoSelectSource.includes(forbidden),
    false,
    `demo date selection stays memory-only and local: ${forbidden}`
  );
}

const demoSelectionHarness = new Function(`
  var demoTodayDate = '2026-07-14';
  var selectedDate = demoTodayDate;
  var currentFilter = '灵感';
  var calls = { update: 0, render: 0 };
  function demoDateOffset(baseDate, deltaDays) { return deltaDays === -89 ? '2026-04-16' : baseDate; }
  function updateHeatmapSelection() { calls.update++; }
  function renderSelectedDateSection() { calls.render++; }
  ${demoSelectSource}
  return {
    calls,
    selectDemoDate,
    state: function () { return { selectedDate, currentFilter }; }
  };
`)();

assert.equal(demoSelectionHarness.selectDemoDate('2026-07-13', false), true);
assert.deepEqual(demoSelectionHarness.state(), { selectedDate: '2026-07-13', currentFilter: 'all' });
assert.deepEqual(demoSelectionHarness.calls, { update: 1, render: 1 });
assert.equal(demoSelectionHarness.selectDemoDate('2026-07-13', false), true);
assert.deepEqual(demoSelectionHarness.calls, { update: 2, render: 2 });
assert.equal(demoSelectionHarness.selectDemoDate('2026-04-15', false), false);
assert.deepEqual(demoSelectionHarness.calls, { update: 2, render: 2 });

const demoCopy = between(demo, 'function buildDemoText', 'async function copyText');
assert.ok(
  demoCopy.includes('entries.map(function (entry)') && !demoCopy.includes('recordsForDate'),
  'choosing a historical demo date does not change the today-oriented copy CTA'
);

for (const contract of [
  'id="demo-heatmap" role="list"',
  'id="demo-record-date-label" aria-live="polite"',
  '.heat-item:has(+ .heat-item:is(:hover, :focus-within))',
  "selectDemoDate(item.dataset.date, true)",
  "['ArrowLeft', 'ArrowRight', 'Home', 'End']",
  'renderSelectedDateSection();',
]) {
  assert.ok(demo.includes(contract), `single-file demo exposes the production interaction: ${contract}`);
}

console.log('✓ heatmap navigation: extension and single-file demo use memory-only date switching, mountain motion, roving focus, and stable refresh state');
