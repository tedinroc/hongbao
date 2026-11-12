import { formatUnits, parseUnits, type Address } from 'viem';
import type { TFunction } from '../i18n';

/** Group the integer part with thin commas: 12345.6 -> "12,345.6". */
function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format an 18-decimal amount for people. `maxFrac` caps the decimals; trailing zeros
 * are trimmed down to `minFrac`. Values that would print as zero but are not get "<0.0…1".
 */
export function formatAmount(wei: bigint, maxFrac = 2, minFrac = 0, decimals = 18): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const s = formatUnits(abs, decimals);
  const [i, f = ''] = s.split('.');
  // Round half up at maxFrac.
  let frac = f.padEnd(maxFrac + 1, '0');
  let intPart = BigInt(i);
  let fracNum = maxFrac > 0 ? BigInt(frac.slice(0, maxFrac)) : 0n;
  if (Number(frac[maxFrac] ?? '0') >= 5) {
    fracNum += 1n;
    if (maxFrac === 0 || fracNum >= 10n ** BigInt(maxFrac)) {
      intPart += 1n;
      fracNum = 0n;
    }
  }
  frac = maxFrac > 0 ? fracNum.toString().padStart(maxFrac, '0') : '';
  while (frac.length > minFrac && frac.endsWith('0')) frac = frac.slice(0, -1);
  if (abs > 0n && intPart === 0n && /^0*$/.test(frac)) {
    return `${neg ? '-' : ''}<0.${'0'.repeat(Math.max(0, maxFrac - 1))}1`;
  }
  return `${neg ? '-' : ''}${group(intPart.toString())}${frac ? `.${frac}` : ''}`;
}

/** MUSD: two decimals, more for tiny amounts. */
export function fmtMusd(wei: bigint): string {
  if (wei > 0n && wei < 10n ** 16n) return formatAmount(wei, 6);
  return formatAmount(wei, 2, 2);
}

/** BTC: up to 8 decimals. */
export function fmtBtc(wei: bigint): string {
  return formatAmount(wei, 8);
}

/** MEZO rewards: 6 decimals so a live counter visibly moves. */
export function fmtMezo(wei: bigint): string {
  return formatAmount(wei, 6, 6);
}

/** Parse what a person typed as an 18-decimal amount. Returns null when invalid. */
export function parseAmountInput(input: string, decimals = 18): bigint | null {
  const s = input.trim().replace(/,/g, '').replace(/[．。]/g, '.');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) return null;
  try {
    return parseUnits(`${i || '0'}${f ? `.${f}` : ''}`, decimals);
  } catch {
    return null;
  }
}

export function shortAddress(a: Address | string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Hongbao.MAX_MESSAGE_BYTES */
export const MESSAGE_MAX_BYTES = 200;

/**
 * Bidirectional-text controls (LRM, RLM, ALM and the embedding, override and isolate marks).
 * In a sender's message they can make text read in a different order than it is stored.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** C0 / C1 control characters other than tab and newline. */
const OTHER_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Remove bidi and other control characters (tab and newline stay). */
export function stripControls(raw: string): string {
  return raw.replace(BIDI_CONTROLS, '').replace(OTHER_CONTROLS, '');
}

/**
 * A sender's message made safe to show as plain text: bidi and other control characters
 * removed, and cut to at most 200 UTF-8 bytes without splitting a character. Render the
 * result as a text node only.
 */
export function cleanMessage(raw: string): string {
  const s = stripControls(raw);
  if (utf8Bytes(s) <= MESSAGE_MAX_BYTES) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (bytes + n > MESSAGE_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** Duration in seconds -> "2d 3h", "5h 12m", "8m". */
export function formatDuration(seconds: number, t: TFunction): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return t('time.lessMinute');
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(t('time.d', { n: d }));
  if (h && parts.length < 2) parts.push(t('time.h', { n: h }));
  if (!d && m && parts.length < 2) parts.push(t('time.m', { n: m }));
  return parts.join(' ');
}

export function formatDateTime(ms: number, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function pct(bps: bigint | number): string {
  const n = Number(bps) / 100;
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')}%`;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
