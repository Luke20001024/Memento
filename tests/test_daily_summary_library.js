import assert from 'node:assert/strict';

await import('../chrome-newtab/daily-summary-library.js');
const summaries = globalThis.MementoDailySummaries;

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
`;

const currentReview = `---
date: 2026-07-14
type: memento-review
period: daily
source: "[[2026-07-14]]"
source_hash: "same-hash"
generated_at: 2026-07-14T21:05:00+08:00
---

# Daily Review · 2026-07-14

## 工作与生活现场

- 新章节可以正常读取。

## 行动线索

无

## 灵感与想法

<script>alert('no')</script>
`;

const reviews = summaries.collectReviewRecords([
  { date: '2026-07-13', text: legacyReview, mtime: 1 },
  { date: '2026-07-14', text: currentReview, mtime: 2 },
]);

assert.equal(reviews.length, 2);
assert.equal(reviews[0].fileDate, '2026-07-14');
assert.match(reviews[0].sections.scene, /新章节/);
assert.match(reviews[0].sections.insights, /<script>/);
assert.match(reviews[1].sections.scene, /记录链路/);
assert.match(reviews[1].sections.actionClues, /不是完成清单/);

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
  '2026-07-13': 'new-hash',
  '2026-07-14': 'same-hash',
  '2026-07-15': 'photo-only-hash',
}, reviewStates);

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

console.log('✓ daily summary library: includes raw record days and exposes pending/current/stale/failed states');
