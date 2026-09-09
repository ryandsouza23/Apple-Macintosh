import { proxyFetch } from './_core.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  if (!url) {
    res.status(400).json({ ok: false, error: 'missing url' });
    return;
  }
  try {
    const out = await proxyFetch(url);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ ok: false, error: e instanceof Error ? e.message : 'fetch failed' });
  }
}
