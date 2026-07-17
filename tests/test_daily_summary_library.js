import assert from 'node:assert/strict';

await import('../chrome-newtab/daily-summary-library.js');
const summaries = globalThis.MementoDailySummaries;

const SOURCE_HASH = 'a'.repeat(64);
const NEW_SOURCE_HASH = 'c'.repeat(64);
const PROMPT_HASH = 'b'.repeat(64);
const NEW_PROMPT_HASH = 'd'.repeat(64);

function strictReview(date, options = {}) {
  const sourceHash = options.sourceHash || SOURCE_HASH;
  const promptHash = options.promptHash || PROMPT_HASH;
  const sourceMock = options.sourceMock ?? false;
  const supplement = options.supplement || '无';
  return `---
date: ${date}
type: memento-review
period: daily
source: "[[${date}]]"
source_hash: "${sourceHash}"
source_mock: ${sourceMock}
prompt: memento-comprehensive
prompt_hash: "${promptHash}"
generated_at: ${date}T21:05:00+08:00
---

# Daily Review · ${date}

## 工作与生活现场

- 新章节可以正常读取。

## 行动线索

无

## 灵感与想法

\`\`\`md
## fenced code 不是章节
# fenced code 不是一级标题
\`\`\`

## 个人记录/情绪

无

## 已忽略

无

## 来源索引

- [[${date}]]

## 我的补充

${supplement}
`;
}

const legacyReview = `---
date: 2026-07-13
type: memento-review
period: daily
source: "[[2026-07-13]]"
source_hash: "old-hash"
generated_at: 2026-07-13T16:56:54+08:00
---

# Daily Review · 2026-07-13

## 工作事项

- 今天确认了记录链路。

## TODO 清单

- 继续观察，但不是完成清单。

## 灵感与想法

- Query 只是意图很薄的一次显露。

## 个人记录/情绪

无

## 已忽略

无

## 来源索引

- [[2026-07-13]]

## 我的补充

无
`;

const currentReview = strictReview('2026-07-14', {
  supplement: '用户第一段\n\n## 旧标题\n\n私密尾部仍必须展示。\n\n## 行动线索 \n\n带尾空格的旧标题也是用户正文。',
});

const reviews = summaries.collectReviewRecords([
  { date: '2026-07-13', text: legacyReview, mtime: 1 },
  { date: '2026-07-14', text: currentReview, mtime: 2 },
]);

assert.equal(reviews.length, 2);
assert.equal(reviews[0].fileDate, '2026-07-14');
assert.equal(reviews[0].issues.length, 0, 'a full strict Review satisfies the browser contract');
assert.match(reviews[0].sections.scene, /新章节/);
assert.match(reviews[0].sections.insights, /fenced code 不是章节/);
assert.match(reviews[0].sections.supplement, /## 旧标题/);
assert.match(reviews[0].sections.supplement, /私密尾部仍必须展示/);
assert.match(reviews[0].sections.supplement, /带尾空格的旧标题也是用户正文/);
assert.match(reviews[1].sections.scene, /记录链路/, 'legacy aliases remain readable while awaiting rebuild');
assert.match(reviews[1].sections.actionClues, /不是完成清单/);
assert.match(reviews[1].issues.join(' '), /缺少字段|哈希格式|章节/);

const snapshots = [
  {
    fileDate: '2026-07-13',
    date: '2026-07-14',
    time: '00:01',
    sortKey: '2026-07-14T00:01',
    assetName: 'late.jpg',
    issues: ['记录日期与文件日期不一致'],
  },
  {
    fileDate: '2026-07-13',
    date: '2026-07-13',
    time: '08:00',
    sortKey: '2026-07-13T08:00',
    assetName: 'morning.jpg',
    issues: [],
  },
  {
    fileDate: '2026-07-15',
    date: '2026-07-15',
    time: '09:00',
    sortKey: '2026-07-15T09:00',
    assetName: 'photo-only.jpg',
    issues: [],
  },
];

const reviewStates = summaries.collectReviewStates([
  {
    date: '2026-07-13',
    text: JSON.stringify({
      date: '2026-07-13',
      status: 'failed',
      updated_at: '2026-07-13T21:01:00+08:00',
      message: '模型调用失败',
    }),
    mtime: 3,
  },
  {
    date: '2026-07-12',
    text: JSON.stringify({
      date: '2026-07-12',
      status: 'pending',
      updatedAt: '2026-07-12T21:00:00+08:00',
    }),
    mtime: 2,
  },
]);

assert.equal(reviewStates['2026-07-13'].status, 'failed');
assert.equal(reviewStates['2026-07-13'].updatedAt, '2026-07-13T21:01:00+08:00');
assert.equal(reviewStates['2026-07-12'].updatedAt, '2026-07-12T21:00:00+08:00', 'camelCase remains compatible');

const cards = summaries.buildDayCards(snapshots, reviews, {
  '2026-07-12': 'raw-only-hash',
  '2026-07-13': NEW_SOURCE_HASH,
  '2026-07-14': SOURCE_HASH,
  '2026-07-15': 'photo-only-hash',
}, reviewStates, {
  sourceMocks: {
    '2026-07-12': false,
    '2026-07-13': false,
    '2026-07-14': false,
    '2026-07-15': false,
  },
  promptHash: PROMPT_HASH,
});

assert.deepEqual(cards.map(card => card.dayKey), ['2026-07-15', '2026-07-14', '2026-07-13', '2026-07-12']);
assert.equal(cards[0].review, null, 'photo-only day remains visible');
assert.equal(cards[0].summaryStatus, 'pending');
assert.equal(cards[1].photo, null, 'review-only day remains visible');
assert.equal(cards[1].freshness, 'current');
assert.equal(cards[1].summaryStatus, 'current');
assert.equal(cards[2].review.fileDate, '2026-07-13', 'join uses fileDate, not the explicit photo date');
assert.equal(cards[2].photo.assetName, 'morning.jpg', 'earliest valid photo is selected deterministically');
assert.equal(cards[2].additionalPhotoCount, 1);
assert.equal(cards[2].freshness, 'stale');
assert.equal(cards[2].summaryStatus, 'failed', 'an actual failed run is more important than an older stale review');
assert.match(cards[2].issues.join(' '), /2 张开场照片/);
assert.equal(cards[3].photo, null);
assert.equal(cards[3].review, null);
assert.equal(cards[3].summaryStatus, 'pending', 'a raw Markdown-only day is included and waits for a summary');
assert.equal(summaries.summaryStatus(reviews[1], 'stale', null), 'stale');
assert.equal(summaries.summaryStatus(reviews[1], 'stale', { status: 'pending' }), 'pending', 'an actual running cycle remains pending');
assert.equal(summaries.summaryStatus(reviews[0], 'unknown', null), 'rebuild', 'an unverifiable Review is not current');

const promptChangedReview = summaries.parseReviewFile({
  date: '2026-07-16',
  text: strictReview('2026-07-16'),
});
const promptChanged = summaries.buildDayCards([], [promptChangedReview], {
  '2026-07-16': SOURCE_HASH,
}, {}, {
  sourceMocks: { '2026-07-16': false },
  promptHash: NEW_PROMPT_HASH,
});
assert.equal(promptChanged[0].freshness, 'outdated');
assert.equal(promptChanged[0].summaryStatus, 'rebuild');
assert.match(promptChanged[0].contractIssues.join(' '), /Prompt 已更新/);

const promptUnreadable = summaries.buildDayCards([], [promptChangedReview], {
  '2026-07-16': SOURCE_HASH,
}, {}, {
  sourceMocks: { '2026-07-16': false },
  promptIssue: '当前总结 Prompt 暂时无法读取',
});
assert.equal(promptUnreadable[0].freshness, 'unknown');
assert.equal(promptUnreadable[0].summaryStatus, 'rebuild');
assert.match(promptUnreadable[0].issues.join(' '), /Prompt 暂时无法读取/);

const mockMismatch = summaries.buildDayCards([], [promptChangedReview], {
  '2026-07-16': SOURCE_HASH,
}, {}, {
  sourceMocks: { '2026-07-16': true },
  promptHash: PROMPT_HASH,
});
assert.equal(mockMismatch[0].summaryStatus, 'rebuild');
assert.match(mockMismatch[0].contractIssues.join(' '), /模拟来源标记/);

for (const [label, mutate, expectedIssue] of [
  ['missing prompt_hash', text => text.replace(/^prompt_hash:.*\n/m, ''), /缺少字段: prompt_hash/],
  ['missing section', text => text.replace(/## 已忽略\n\n无\n\n/, ''), /章节缺失|章节不完整/],
  ['unknown metadata', text => text.replace('period: daily\n', 'period: daily\nextra: no\n'), /未知字段: extra/],
  ['invalid calendar timestamp', text => text.replace('T21:05:00+08:00', 'T99:05:00+08:00'), /生成时间/],
  ['duplicate fixed heading in supplement', text => `${text}\n## 行动线索\n\n不允许`, /重复固定章节/],
]) {
  const parsed = summaries.parseReviewFile({ date: '2026-07-16', text: mutate(strictReview('2026-07-16')) });
  assert.match(parsed.issues.join(' '), expectedIssue, label);
  assert.notEqual(summaries.summaryStatus(parsed, 'current', null), 'current', label);
}

const malformedState = summaries.parseReviewStateFile({
  date: '2026-07-16',
  text: '{not-json',
});
assert.equal(malformedState.status, '');
assert.match(malformedState.issues.join(' '), /无法解析/);

const malformed = summaries.parseReviewFile({
  date: '2026-07-16',
  text: '# no frontmatter\n\n## 工作与生活现场\n\n仍尽量读取正文。',
});
assert.match(malformed.issues.join(' '), /缺少总结元数据/);
assert.match(malformed.sections.scene, /尽量读取/);
assert.equal(summaries.summaryStatus(malformed, 'current', null), 'rebuild', 'a structurally invalid review must be rebuilt');

console.log('✓ daily summary library: strict Review contract, source/Prompt freshness and opaque supplement tail');
