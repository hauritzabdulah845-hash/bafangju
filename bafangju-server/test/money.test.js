'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { yuanToFen, fenToYuan, splitEven, splitByWeights } = require('../src/domain/money');

test('yuanToFen 精度安全', () => {
  assert.strictEqual(yuanToFen(10), 1000);
  assert.strictEqual(yuanToFen(0.1), 10);
  assert.strictEqual(yuanToFen('8.5'), 850);
  assert.throws(() => yuanToFen(NaN));
  assert.strictEqual(fenToYuan(850), 8.5);
});

test('splitEven 合计守恒', () => {
  assert.deepStrictEqual(splitEven(100, 3), [34, 33, 33]);
  assert.deepStrictEqual(splitEven(10, 2), [5, 5]);
  const s = splitEven(997, 7);
  assert.strictEqual(s.reduce((a, b) => a + b, 0), 997);
});

test('splitByWeights 合计守恒且非负', () => {
  const w = [60, 25, 15];
  const r = splitByWeights(12345, w);
  assert.strictEqual(r.reduce((a, b) => a + b, 0), 12345);
  assert.ok(r.every((x) => x >= 0));
  // 全 0 权重 -> 全 0
  assert.deepStrictEqual(splitByWeights(500, [0, 0]), [0, 0]);
});
