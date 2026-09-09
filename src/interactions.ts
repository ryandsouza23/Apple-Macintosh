import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FinderCanvas } from './finder';
import type { BootHandle } from './boot';
import type { KeycapInfo } from './enhance';
import { SCREEN_W, SCREEN_H } from './finder';
import { keyClack, clickTick } from './audio';

// interaction-pass: two-state scripted camera (front full view <-> screen
// close-up) + interactive Finder screen + pressable keycaps and mouse button.
// Spec: interaction-pass componentRefs root/screen-panel/key-field/mouse-button/kb-cable.

// The whole computer, straight-on from the front. Scrolling or Esc always
// returns here; clicking the screen glides back in.
export const FRONT_TARGET = new THREE.Vector3(0.08, 0.52, 0.45);
export const FRONT_POS = (() => {
  const pitch = (13 * Math.PI) / 180;
  const dist = 6.2;
  return new THREE.Vector3(
    FRONT_TARGET.x,
    FRONT_TARGET.y + dist * Math.sin(pitch),
    FRONT_TARGET.z + dist * Math.cos(pitch),
  );
})();

class CameraGlide {
  private active = false;
  private t = 0;
  private duration = 1.1;
  private fromPos = new THREE.Vector3();
  private fromTgt = new THREE.Vector3();
  private toPos = new THREE.Vector3();
  private toTgt = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
  ) {}

  start(toTgt: THREE.Vector3, toPos: THREE.Vector3): void {
    this.fromPos.copy(this.camera.position);
    this.fromTgt.copy(this.controls.target);
    this.toPos.copy(toPos);
    this.toTgt.copy(toTgt);
    this.t = 0;
    this.active = true;
  }

  cancel(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    const e = this.t * this.t * (3 - 2 * this.t); // smoothstep ease
    this.controls.target.lerpVectors(this.fromTgt, this.toTgt, e);
    this.camera.position.lerpVectors(this.fromPos, this.toPos, e);
    this.camera.lookAt(this.controls.target);
    if (this.t >= 1) this.active = false;
  }
}

export function setupInteractions(opts: {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Group;
  finder: FinderCanvas;
  screenMesh: THREE.Mesh;
  keys: KeycapInfo[];
  boot?: BootHandle;
}): { update: () => void } {
  const { renderer, camera, controls, model, finder, screenMesh, keys, boot } = opts;
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const glide = new CameraGlide(camera, controls);
  const clock = new THREE.Clock();

  function screenCenterWorld(): THREE.Vector3 {
    const p = new THREE.Vector3();
    screenMesh.getWorldPosition(p);
    return p;
  }

  function zoomedIn(): boolean {
    return camera.position.distanceTo(screenCenterWorld()) < 2.3;
  }

  function zoomToScreen(): void {
    const c = screenCenterWorld();
    const tgt = new THREE.Vector3(c.x, c.y, c.z);
    const pos = new THREE.Vector3(c.x, c.y + 0.06, c.z + 1.55);
    glide.start(tgt, pos);
  }

  function zoomOut(): void {
    if (camera.position.distanceTo(FRONT_POS) > 0.05) {
      glide.start(FRONT_TARGET.clone(), FRONT_POS.clone());
    }
  }

  const runtime = model.userData.sculptRuntime as { meshes: Record<string, THREE.Mesh> };
  const mouseButton = runtime.meshes['mouse-button'];

  // margins must match applyScreenCanvas UV overscan
  const mx = 0.03 / 0.90;
  const my = 0.03 / 0.74;

  function screenPointAt(clientX: number, clientY: number): { x: number; y: number } | null {
    camera.updateMatrixWorld();
    const rect = dom.getBoundingClientRect();
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(screenMesh, false);
    for (const hit of hits) {
      if (!hit.uv) continue;
      const u = (hit.uv.x + mx) / (1 + 2 * mx);
      const v = (hit.uv.y + my) / (1 + 2 * my);
      if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) continue;
      return {
        x: THREE.MathUtils.clamp(u, 0, 1) * SCREEN_W,
        y: THREE.MathUtils.clamp(1 - v, 0, 1) * SCREEN_H,
      };
    }
    return null;
  }

  function keycapAt(clientX: number, clientY: number): KeycapInfo | null {
    camera.updateMatrixWorld();
    const rect = dom.getBoundingClientRect();
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const meshes = keys.map((k) => k.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    return keys.find((k) => k.mesh === hits[0].object) ?? null;
  }

  // Special → Shut Down: dark tube again, camera pulls back to the front view
  finder.onShutDown = () => {
    if (boot) boot.shutDown();
    zoomOut();
  };

  const pressed = new Map<THREE.Mesh, number>();
  function pressKey(k: KeycapInfo): void {
    if (pressed.has(k.mesh)) return;
    keyClack();
    k.mesh.position.y -= 0.014;
    pressed.set(k.mesh, window.setTimeout(() => {
      k.mesh.position.y += 0.014;
      pressed.delete(k.mesh);
    }, 130));
  }

  function pressMouseButton(): void {
    if (!mouseButton || pressed.has(mouseButton)) return;
    mouseButton.position.y -= 0.008;
    pressed.set(mouseButton, window.setTimeout(() => {
      mouseButton.position.y += 0.008;
      pressed.delete(mouseButton);
    }, 140));
  }

  let screenDrag = false;

  dom.addEventListener('pointermove', (e) => {
    const pt = screenPointAt(e.clientX, e.clientY);
    if ((window as unknown as { __macDebug?: boolean }).__macDebug) {
      console.log('[mac] pointermove', e.clientX, e.clientY, 'hit:', pt);
    }
    if (pt) {
      if (boot && boot.state() !== 'done') {
        dom.style.cursor = 'pointer';
      } else {
        if (screenDrag) finder.pointerDrag(pt.x, pt.y);
        else finder.moveCursor(pt.x, pt.y);
        dom.style.cursor = zoomedIn() ? 'none' : 'zoom-in';
      }
    } else {
      dom.style.cursor = '';
    }
  });

  dom.addEventListener('pointerdown', (e) => {
    const pt = screenPointAt(e.clientX, e.clientY);
    if (pt) {
      if (boot && boot.state() === 'off') {
        boot.powerOn();
        if (!zoomedIn()) zoomToScreen();
        return;
      }
      if (boot && boot.state() === 'booting') {
        // zoomed out: come back to watch; already close: skip ahead
        if (!zoomedIn()) zoomToScreen();
        else boot.skip();
        return;
      }
      if (!zoomedIn()) {
        zoomToScreen();
        return;
      }
      screenDrag = true;
      controls.enabled = false;
      clickTick();
      finder.pointerDown(pt.x, pt.y);
      return;
    }
    const cap = keycapAt(e.clientX, e.clientY);
    if (cap) pressKey(cap);
    // clicking the physical mouse button clicks the Finder at its cursor
    const rect = dom.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    if (mouseButton && raycaster.intersectObject(mouseButton, false).length) {
      pressMouseButton();
      clickTick();
      finder.pointerDown(finder.state.cursor.x, finder.state.cursor.y);
      window.setTimeout(() => finder.pointerUp(), 120);
    }
  });

  dom.addEventListener('pointerup', () => {
    if (screenDrag) {
      screenDrag = false;
      finder.pointerUp();
      controls.enabled = true;
    }
  });

  dom.addEventListener('dblclick', (e) => {
    const pt = screenPointAt(e.clientX, e.clientY);
    if (pt) finder.doubleClick(pt.x, pt.y);
  });

  // scrolling pulls back to the full front view — unless the pointer is over
  // an open MacWeb page, which scrolls like a real browser
  dom.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const pt = screenPointAt(e.clientX, e.clientY);
      if (pt && zoomedIn() && (!boot || boot.state() === 'done') && finder.webWheel(pt.x, pt.y, e.deltaY)) return;
      zoomOut();
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !finder.consumeEscape()) zoomOut();
  });

  // physical typing presses the matching cap (and feeds the Guestbook when open)
  window.addEventListener('keydown', (e) => {
    if (finder.handleKey(e.key) && e.key.length === 1) e.preventDefault();
    const label = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const alias: Record<string, string> = {
      ' ': '',
      Backspace: 'Backspace',
      Tab: 'Tab',
      Enter: 'Enter',
      Shift: 'Shift',
      Control: 'Ctrl',
      Alt: 'Alt',
      CapsLock: 'Caps Lock',
    };
    const target = alias[e.key] ?? label;
    const cap = keys.find((k) => k.legend === target);
    if (cap) pressKey(cap);
  });

  return {
    update: () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      glide.update(dt);
    },
  };
}
