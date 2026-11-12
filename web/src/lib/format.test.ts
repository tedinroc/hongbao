import { describe, expect, it } from 'vitest';
import { cleanMessage, fmtBtc, fmtMusd, formatAmount, formatDuration, parseAmountInput, pct, utf8Bytes } from './format';
import { dictionaries, translate } from '../i18n';

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

describe('sender messages are untrusted text', () => {
  it('removes bidi controls that would reorder what people read', () => {
    // RLO makes "gpj.exe" display reversed; isolates and marks are dropped too.
    expect(cleanMessage('pay\u202Egpj.exe')).toBe('paygpj.exe');
    expect(cleanMessage('\u2066a\u2069\u200Fb\u200E\u061Cc\u202A\u202B\u202C\u202D\u2067\u2068')).toBe('abc');
  });

  it('removes other control characters and keeps newlines, tabs, emoji and CJK', () => {
    expect(cleanMessage('a\u0000b\u0007c\u007Fd\u009Fe')).toBe('abcde');
    expect(cleanMessage('恭喜發財\n新年快樂\t👨‍👩‍👧')).toBe('恭喜發財\n新年快樂\t👨‍👩‍👧');
  });

  it('caps at 200 UTF-8 bytes without splitting a character', () => {
    const zh = '福'.repeat(80); // 240 bytes
    const out = cleanMessage(zh);
    expect(utf8Bytes(out)).toBe(198);
    expect(out).toBe('福'.repeat(66));
    expect(cleanMessage('a'.repeat(250))).toBe('a'.repeat(200));
    const emoji = 'x'.repeat(198) + '🧧';
    expect(cleanMessage(emoji)).toBe('x'.repeat(198));
  });

  it('leaves markup as literal text (React renders it as a text node)', () => {
    expect(cleanMessage('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('copy', () => {
  it('both languages have the same keys and no em-dash asides in English', () => {
    expect(Object.keys(dictionaries['zh-Hant']).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const [k, v] of Object.entries(dictionaries.en)) expect([k, v.includes('—')]).toEqual([k, false]);
  });

  it('explains Earn MEZO, Save and where unclaimed savings interest goes', () => {
    const en = dictionaries.en;
    expect(en['payout.stake.body']).toMatch(/gauge/);
    expect(en['payout.stake.body']).toMatch(/MEZO instead of MUSD savings interest/);
    expect(en['payout.save.body']).toMatch(/sMUSD.*MUSD savings interest/);
    expect(en['send.yieldNote']).toMatch(/Hongbao treasury/);
  });
});
