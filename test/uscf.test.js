const assert = require('assert');
const { test } = require('node:test');
const { selectUSCFPosts } = require('../src/reddit');

test('selectUSCFPosts: only new, live, recent posts, in thread order', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const day = 86400000;
  const at = (d) => new Date(now - d * day).toISOString();
  const posts = [
    { id: 105, postNumber: 6140, createdAt: at(1), text: 'RIOT924' },
    { id: 90, postNumber: 6120, createdAt: at(2), text: 'seen before' },       // <= high-water
    { id: 101, postNumber: 6131, createdAt: at(20), text: 'too old' },         // past 14 days
    { id: 102, postNumber: 6132, createdAt: at(3), text: 'x', deleted: true }, // deleted
    { id: 103, postNumber: 6133, createdAt: at(3), text: '' },                 // empty
    { id: 104, postNumber: 6134, createdAt: 'garbage', text: 'no date' },     // bad date
    { id: 100, postNumber: 6130, createdAt: at(5), text: '093GC' },
  ];
  const got = selectUSCFPosts(posts, 99, now, 14).map(p => p.postNumber);
  assert.deepStrictEqual(got, [6130, 6140]);
});

test('selectUSCFPosts: first run (no high-water) still respects the age cutoff', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const posts = [
    { id: 1, postNumber: 1, createdAt: '2020-11-17T00:00:00Z', text: 'ancient' },
    { id: 2, postNumber: 2, createdAt: new Date(now - 86400000).toISOString(), text: 'fresh' },
  ];
  assert.deepStrictEqual(selectUSCFPosts(posts, 0, now).map(p => p.id), [2]);
});
