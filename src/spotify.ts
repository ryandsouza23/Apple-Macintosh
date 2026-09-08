import type { FinderCanvas, MusicCommand } from './finder';

// Invisible Spotify engine behind the 1-bit Music player: the official iFrame
// API controls a hidden embed (play/pause/seek/loadUri), while all visible UI
// lives on the CRT canvas. Without a logged-in Spotify session the embed plays
// 30-second previews — same limitation as the visible widget.

type EmbedController = {
  loadUri: (uri: string) => void;
  play: () => void;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  addListener: (event: string, cb: (e: { data: PlaybackData }) => void) => void;
};

type PlaybackData = {
  isPaused: boolean;
  isBuffering: boolean;
  position: number; // ms
  duration: number; // ms
};

type IframeApi = {
  createController: (
    el: HTMLElement,
    options: { uri: string; width: number; height: number },
    cb: (controller: EmbedController) => void,
  ) => void;
};

declare global {
  interface Window {
    onSpotifyIframeApiReady?: (api: IframeApi) => void;
  }
}

/** Load a cover image (CORS-clean) and Atkinson-dither it to 1-bit at 48x48,
 *  matching classic Mac graphics. Resolves null on any failure — a tainted
 *  image must never touch the Finder canvas or the WebGL texture dies. */
function ditherArt(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 48;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0, size, size);
        const data = g.getImageData(0, 0, size, size);
        const px = data.data;
        const lum = new Float32Array(size * size);
        for (let i = 0; i < size * size; i += 1) {
          lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        }
        // Atkinson dithering: 1/8 of the error to six neighbours
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const i = y * size + x;
            const old = lum[i];
            const val = old < 128 ? 0 : 255;
            const err = (old - val) / 8;
            lum[i] = val;
            if (x + 1 < size) lum[i + 1] += err;
            if (x + 2 < size) lum[i + 2] += err;
            if (y + 1 < size) {
              if (x > 0) lum[i + size - 1] += err;
              lum[i + size] += err;
              if (x + 1 < size) lum[i + size + 1] += err;
            }
            if (y + 2 < size) lum[i + 2 * size] += err;
          }
        }
        // ink + paper of the 1-bit UI
        for (let i = 0; i < size * size; i += 1) {
          const on = lum[i] < 128;
          px[i * 4] = on ? 10 : 238;
          px[i * 4 + 1] = on ? 10 : 238;
          px[i * 4 + 2] = on ? 10 : 236;
          px[i * 4 + 3] = 255;
        }
        g.putImageData(data, 0, 0);
        // prove the canvas is untainted before letting it near the screen texture
        c.toDataURL();
        resolve(c);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function setupSpotify(finder: FinderCanvas): void {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;';
  const mount = document.createElement('div');
  host.appendChild(mount);
  document.body.appendChild(host);

  let controller: EmbedController | null = null;
  let pendingIndex: number | null = null;
  let loadedIndex = -1;
  let advancing = false;

  const uris = finder.music.tracks.map((t) => t.uri);

  function playIndex(i: number): void {
    const idx = ((i % uris.length) + uris.length) % uris.length;
    finder.music.current = idx;
    finder.music.position = 0;
    finder.music.isPaused = false;
    finder.draw();
    if (!controller) {
      pendingIndex = idx;
      return;
    }
    if (loadedIndex !== idx) {
      loadedIndex = idx;
      controller.loadUri(uris[idx]);
    }
    controller.play();
  }

  finder.onMusicCommand = (cmd: MusicCommand) => {
    switch (cmd.type) {
      case 'play-track':
        playIndex(cmd.index);
        break;
      case 'toggle':
        if (finder.music.current < 0) playIndex(0);
        else if (controller) {
          controller.togglePlay();
          finder.music.isPaused = !finder.music.isPaused; // optimistic; corrected by playback_update
          finder.draw();
        }
        break;
      case 'prev':
        playIndex((finder.music.current < 0 ? 0 : finder.music.current) - 1);
        break;
      case 'next':
        playIndex((finder.music.current < 0 ? -1 : finder.music.current) + 1);
        break;
      case 'seek':
        controller?.seek(cmd.seconds);
        break;
    }
  };

  window.onSpotifyIframeApiReady = (api: IframeApi) => {
    api.createController(mount, { uri: uris[0], width: 280, height: 80 }, (c) => {
      controller = c;
      c.addListener('playback_update', (e) => {
        const d = e.data;
        finder.updateMusicPlayback(d.position / 1000, d.duration / 1000, d.isPaused);
        if (d.duration > 0 && d.position >= d.duration - 700 && !advancing) {
          advancing = true;
          window.setTimeout(() => {
            advancing = false;
            playIndex(finder.music.current + 1);
          }, 900);
        }
      });
      if (pendingIndex !== null) {
        const i = pendingIndex;
        pendingIndex = null;
        playIndex(i);
      }
    });
  };

  const script = document.createElement('script');
  script.src = 'https://open.spotify.com/embed/iframe-api/v1';
  script.async = true;
  document.body.appendChild(script);

  // exact titles/artists via Spotify's public oEmbed (no auth); fallbacks stay if it fails
  finder.music.tracks.forEach(async (track) => {
    try {
      const id = track.uri.split(':').pop();
      const res = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${id}`);
      const json = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      if (json.title) track.title = json.title;
      if (json.author_name) track.artist = json.author_name;
      finder.draw();
      if (json.thumbnail_url) {
        track.art = await ditherArt(json.thumbnail_url);
        finder.draw();
      }
    } catch {
      /* keep fallback labels */
    }
  });
}
