import * as THREE from 'three';
import type { FinderCanvas } from './finder';

// Projects a real YouTube embed onto the CRT: the video area of the MacWeb
// window (Finder coordinates) is mapped through the screen panel's world
// transform and the camera projection to client space, and a CSS matrix3d
// homography pins the iframe to those four corners every frame. Result: the
// actual video plays "on the glass", greyscaled with scanlines to match.

// must match the UV overscan in applyScreenCanvas / interactions
const MX = 0.03 / 0.9;
const MY = 0.03 / 0.74;
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

  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;left:0;top:0;transform-origin:0 0;overflow:hidden;display:none;z-index:1;background:#000;';
  const shade = document.createElement('div');
  shade.style.cssText =
    'position:absolute;inset:0;pointer-events:none;z-index:2;' +
    'background:repeating-linear-gradient(rgba(0,0,0,0) 0 2px, rgba(0,0,0,0.14) 2px 3px);';
  document.body.appendChild(wrap);

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
    iframe.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;' +
      'filter:grayscale(1) contrast(1.3) brightness(1.05);';
    wrap.appendChild(iframe);
    wrap.appendChild(shade);
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
    const uvx = u * (1 + 2 * MX) - MX;
    const uvy = v * (1 + 2 * MY) - MY;
    local.set(bb.min.x + uvx * panelW, bb.min.y + uvy * panelH, panelZ);
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
    const r = finder.webVideoRect(win!);
    const rect = renderer.domElement.getBoundingClientRect();
    camera.updateMatrixWorld();
    screenMesh.updateWorldMatrix(true, false);
    const corners = [
      clientPoint(r.x, r.y, rect),
      clientPoint(r.x + r.w, r.y, rect),
      clientPoint(r.x + r.w, r.y + r.h, rect),
      clientPoint(r.x, r.y + r.h, rect),
    ];
    const baseW = Math.max(1, r.w);
    const baseH = Math.max(1, r.h);
    const m = matrix3dFor(baseW, baseH, corners);
    if (!m) return;
    wrap.style.width = `${baseW}px`;
    wrap.style.height = `${baseH}px`;
    wrap.style.transform = m;
    wrap.style.display = 'block';
    shownLast = true;
  }
  requestAnimationFrame(frame);
}
