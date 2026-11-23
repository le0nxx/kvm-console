const test = require('node:test');
const assert = require('node:assert/strict');
const { gridRects, clampRect } = require('../dist/main/layout.js');

test('3x3 grid fills the area without overlaps', () => {
  const area = { x: 10, y: 60, width: 1600, height: 900 };
  const rects = gridRects(area, { cols: 3, rows: 3, gap: 8, inset: 2 });
  assert.equal(rects.length, 9);

  for (const r of rects) {
    assert.ok(r.width > 0 && r.height > 0);
    assert.ok(r.x >= area.x && r.y >= area.y);
    assert.ok(r.x + r.width <= area.x + area.width);
    assert.ok(r.y + r.height <= area.y + area.height);
  }

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.equal(overlap, false, `tiles ${i} and ${j} overlap`);
    }
  }
});

test('4x3 grid has 12 cells and keeps the 8px gutter', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const rects = gridRects(area, { cols: 4, rows: 3, gap: 8, inset: 2 });
  assert.equal(rects.length, 12);
  const first = rects[0];
  const second = rects[1];
  // inset on both sides + gutter
  assert.equal(second.x - (first.x + first.width), 8 + 4);
});

test('grid works for a 1x1 layout', () => {
  const rects = gridRects({ x: 0, y: 0, width: 800, height: 600 }, { cols: 1, rows: 1, gap: 8, inset: 2 });
  assert.deepEqual(rects, [{ x: 2, y: 2, width: 796, height: 596 }]);
});

test('clampRect keeps tiles inside the window', () => {
  const area = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(clampRect({ x: 90, y: 90, width: 50, height: 50 }, area), {
    x: 90,
    y: 90,
    width: 10,
    height: 10,
  });
  assert.deepEqual(clampRect({ x: -20, y: -20, width: 30, height: 30 }, area), {
    x: 0,
    y: 0,
    width: 30,
    height: 30,
  });
});
