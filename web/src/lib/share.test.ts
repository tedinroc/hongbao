import { describe, expect, it } from 'vitest';
import { shareUrls } from './share';

describe('shareUrls', () => {
  const link = 'https://hongbao.example/c/31611/7#k=0xabc&c=0xdef';
  const text = '恭喜發財\nA red packet with 8 shares. Tap the link to open one.';

  it('Telegram gets the link and the text as separate parameters', () => {
    const u = new URL(shareUrls(link, text).telegram);
    expect(u.origin + u.pathname).toBe('https://t.me/share/url');
    expect(u.searchParams.get('url')).toBe(link);
    expect(u.searchParams.get('text')).toBe(text);
  });

  it('WhatsApp and LINE get the text with the link on its own line', () => {
    const { whatsapp, line } = shareUrls(link, text);
    const wa = new URL(whatsapp);
    expect(wa.origin + wa.pathname).toBe('https://wa.me/');
    expect(wa.searchParams.get('text')).toBe(`${text}\n${link}`);
    const ln = new URL(line);
    expect(ln.origin + ln.pathname).toBe('https://line.me/R/share');
    expect(ln.searchParams.get('text')).toBe(`${text}\n${link}`);
  });

  it('keeps the fragment (the claim key) inside the encoded parameter', () => {
    for (const u of Object.values(shareUrls(link, text))) {
      expect(new URL(u).hash).toBe('');
      expect(u).toContain(encodeURIComponent('#k=0xabc&c=0xdef'));
    }
  });
});
