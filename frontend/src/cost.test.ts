import { expect, it } from 'vitest';
import { compareSum, formatCost, isCost } from './cost';
import { makeCost } from './test-fixtures';

it.each([
  ['0', '≈ 0 USD'], ['0.00000000001', '< 0,000001 USD'],
  ['0.000001', '≈ 0,000001 USD'], ['0.001446', '≈ 0,001446 USD'],
  ['0.0014467', '≈ 0,001447 USD'], ['0.9999999', '≈ 1 USD'],
  ['1234567.1200', '≈ 1 234 567,12 USD'],
  ['9007199254740993.000001', '≈ 9 007 199 254 740 993,000001 USD'],
])('formats %s without float loss', (amount, expected) => {
  expect(formatCost(amount)).toBe(expected);
});

it('compares exact sums with different scales', () => {
  expect(compareSum('0.3', ['0.1', '0.20'])).toBe(0);
  expect(compareSum('0.00000000001', ['0.00000000002'])).toBe(-1);
  expect(compareSum('9007199254740993.000000001', ['9007199254740993'])).toBe(1);
  expect(isCost(makeCost())).toBe(true);
  expect(isCost(makeCost('0\n'))).toBe(false);
  expect(isCost({ ...makeCost(), source: 'https:example.com' })).toBe(false);
  expect(isCost({ ...makeCost(), source: 'https:///example.com' })).toBe(false);
});
