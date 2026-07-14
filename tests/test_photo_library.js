import assert from 'node:assert/strict';

await import('../chrome-newtab/photo-library.js');
const photos = globalThis.MementoPhotos;

const realShape = `---
date: 2026-07-13
type: memento-daily
---

## 16:52 · 周一 · 截图

普通记录中也可以提到每日第一帧，但不应被误解析。

---

## 17:41 · 周一 · 每日第一帧

> 时间: 2026-07-13 17:41 · Asia/Shanghai
> 天气: 阴 · 31.6°C（体感 36.6°C）
> 天气观测: 2026-07-13T17:30 · Open-Meteo
> 首条记录来源: Codex 真实记录验证

![每日第一帧](./assets/2026-07-13-174100-daily-portrait.jpg)

---
`;

const records = photos.collectSnapshotRecords([
  { date: '2026-07-13', text: realShape },
]);

assert.equal(records.length, 1);
assert.deepEqual(
  {
    date: records[0].date,
    time: records[0].time,
    timezone: records[0].timezone,
    weekday: records[0].weekday,
    weather: records[0].weather,
    observedAt: records[0].observedAt,
    weatherProvider: records[0].weatherProvider,
    source: records[0].source,
    assetName: records[0].assetName,
  },
  {
    date: '2026-07-13',
    time: '17:41',
    timezone: 'Asia/Shanghai',
    weekday: '周一',
    weather: '阴 · 31.6°C（体感 36.6°C）',
    observedAt: '2026-07-13T17:30',
    weatherProvider: 'Open-Meteo',
    source: 'Codex 真实记录验证',
    assetName: '2026-07-13-174100-daily-portrait.jpg',
  }
);
assert.equal(photos.monthKey(records[0]), '2026-07');

const unsafe = photos.normalizeAssetReference('../assets/photo.jpg');
assert.equal(unsafe.assetName, '');
assert.equal(unsafe.issue, '照片路径无效');

const fallbackBlock = `## 08:00 · 周二 · 每日第一帧\r\n\r\n![photo](assets/2026-07-14-080000-daily-portrait-42.jpg)`;
const fallback = photos.parseSnapshotBlock(fallbackBlock.replace(/\\r\\n/g, '\r\n'), '2026-07-14', 0);
assert.equal(fallback.weatherStatus, 'unavailable');
assert.equal(fallback.time, '08:00');
assert.equal(fallback.assetName, '2026-07-14-080000-daily-portrait-42.jpg');

console.log('✓ photo library: parses daily portrait metadata and rejects unsafe paths');
