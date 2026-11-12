import { describe, expect, it } from 'vitest';
import { fmtBtc, fmtMusd, formatAmount, formatDuration, parseAmountInput, pct, utf8Bytes } from './format';
import { translate } from '../i18n';

const E18 = 10n ** 18n;

describe('amount formatting', () => {
  it('formats MUSD with two decimals and grouping', () => {
    expect(fmtMusd(12345n * E18 + 6n * 10n ** 17n)).toBe('12,345.60');
    expect(fmtMusd(0n)).toBe('0.00');
    expect(fmtMusd(99n * 10n ** 16n)).toBe('0.99');
  });

  it('rounds half up and carries into the integer part', () => {
    expect(formatAmount(1_995n * 10n ** 15n, 2)).toBe('2');
    expect(formatAmount(1_994n * 10n ** 15n, 2)).toBe('1.99');
  });

  it('shows tiny values instead of zero', () => {
    expect(fmtMusd(1n)).toBe('<0.000001');
    expect(fmtBtc(3_000_000_000_000n)).toBe('0.000003');
  });

  it('parses what people type', () => {
    expect(parseAmountInput('8.88')).toBe(888n * 10n ** 16n);
    expect(parseAmountInput('1,000')).toBe(1000n * E18);
    expect(parseAmountInput('.5')).toBe(5n * 10n ** 17n);
    expect(parseAmountInput('8．8')).toBe(88n * 10n ** 17n);
    expect(parseAmountInput('')).toBeNull();
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('1.2.3')).toBeNull();
  });

  it('percent from basis points', () => {
    expect(pct(100n)).toBe('1%');
    expect(pct(150)).toBe('1.5%');
  });

  it('counts message bytes as UTF-8', () => {
    expect(utf8Bytes('恭喜發財')).toBe(12);
    expect(utf8Bytes('Good fortune')).toBe(12);
  });

  it('formats durations', () => {
    const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number | bigint>) => translate('en', k, v);
    expect(formatDuration(30, t)).toBe('under a minute');
    expect(formatDuration(3 * 3600 + 20 * 60, t)).toBe('3h 20m');
    expect(formatDuration(2 * 86400 + 5 * 3600, t)).toBe('2d 5h');
  });
});
