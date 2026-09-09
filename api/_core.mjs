// Shared logic for the serverless functions AND the Vite dev middleware
// (files starting with _ in /api are not exposed as endpoints by Vercel).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 2600 * 1024; // YouTube result pages are heavy
const TIMEOUT_MS = 9000;

function isPrivateIp(ip) {
  if (ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

async function assertPublicHost(hostname) {
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw new Error('blocked host');
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('blocked host');
    return;
  }
  const addrs = await lookup(hostname, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('blocked host');
  }
}

/** Fetch a public web page and return its text content (SSRF-guarded). */
export async function proxyFetch(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('bad url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad scheme');
  await assertPublicHost(url.hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MacWeb/1.0; +https://apple-macintosh.vercel.app)',
        Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    const finalUrl = new URL(res.url || url.href);
    await assertPublicHost(finalUrl.hostname); // redirects must stay public too
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type && !type.startsWith('text/') && type !== 'application/xhtml+xml') {
      return { ok: false, status: res.status, url: finalUrl.href, error: `not text (${type})` };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total >= MAX_BYTES) {
        void reader.cancel();
        break;
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { ok: true, status: res.status, url: finalUrl.href, contentType: type, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---- shared guestbook on Vercel Blob (private store, token from env) ----

import { put as blobPut, get as blobGet } from '@vercel/blob';

const NOTES_PATH = 'guestbook.json';

export function guestbookAvailable() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function guestbookList() {
  try {
    const res = await blobGet(NOTES_PATH, { access: 'private' });
    if (!res || res.statusCode !== 200 || !res.stream) return [];
    const notes = JSON.parse(await new Response(res.stream).text());
    return Array.isArray(notes) ? notes.slice(0, 50) : [];
  } catch {
    return []; // not created yet
  }
}

export async function guestbookAdd(note) {
  const clean = String(note).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
  if (!clean) return guestbookList();
  const notes = await guestbookList();
  notes.unshift(clean);
  const trimmed = notes.slice(0, 50);
  await blobPut(NOTES_PATH, JSON.stringify(trimmed), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  return trimmed;
}
