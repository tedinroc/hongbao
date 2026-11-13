/** Old pages.dev links move to the new domain without breaking API calls or open tabs (functions/_lib/legacyHost.ts). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { legacyRedirect } from '../functions/_lib/legacyHost';
import { withNoTransform } from '../functions/_lib/noInject';

const OLD = 'https://hongbao-mezo.pages.dev';
const NEW = 'https://hongbao.trytry.net';
const nav = { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' };
const req = (url: string, headers: Record<string, string> = nav, method = 'GET') => new Request(url, { method, headers });

describe('legacy host redirect', () => {
  it('sends page loads on the old host to the same path and query on the new host', () => {
    expect(legacyRedirect(req(`${OLD}/`))).toBe(`${NEW}/`);
    expect(legacyRedirect(req(`${OLD}/c/31612/7?x=1`))).toBe(`${NEW}/c/31612/7?x=1`);
    expect(legacyRedirect(req(`${OLD}/deck.pdf`))).toBe(`${NEW}/deck.pdf`);
    expect(legacyRedirect(req(`${OLD}/video/`, nav, 'HEAD'))).toBe(`${NEW}/video/`);
  });

  it('never puts the fragment in the target (the browser keeps it, the server never sees it)', () => {
    const to = legacyRedirect(req(`${OLD}/c/31612/7#k=0xabc&c=0xdef`));
    expect(to).toBe(`${NEW}/c/31612/7`);
  });

  it('treats a client without fetch metadata as a page load only when it asks for HTML', () => {
    expect(legacyRedirect(req(`${OLD}/ledger`, { accept: 'text/html' }))).toBe(`${NEW}/ledger`);
    expect(legacyRedirect(req(`${OLD}/ledger`, {}))).toBeNull();
  });

  it('leaves everything else alone', () => {
    expect(legacyRedirect(req(`${NEW}/`))).toBeNull();
    expect(legacyRedirect(req('https://df41e43f.hongbao-mezo.pages.dev/'))).toBeNull();
    expect(legacyRedirect(req(`${OLD}/api/config`))).toBeNull();
    expect(legacyRedirect(req(`${OLD}/api`))).toBeNull();
    expect(legacyRedirect(req(`${OLD}/me`))).toBeNull(); // phone wallets made on the old host stay reachable
    expect(legacyRedirect(req(`${OLD}/api/claim`, nav, 'POST'))).toBeNull();
    expect(legacyRedirect(req(`${OLD}/assets/index.js`, { 'sec-fetch-mode': 'cors', accept: '*/*' }))).toBeNull();
    expect(legacyRedirect(req(`${OLD}/snapshot.json`, { 'sec-fetch-mode': 'cors', accept: 'text/html' }))).toBeNull();
  });
});

describe('no-transform on HTML', () => {
  const res = (type: string, cc?: string) =>
    new Response('<html></html>', { headers: { 'content-type': type, ...(cc ? { 'cache-control': cc } : {}) } });

  it('marks every HTML page so the edge cannot inject scripts', () => {
    expect(withNoTransform(res('text/html; charset=utf-8')).headers.get('cache-control')).toBe('no-transform');
    expect(withNoTransform(res('text/html', 'public, max-age=0, must-revalidate')).headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate, no-transform',
    );
    expect(withNoTransform(res('text/html', 'no-store, no-transform')).headers.get('cache-control')).toBe('no-store, no-transform');
  });

  it('leaves other responses alone', () => {
    expect(withNoTransform(res('application/json')).headers.get('cache-control')).toBeNull();
    expect(withNoTransform(res('application/pdf', 'public, max-age=3600')).headers.get('cache-control')).toBe('public, max-age=3600');
  });
});

describe('public/_routes.json', () => {
  const routes = JSON.parse(readFileSync(fileURLToPath(new URL('../public/_routes.json', import.meta.url)), 'utf8')) as {
    include: string[];
    exclude: string[];
  };
  const matches = (rule: string, path: string) =>
    rule.endsWith('/*') ? path.startsWith(rule.slice(0, -1)) || path === rule.slice(0, -2) : path === rule;
  const runsFunctions = (path: string) =>
    routes.include.some((r) => matches(r, path)) && !routes.exclude.some((r) => matches(r, path));

  it('runs functions for every page, link and API route', () => {
    for (const p of ['/', '/send', '/me', '/ledger', '/c/31612/7', '/deck.pdf', '/video/', '/api/config', '/api/claim']) {
      expect(runsFunctions(p), p).toBe(true);
    }
  });

  it('serves static files without invoking functions', () => {
    for (const p of ['/assets/index-abc.js', '/brand/logo.svg', '/og.jpg', '/snapshot.json', '/video/hongbao-pitch.mp4']) {
      expect(runsFunctions(p), p).toBe(false);
    }
  });
});
