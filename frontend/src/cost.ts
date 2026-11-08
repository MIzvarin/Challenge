export interface Cost {
  amount: string;
  currency: 'USD';
  pricing_version: string;
  source: string;
}

export function isCost(value: unknown): value is Cost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 4 || typeof data.amount !== 'string' || data.amount.trim() !== data.amount ||
      !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(data.amount) || data.currency !== 'USD' ||
      typeof data.pricing_version !== 'string' || !data.pricing_version.trim() ||
      typeof data.source !== 'string' || !/^https:\/\/[^/]/i.test(data.source) || /\s/.test(data.source)) return false;
  try {
    const url = new URL(data.source);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch { return false; }
}

function scaled(amount: string, scale: number): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
}

// Compare a decimal amount with a sum without going through binary floats.
export function compareSum(amount: string, parts: string[]): number {
  const scale = Math.max(...[amount, ...parts].map((value) => value.split('.')[1]?.length ?? 0));
  const difference = scaled(amount, scale) - parts.reduce((sum, part) => sum + scaled(part, scale), 0n);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

export function samePricing(costs: Cost[]): boolean {
  return costs.every((cost) => cost.pricing_version === costs[0].pricing_version && cost.source === costs[0].source);
}

export function formatCost(amount: string): string {
  if (compareSum(amount, []) > 0 && compareSum(amount, ['0.000001']) < 0) return '< 0,000001 USD';
  const [whole, fraction = ''] = amount.split('.');
  const digits = fraction.padEnd(7, '0');
  const micros = BigInt(whole) * 1_000_000n + BigInt(digits.slice(0, 6)) + (digits[6] >= '5' ? 1n : 0n);
  const integer = (micros / 1_000_000n).toLocaleString('ru-RU');
  const decimal = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `≈ ${integer}${decimal ? `,${decimal}` : ''} USD`;
}
