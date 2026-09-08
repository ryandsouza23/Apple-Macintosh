import type { FinderCanvas } from './finder';
import { SCREEN_W, SCREEN_H } from './finder';

// Power-on boot sequence. The Mac starts with a dark (off) tube; the first
// click on the screen powers it on: /hellomac.mp4 plays on the CRT, live-
// thresholded to the UI's 1-bit ink/paper palette, with a progress bar at the
// bottom. When it ends (or is clicked again to skip) the Finder takes over.

export type BootState = 'off' | 'booting' | 'done';
export type BootHandle = {
  state: () => BootState;
  powerOn: () => void;
  skip: () => void;
};

const INK: [number, number, number] = [10, 10, 10];
const PAPER: [number, number, number] = [238, 238, 236];
const VIDEO_AREA_H = 298; // logical px above the progress bar

export function setupBoot(finder: FinderCanvas, onDone: () => void): BootHandle {
  let state: BootState = 'off';
  let raf = 0;

  const ctx = finder.canvas.getContext('2d')!; // carries the 2x logical scale
  const work = document.createElement('canvas');
  work.width = SCREEN_W;
  work.height = VIDEO_AREA_H;
  const wctx = work.getContext('2d', { willReadFrequently: true })!;

  const video = document.createElement('video');
  video.src = '/hellomac.mp4';
  video.playsInline = true;
  video.preload = 'auto';

  finder.suspended = true;
  drawOffScreen();

  function drawOffScreen(): void {
    // powered-down tube: near-black glass with a faint center sheen
    const g = ctx.createRadialGradient(
      SCREEN_W / 2,
      SCREEN_H / 2,
      30,
      SCREEN_W / 2,
      SCREEN_H / 2,
      SCREEN_W * 0.7,
    );
    g.addColorStop(0, '#232322');
    g.addColorStop(1, '#151514');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    if (finder.onChange) finder.onChange();
  }

  function frame(): void {
    if (state !== 'booting') return;
    // 1-bit the video frame: contain-fit onto white, then threshold to ink/paper
    wctx.fillStyle = '#ffffff';
    wctx.fillRect(0, 0, SCREEN_W, VIDEO_AREA_H);
    const vw = video.videoWidth || SCREEN_W;
    const vh = video.videoHeight || VIDEO_AREA_H;
    const s = Math.min(SCREEN_W / vw, VIDEO_AREA_H / vh);
    const dw = vw * s;
    const dh = vh * s;
    wctx.drawImage(video, (SCREEN_W - dw) / 2, (VIDEO_AREA_H - dh) / 2, dw, dh);
    const img = wctx.getImageData(0, 0, SCREEN_W, VIDEO_AREA_H);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const c = lum < 150 ? INK : PAPER;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
    }
    wctx.putImageData(img, 0, 0);

    ctx.fillStyle = '#eeeeec';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.drawImage(work, 0, 0);
    // progress bar, bottom center
    const frac = video.duration > 0 ? Math.min(1, video.currentTime / video.duration) : 0;
    ctx.strokeStyle = '#0a0a0a';
    ctx.lineWidth = 1;
    ctx.strokeRect(106.5, 314.5, 300, 12);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(108, 316, 297 * frac, 9);
    if (finder.onChange) finder.onChange();
    raf = requestAnimationFrame(frame);
  }

  function finish(): void {
    if (state === 'done') return;
    state = 'done';
    cancelAnimationFrame(raf);
    video.pause();
    video.removeAttribute('src');
    video.load();
    finder.suspended = false;
    finder.draw();
    onDone();
  }

  function powerOn(): void {
    if (state !== 'off') return;
    state = 'booting';
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    // the click is a user gesture, so try with sound; fall back to muted
    video.muted = false;
    video
      .play()
      .then(() => frame())
      .catch(() => {
        video.muted = true;
        video
          .play()
          .then(() => frame())
          .catch(finish);
      });
    // never strand the visitor on a stalled boot
    window.setTimeout(() => {
      if (state === 'booting' && video.currentTime === 0) finish();
    }, 10000);
  }

  return {
    state: () => state,
    powerOn,
    skip: finish,
  };
}
