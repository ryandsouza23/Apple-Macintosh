import { guestbookAvailable, guestbookList, guestbookAdd } from './_core.mjs';

export default async function handler(req, res) {
  if (!guestbookAvailable()) {
    res.status(503).json({ ok: false, error: 'no-store' });
    return;
  }
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
      const notes = await guestbookAdd(body.note || '');
      res.status(200).json({ ok: true, notes });
      return;
    }
    const notes = await guestbookList();
    res.status(200).json({ ok: true, notes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'kv failed' });
  }
}
