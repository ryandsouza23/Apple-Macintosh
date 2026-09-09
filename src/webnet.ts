import type { FinderCanvas, WebBlock } from './finder';

// Network layer for MacWeb and the shared guestbook. Pages come through the
// site's own /api/fetch proxy (SSRF-guarded server side) and are stripped to
// text + links here with DOMParser — parsed documents never execute scripts.

const BLOCK_TAGS = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,dt,dd,figcaption';
const MAX_BLOCKS = 400;
const MAX_LINKS = 240;

function parsePage(
  body: string,
  baseUrl: string,
  contentType: string,
): { title: string; blocks: WebBlock[]; links: string[] } {
  if (contentType && !contentType.includes('html')) {
    const blocks: WebBlock[] = body
      .split(/\r?\n/)
      .slice(0, MAX_BLOCKS)
      .map((line) => ({ style: 'pre' as const, runs: [{ text: line || ' ' }] }));
    return { title: baseUrl, blocks, links: [] };
  }
  const doc = new DOMParser().parseFromString(body, 'text/html');
  doc.querySelectorAll('script,style,noscript,template,svg,iframe,head').forEach((el) => el.remove());

  const links: string[] = [];
  const blocks: WebBlock[] = [];

  const styleFor = (tag: string): WebBlock['style'] => {
    if (/^h[1-6]$/.test(tag)) return 'h';
    if (tag === 'li') return 'li';
    if (tag === 'pre') return 'pre';
    return 'p';
  };

  const runsOf = (el: Element): { text: string; link?: number }[] => {
    const runs: { text: string; link?: number }[] = [];
    const push = (text: string, link?: number): void => {
      const clean = text.replace(/\s+/g, ' ');
      if (!clean.trim()) return;
      const last = runs[runs.length - 1];
      if (last && last.link === link) last.text += ` ${clean}`;
      else runs.push(link === undefined ? { text: clean } : { text: clean, link });
    };
    const walk = (node: Node, link?: number): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        push(node.textContent || '', link);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el2 = node as Element;
      const tag = el2.tagName.toLowerCase();
      if (tag === 'a' && link === undefined) {
        const href = el2.getAttribute('href');
        let resolved: string | null = null;
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const u = new URL(href, baseUrl);
            if (u.protocol === 'http:' || u.protocol === 'https:') resolved = u.href;
          } catch {
            /* unresolvable href */
          }
        }
        if (resolved && links.length < MAX_LINKS) {
          links.push(resolved);
          const idx = links.length - 1;
          el2.childNodes.forEach((c) => walk(c, idx));
          return;
        }
      }
      el2.childNodes.forEach((c) => walk(c, link));
    };
    el.childNodes.forEach((c) => walk(c));
    return runs;
  };

  const seen = new Set<Element>();
  doc.body?.querySelectorAll(BLOCK_TAGS).forEach((el) => {
    if (blocks.length >= MAX_BLOCKS) return;
    // skip if a captured ancestor already owns this text
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (seen.has(p)) return;
    }
    const runs = runsOf(el);
    if (!runs.length) return;
    seen.add(el);
    blocks.push({ style: styleFor(el.tagName.toLowerCase()), runs });
  });

  // sparse pages (heavy div soup): fall back to body text
  if (blocks.length < 2 && doc.body) {
    (doc.body.textContent || '')
      .split(/\n+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 1)
      .slice(0, MAX_BLOCKS)
      .forEach((line) => blocks.push({ style: 'p', runs: [{ text: line }] }));
  }

  let title = (doc.querySelector('title')?.textContent || '').trim();
  if (!title) {
    try {
      title = new URL(baseUrl).hostname;
    } catch {
      title = baseUrl;
    }
  }
  return { title, blocks, links };
}

function youTubeWatchId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return /^[\w-]{11}$/.test(u.pathname.slice(1, 12)) ? u.pathname.slice(1, 12) : null;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      if (u.pathname === '/watch') {
        const v = u.searchParams.get('v');
        return v && /^[\w-]{11}$/.test(v) ? v : null;
      }
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a url */
  }
  return null;
}

function isYouTubeListing(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Pull videoRenderer entries out of YouTube's HTML without a full JSON parse
 *  (the page is huge and may be truncated by the proxy's size cap). */
function extractYouTubeResults(html: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  const re = /"videoRenderer":\{"videoId":"([\w-]{11})".{0,4000}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 15) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let title = m[2];
    try {
      title = JSON.parse(`"${m[2]}"`) as string;
    } catch {
      /* keep escaped form */
    }
    out.push({ id: m[1], title });
  }
  return out;
}

export function setupWeb(finder: FinderCanvas): void {
  finder.onWebNavigate = async (url: string) => {
    const watchId = youTubeWatchId(url);
    if (watchId) {
      finder.webShowVideo(watchId, url);
      return;
    }
    finder.webLoading(url);
    try {
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
      const json = (await res.json()) as {
        ok: boolean;
        url?: string;
        contentType?: string;
        body?: string;
        error?: string;
      };
      if (!json.ok || !json.body) {
        finder.webError(json.error || 'could not load the page');
        return;
      }
      const finalUrl = json.url || url;
      if (isYouTubeListing(finalUrl)) {
        const vids = extractYouTubeResults(json.body);
        if (vids.length) {
          const links = vids.map((v) => `https://www.youtube.com/watch?v=${v.id}`);
          const blocks: WebBlock[] = [
            { style: 'h', runs: [{ text: 'YouTube' }] },
            ...vids.map((v, i) => ({ style: 'li' as const, runs: [{ text: v.title, link: i }] })),
            { style: 'p', runs: [{ text: 'Click a title to play it on the tube. Type yt: words to search again.' }] },
          ];
          finder.webLoaded('YouTube', blocks, links, finalUrl);
          return;
        }
      }
      const { title, blocks, links } = parsePage(json.body, finalUrl, json.contentType || '');
      finder.webLoaded(title, blocks, links, finalUrl);
    } catch {
      finder.webError('network error');
    }
  };
}

export function setupSharedGuestbook(finder: FinderCanvas): void {
  void fetch('/api/guestbook')
    .then(async (res) => {
      const json = (await res.json()) as { ok: boolean; notes?: string[] };
      if (!json.ok || !Array.isArray(json.notes)) return; // no store: stay local
      finder.guest.notes = json.notes.slice(0, 50);
      finder.draw();
      finder.onGuestNote = (note: string) => {
        void fetch('/api/guestbook', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        })
          .then(async (r) => {
            const j = (await r.json()) as { ok: boolean; notes?: string[] };
            if (j.ok && Array.isArray(j.notes)) {
              finder.guest.notes = j.notes.slice(0, 50);
              finder.draw();
            }
          })
          .catch(() => undefined);
      };
    })
    .catch(() => undefined);
}
