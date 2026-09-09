import { defineConfig, type Plugin } from 'vite';

// Dev-only stand-ins for the Vercel functions in /api, sharing the same core
// logic so localhost behaves like production. The guestbook falls back to an
// in-memory list when no KV env vars are present locally.
function devApi(): Plugin {
  const devNotes: string[] = [];
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const send = (status: number, body: unknown): void => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          if (url.pathname === '/api/fetch') {
            const core = await import('./api/_core.mjs');
            const target = url.searchParams.get('url');
            if (!target) return send(400, { ok: false, error: 'missing url' });
            try {
              send(200, await core.proxyFetch(target));
            } catch (e) {
              send(200, { ok: false, error: e instanceof Error ? e.message : 'fetch failed' });
            }
            return;
          }
          if (url.pathname === '/api/guestbook') {
            const core = await import('./api/_core.mjs');
            if (core.guestbookAvailable()) {
              if (req.method === 'POST') {
                let raw = '';
                for await (const chunk of req) raw += chunk;
                send(200, { ok: true, notes: await core.guestbookAdd(JSON.parse(raw || '{}').note || '') });
              } else {
                send(200, { ok: true, notes: await core.guestbookList() });
              }
              return;
            }
            // in-memory dev fallback
            if (req.method === 'POST') {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              const note = String(JSON.parse(raw || '{}').note || '').trim().slice(0, 60);
              if (note) devNotes.unshift(note);
              devNotes.splice(50);
            }
            send(200, { ok: true, notes: [...devNotes] });
            return;
          }
        } catch (e) {
          send(500, { ok: false, error: e instanceof Error ? e.message : 'dev api failed' });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  server: {
    port: 5231,
    strictPort: true,
  },
});
