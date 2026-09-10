import * as THREE from 'three';
import type { FinderCanvas } from './finder';

// Projects a real YouTube embed onto the CRT: the video area of the MacWeb
// window (Finder coordinates) is mapped through the screen panel's world
// transform and the camera projection to client space, and a CSS matrix3d
// homography pins the iframe to those four corners every frame. Result: the
// actual video plays "on the glass", greyscaled with scanlines to match.

// Finder coords map linearly onto the panel face: the UV overscan written by
// applyScreenCanvas and the inverse in the raycast mapping cancel exactly, so
// canvas x/512 IS the spatial fraction across the panel. No overscan here.
const SCREEN_W = 512;
const SCREEN_H = 342;

/** Homography mapping (0,0)-(w,0)-(w,h)-(0,h) to 4 client-space points. */
function matrix3dFor(w: number, h: number, p: { x: number; y: number }[]): string {
  // solve the 8-dof projective transform with gaussian elimination
  const src = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const a: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const [sx, sy] = src[i];
    const { x: dx, y: dy } = p[i];
    a.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx, dx]);
    a.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy, dy]);
  }
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 8; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-9) return '';
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 8; r += 1) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let c = col; c < 9; c += 1) a[r][c] -= f * a[col][c];
    }
  }
  const v = a.map((row, i) => row[8] / row[i]);
  const [h11, h12, h13, h21, h22, h23, h31, h32] = v;
  return `matrix3d(${h11},${h21},0,${h31}, ${h12},${h22},0,${h32}, 0,0,1,0, ${h13},${h23},0,1)`;
}

export function setupTube(opts: {
  finder: FinderCanvas;
  camera: THREE.PerspectiveCamera;
  screenMesh: THREE.Mesh;
  renderer: THREE.WebGLRenderer;
}): void {
  const { finder, camera, screenMesh, renderer } = opts;
  screenMesh.geometry.computeBoundingBox();
  const bb = screenMesh.geometry.boundingBox!;
  const panelW = bb.max.x - bb.min.x;
  const panelH = bb.max.y - bb.min.y;
  const panelZ = bb.max.z + 0.002;

  // wrap = the window's content area (clips the video like the canvas clip
  // does); box = the video itself, positioned in page flow inside it;
  // fx = filter layer (grayscale, or threshold+dither for the 1-bit look)
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;left:0;top:0;transform-origin:0 0;overflow:hidden;display:none;z-index:1;' +
    'background:transparent;pointer-events:none;';
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:0;top:0;background:#000;pointer-events:auto;';
  const fx = document.createElement('div');
  fx.style.cssText = 'position:absolute;inset:0;';
  const shade = document.createElement('div');
  shade.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:2;' +
    'background:repeating-linear-gradient(rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.14) 2px 3px);';
  box.appendChild(fx);
  wrap.appendChild(box);
  document.body.appendChild(wrap);

  // hard-threshold SVG filter: every pixel snaps to ink or paper
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  const filter = document.createElementNS(svgNS, 'filter');
  filter.setAttribute('id', 'macweb1bit');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const desat = document.createElementNS(svgNS, 'feColorMatrix');
  desat.setAttribute('type', 'saturate');
  desat.setAttribute('values', '0');
  filter.appendChild(desat);
  const transfer = document.createElementNS(svgNS, 'feComponentTransfer');
  for (const ch of ['R', 'G', 'B']) {
    const fn = document.createElementNS(svgNS, `feFunc${ch}`);
    fn.setAttribute('type', 'discrete');
    fn.setAttribute('tableValues', '0 1');
    transfer.appendChild(fn);
  }
  filter.appendChild(transfer);
  svg.appendChild(filter);
  document.body.appendChild(svg);

  // 4x4 Bayer tile blended over the video before the threshold = ordered dither
  const bayer = document.createElement('canvas');
  bayer.width = 4;
  bayer.height = 4;
  {
    const g = bayer.getContext('2d')!;
    const M = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const v = Math.round(255 * (0.5 + ((M[y][x] + 0.5) / 16 - 0.5) * 0.9));
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(x, y, 1, 1);
      }
    }
  }
  const dither = document.createElement('div');
  dither.style.cssText =
    'position:absolute;inset:0;pointer-events:none;mix-blend-mode:overlay;' +
    `background-image:url(${bayer.toDataURL()});background-size:4px 4px;image-rendering:pixelated;`;

  let iframe: HTMLIFrameElement | null = null;
  let currentId: string | null = null;
  let shownLast = false;

  function sendCmd(func: string): void {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
  }

  function ensureIframe(id: string): void {
    if (iframe && currentId === id) return;
    if (iframe) iframe.remove();
    currentId = id;
    iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1&playsinline=1`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;';
    fx.appendChild(iframe);
    fx.appendChild(dither);
    box.appendChild(shade);
  }

  let oneBitLast: boolean | null = null;
  function applyLook(oneBit: boolean): void {
    if (oneBit === oneBitLast) return;
    oneBitLast = oneBit;
    if (oneBit) {
      fx.style.filter = "url('#macweb1bit')";
      dither.style.display = 'block';
    } else {
      fx.style.filter = 'grayscale(1) contrast(1.3) brightness(1.05)';
      dither.style.display = 'none';
    }
  }

  function teardown(): void {
    if (iframe) iframe.remove();
    iframe = null;
    currentId = null;
    wrap.style.display = 'none';
  }

  const local = new THREE.Vector3();
  function clientPoint(fx: number, fy: number, rect: DOMRect): { x: number; y: number } {
    const u = fx / SCREEN_W;
    const v = 1 - fy / SCREEN_H;
    local.set(bb.min.x + u * panelW, bb.min.y + v * panelH, panelZ);
    const world = screenMesh.localToWorld(local.clone());
    const ndc = world.project(camera);
    return { x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width, y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height };
  }

  function frame(): void {
    requestAnimationFrame(frame);
    const video = finder.web.video;
    const win = finder.state.windows.find((w) => w.id === 'win-web');
    const front = finder.frontWindow();
    const show = Boolean(video && win && front === win && !finder.suspended);
    if (!show) {
      if (shownLast) {
        wrap.style.display = 'none';
        sendCmd('pauseVideo');
        shownLast = false;
      }
      if (!video || !win) teardown();
      return;
    }
    ensureIframe(video!.id);
    applyLook(finder.web.oneBit);
    const cr = finder.webContentRect(win!);
    const vr = finder.webVideoRect(win!);
    const rect = renderer.domElement.getBoundingClientRect();
    camera.updateMatrixWorld();
    screenMesh.updateWorldMatrix(true, false);
    const corners = [
      clientPoint(cr.x, cr.y, rect),
      clientPoint(cr.x + cr.w, cr.y, rect),
      clientPoint(cr.x + cr.w, cr.y + cr.h, rect),
      clientPoint(cr.x, cr.y + cr.h, rect),
    ];
    const m = matrix3dFor(cr.w, cr.h, corners);
    if (!m) return;
    wrap.style.width = `${cr.w}px`;
    wrap.style.height = `${cr.h}px`;
    wrap.style.transform = m;
    // the video sits in the page flow: window-relative, scrolled with content
    box.style.left = `${vr.x - cr.x}px`;
    box.style.top = `${vr.y - cr.y - finder.web.scroll}px`;
    box.style.width = `${vr.w}px`;
    box.style.height = `${vr.h}px`;
    wrap.style.display = 'block';
    shownLast = true;
  }
  requestAnimationFrame(frame);
}
