import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createMacintosh128KDesktopSetModel,
  createMacintosh128KDesktopSetLookDevLights,
  configureMacintosh128KDesktopSetRenderer,
} from './createObjectModel';
import { applyScreenCanvas, enhanceMacModel } from './enhance';
import { FinderCanvas } from './finder';
import { setupInteractions, FRONT_POS, FRONT_TARGET } from './interactions';
import { setupSpotify } from './spotify';
import { setupBoot, type BootHandle } from './boot';

const app = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
configureMacintosh128KDesktopSetRenderer(renderer);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f2ec);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.copy(FRONT_POS);

// the camera is fully scripted (front view <-> screen close-up); OrbitControls
// only carries the look-at target for the glide math
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.enablePan = false;
controls.enableDamping = false;
controls.target.copy(FRONT_TARGET);

const model = createMacintosh128KDesktopSetModel();
const { keys } = enhanceMacModel(model);
scene.add(model);

// live System 1.0 Finder on the CRT
const finder = new FinderCanvas();
const runtime = model.userData.sculptRuntime as { meshes: Record<string, THREE.Mesh> };
const screenMesh = runtime.meshes['screen-panel'];
let screenTexture: THREE.CanvasTexture | null = null;
let interactions: { update: () => void } | null = null;
let boot: BootHandle | null = null;
// subtle CRT glass: scanlines + corner vignette floating just above the tube
function makeCrtOverlay(target: THREE.Mesh): void {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 342;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 512, 342);
  g.fillStyle = 'rgba(0,0,0,0.055)';
  for (let y = 0; y < 342; y += 3) g.fillRect(0, y, 512, 1);
  const v = g.createRadialGradient(256, 171, 120, 256, 171, 330);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.20)');
  g.fillStyle = v;
  g.fillRect(0, 0, 512, 342);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  target.geometry.computeBoundingBox();
  const bb = target.geometry.boundingBox!;
  const overlay = new THREE.Mesh(
    new THREE.PlaneGeometry(bb.max.x - bb.min.x, bb.max.y - bb.min.y),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  overlay.position.set(0, 0, bb.max.z + 0.0015);
  overlay.renderOrder = 2;
  target.add(overlay);
}

if (screenMesh) {
  screenTexture = applyScreenCanvas(screenMesh, finder.canvas);
  makeCrtOverlay(screenMesh);
  finder.onChange = () => {
    if (screenTexture) screenTexture.needsUpdate = true;
  };
  finder.draw();
  // Music: 1-bit player window on the CRT, audio via the hidden Spotify embed
  setupSpotify(finder);

  // powered-off tube until the first click on the screen boots the machine
  boot = setupBoot(finder, () => undefined);

  controls.enableZoom = false; // wheel drives the camera tour instead
  interactions = setupInteractions({ renderer, camera, controls, model, finder, screenMesh, keys, boot });
  (window as unknown as { __mac: unknown }).__mac = { finder, keys, screenMesh, interactions, boot };
}

// lighting per spec.lightingFromPhoto: bright near-shadowless white studio.
// key upper-front-left (soft shadows fall slightly right), strong warm fill,
// high hemisphere ambient; subtle rim from rear.
const lights = createMacintosh128KDesktopSetLookDevLights();
lights.traverse((l) => {
  if ((l as THREE.Light).isLight) {
    const light = l as THREE.Light;
    if (light instanceof THREE.HemisphereLight) {
      light.intensity = 1.05;
      light.color.set(0xfffdf6);
      light.groundColor.set(0xb8b4aa);
    } else if (light instanceof THREE.DirectionalLight) {
      if (light.castShadow) {
        light.intensity = 1.6; // key
        light.color.set(0xfff8ee);
        light.shadow.radius = 8;
      } else if (light.position.x > 0) {
        light.intensity = 0.75; // fill — reference is near-shadowless
        light.color.set(0xf6f2ea);
      } else {
        light.intensity = 0.3; // rim
      }
    }
  }
});
scene.add(lights);

// ground for contact shadows
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(20, 20),
  new THREE.ShadowMaterial({ opacity: 0.22 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// review harness: allow deterministic camera placement via query params or console
type ReviewApi = {
  setView: (yawDeg: number, pitchDeg: number, dist?: number) => void;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  model: THREE.Group;
};
function setView(
  yawDeg: number,
  pitchDeg: number,
  dist = 4.0,
  target?: [number, number, number],
): void {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  if (target) controls.target.set(target[0], target[1], target[2]);
  const t = controls.target;
  camera.position.set(
    t.x + dist * Math.cos(pitch) * Math.sin(yaw),
    t.y + dist * Math.sin(pitch),
    t.z + dist * Math.cos(pitch) * Math.cos(yaw),
  );
  camera.lookAt(t);
  controls.update();
}
function capture(
  yawDeg: number,
  pitchDeg: number,
  dist = 4.0,
  size = 900,
  target?: [number, number, number],
  fov?: number,
): string {
  const prevW = renderer.domElement.width;
  const prevH = renderer.domElement.height;
  renderer.setSize(size, size, false);
  camera.aspect = 1;
  if (fov) camera.fov = fov;
  camera.updateProjectionMatrix();
  setView(yawDeg, pitchDeg, dist, target);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  renderer.setSize(prevW, prevH, false);
  camera.aspect = prevW / prevH;
  camera.updateProjectionMatrix();
  return url;
}
(window as unknown as { __review: ReviewApi & { capture: typeof capture } }).__review = {
  setView,
  scene,
  camera,
  model,
  capture,
};

const params = new URLSearchParams(location.search);
if (params.has('yaw')) {
  setView(
    Number(params.get('yaw') ?? 32),
    Number(params.get('pitch') ?? 18),
    Number(params.get('dist') ?? 4),
  );
}

const hints = document.getElementById('hints');
if (hints) {
  const fade = () => {
    hints.classList.add('faded');
    window.removeEventListener('pointerdown', fade);
    window.removeEventListener('wheel', fade);
  };
  window.setTimeout(() => {
    window.addEventListener('pointerdown', fade, { once: true });
    window.addEventListener('wheel', fade, { once: true });
  }, 4000);
}

let firstFrame = true;
renderer.setAnimationLoop(() => {
  if (interactions) interactions.update();
  controls.update();
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    // scene is on screen — let the intro overlay dissolve
    (window as unknown as { __introSceneReady?: () => void }).__introSceneReady?.();
  }
});
