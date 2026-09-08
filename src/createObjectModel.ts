import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Macintosh 128K Desktop Set
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createMacintosh128KDesktopSetModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Macintosh 128K Desktop Set";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 35.0, "aspect": 1.0, "orientation": {"yaw": 32.0, "pitch": -18.0, "roll": 0.0}, "positionHint": [2.1, 1.6, 3.2], "note": "Approximate 3/4 front-right view matching ref-setup-34.jpg; verified by overlay at blockout review. Projection not used (solid-color surfaces + live canvas UI)."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["cream-plastic"] = createSculptMaterial(
    "cream-plastic",
    {"id": "cream-plastic", "name": "Cream ABS (fascia, keyboard tray, mouse body)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#E9E4D5", "color": "#E9E4D5", "albedo": {"dominant": "#E9E4D5", "secondary": ["#DED8C6", "#F2EEE1"], "samplingNotes": "Flat solid-color plastic in a flat-lit stylized render; solid albedo per 'solid albedo for flat paint' rule."}, "colorVariation": {"palette": ["#E9E4D5", "#DED8C6", "#F2EEE1"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.55, "variation": 0.04, "localResponse": "slightly rougher in recesses; scalar only, no maps"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "notes": "screen-space/lighting AO only; no baked map"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "recessAO", "target": "cavities", "effect": "roughness +0.1, value -6%", "mask": "cavity"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "finishClass": "plastic", "texturePalette": ["#E9E4D5"], "proceduralTexture": "none", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.3, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 0.7, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "textureless": {"declared": true, "evidence": ["reference renders are flat-lit low-poly with uniform color fields (all five views)", "extract_pbr_evidence on flat crop returned near-zero valueRange; identity is silhouette + flat color boundaries (matte cream ABS)", "PBR evidence maps retained on disk at .img2threejs/material-evidence/ as measurement record"]}},
    options
  );
  materialMap["grey-shell"] = createSculptMaterial(
    "grey-shell",
    {"id": "grey-shell", "name": "Warm grey ABS (shell bucket)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8D897E", "color": "#8D897E", "albedo": {"dominant": "#8D897E", "secondary": ["#847F74", "#96928A"], "samplingNotes": "Flat solid-color plastic in a flat-lit stylized render; solid albedo per 'solid albedo for flat paint' rule."}, "colorVariation": {"palette": ["#8D897E", "#847F74", "#96928A"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.6, "variation": 0.04, "localResponse": "slightly rougher in recesses; scalar only, no maps"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "notes": "screen-space/lighting AO only; no baked map"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "finishClass": "plastic", "texturePalette": ["#8D897E"], "proceduralTexture": "none", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.0, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 1.0, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "textureless": {"declared": true, "evidence": ["reference renders are flat-lit low-poly with uniform color fields (all five views)", "extract_pbr_evidence on flat crop returned near-zero valueRange; identity is silhouette + flat color boundaries (matte warm grey ABS)", "PBR evidence maps retained on disk at .img2threejs/material-evidence/ as measurement record"]}},
    options
  );
  materialMap["pedestal-grey"] = createSculptMaterial(
    "pedestal-grey",
    {"id": "pedestal-grey", "name": "Pedestal grey", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7F7B71", "color": "#7F7B71", "albedo": {"dominant": "#7F7B71", "secondary": ["#6E6A61"], "samplingNotes": "Flat solid-color plastic in a flat-lit stylized render; solid albedo per 'solid albedo for flat paint' rule."}, "colorVariation": {"palette": ["#7F7B71", "#6E6A61"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.62, "variation": 0.04, "localResponse": "slightly rougher in recesses; scalar only, no maps"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "notes": "screen-space/lighting AO only; no baked map"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "ventDark", "target": "rearVents interior", "effect": "albedo #2A2A28", "mask": "slot-interior"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "finishClass": "plastic", "texturePalette": ["#7F7B71"], "proceduralTexture": "none", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.0, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 0.5, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "textureless": {"declared": true, "evidence": ["reference renders are flat-lit low-poly with uniform color fields (all five views)", "extract_pbr_evidence on flat crop returned near-zero valueRange; identity is silhouette + flat color boundaries (matte darker grey ABS)", "PBR evidence maps retained on disk at .img2threejs/material-evidence/ as measurement record"]}},
    options
  );
  materialMap["keycap-grey"] = createSculptMaterial(
    "keycap-grey",
    {"id": "keycap-grey", "name": "Keycap grey ABS", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8A8578", "color": "#8A8578", "albedo": {"dominant": "#8A8578", "secondary": ["#7E7A6E", "#B0ACA0"], "samplingNotes": "Flat solid-color plastic in a flat-lit stylized render; solid albedo per 'solid albedo for flat paint' rule."}, "colorVariation": {"palette": ["#8A8578", "#7E7A6E", "#B0ACA0"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.04, "localResponse": "slightly rougher in recesses; scalar only, no maps"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "notes": "screen-space/lighting AO only; no baked map"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "legendInk", "target": "cap top legends", "effect": "albedo #C9C5B9", "mask": "legend-canvas"}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "finishClass": "plastic", "texturePalette": ["#8A8578"], "proceduralTexture": "none", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.0, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 0.5, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "textureless": {"declared": true, "evidence": ["reference renders are flat-lit low-poly with uniform color fields (all five views)", "extract_pbr_evidence on flat crop returned near-zero valueRange; identity is silhouette + flat color boundaries (matte keycap ABS, two-tone by facing)", "PBR evidence maps retained on disk at .img2threejs/material-evidence/ as measurement record"]}},
    options
  );
  materialMap["screen-1bit"] = createSculptMaterial(
    "screen-1bit",
    {"id": "screen-1bit", "name": "Screen panel (live Finder canvas)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#D6D6D2", "color": "#D6D6D2", "albedo": {"dominant": "#F6F5F2", "secondary": ["#B5B4B2", "#D4D3D0", "#72706E"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_albedo.png", "url": "screen-1bit_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F6F5F2", "#B5B4B2", "#D4D3D0", "#72706E", "#FCFBF9"], "pattern": "reference-derived pixel palette", "amplitude": 0.137, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.394, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.35, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.694, "variation": 0.124, "map": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_roughness.png", "url": "screen-1bit_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.265, "map": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_normal.png", "url": "screen-1bit_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_height.png", "url": "screen-1bit_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.042, "map": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_height.png", "url": "screen-1bit_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_ao.png", "url": "screen-1bit_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "emissive": "#D8D8D4", "finishClass": "brushed-steel", "texturePalette": ["#E3E2DF", "#E4E3E0", "#EAE9E6", "#ECEBE8", "#C9C8C6"], "proceduralTexture": "brushed", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.0, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 1.0, "anisotropy": {"base": 1.0}, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "referencePbr": {"version": "1.0", "sourceImage": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/matcrops/screen-1bit.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.756, "estimatedFidelity": 0.756, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_albedo.png", "url": "screen-1bit_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_roughness.png", "url": "screen-1bit_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_height.png", "url": "screen-1bit_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_normal.png", "url": "screen-1bit_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/Users/ryandsouza/Desktop/mac128k/.img2threejs/material-evidence/screen-1bit_ao.png", "url": "screen-1bit_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 336, "sourceHeight": 216, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 336, "height": 216}, "mask": {"backgroundColor": "#B9B8B5", "backgroundNoise": 105.655, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.3266, "heightP90Gradient": 0.0928, "roughnessBase": 0.694, "roughnessVariation": 0.124, "normalStrength": 0.265, "blurRadius": 21}, "palette": ["#F6F5F2", "#B5B4B2", "#D4D3D0", "#72706E", "#FCFBF9"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}, "emissiveIntensity": {"base": 0.9}},
    options
  );
  materialMap["cable-dark"] = createSculptMaterial(
    "cable-dark",
    {"id": "cable-dark", "name": "Cable rubber", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#1C1C1C", "color": "#1C1C1C", "albedo": {"dominant": "#1C1C1C", "secondary": ["#262626"], "samplingNotes": "Flat solid-color plastic in a flat-lit stylized render; solid albedo per 'solid albedo for flat paint' rule."}, "colorVariation": {"palette": ["#1C1C1C", "#262626"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.4, "variation": 0.04, "localResponse": "slightly rougher in recesses; scalar only, no maps"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "notes": "screen-space/lighting AO only; no baked map"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "finishClass": "plastic", "texturePalette": ["#1C1C1C"], "proceduralTexture": "none", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.0, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 1.0, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "textureless": {"declared": true, "evidence": ["reference renders are flat-lit low-poly with uniform color fields (all five views)", "extract_pbr_evidence on flat crop returned near-zero valueRange; identity is silhouette + flat color boundaries (near-black cable rubber)", "PBR evidence maps retained on disk at .img2threejs/material-evidence/ as measurement record"]}},
    options
  );
  materialMap["dark-accent"] = createSculptMaterial(
    "dark-accent",
    {"id": "dark-accent", "name": "Dark accents (slit interior, knob, sockets)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#3A3A38", "color": "#3A3A38", "albedo": {"dominant": "#3A3A38", "secondary": ["#6E6B64"], "samplingNotes": "Flat solid-color plastic in a flat-lit stylized render; solid albedo per 'solid albedo for flat paint' rule."}, "colorVariation": {"palette": ["#3A3A38", "#6E6B64"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.55, "variation": 0.04, "localResponse": "slightly rougher in recesses; scalar only, no maps"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.35, "notes": "screen-space/lighting AO only; no baked map"}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "finishClass": "plastic", "texturePalette": ["#3A3A38"], "proceduralTexture": "none", "clearcoat": {"base": 0.0, "variation": 0.0}, "clearcoatRoughness": {"base": 0.0, "variation": 0.0}, "transmission": {"base": 0.0, "variation": 0.0}, "ior": {"base": 1.5, "value": 1.5}, "envMapIntensity": 0.5, "finishCorrection": "analyze_texture heuristic suggested metallic finish for flat-lit grey; overridden to dielectric per visual evidence (matte ABS/rubber, no env reflections in reference)", "textureless": {"declared": true, "evidence": ["reference renders are flat-lit low-poly with uniform color fields (all five views)", "extract_pbr_evidence on flat crop returned near-zero valueRange; identity is silhouette + flat color boundaries (dark recess/knob plastic)", "PBR evidence maps retained on disk at .img2threejs/material-evidence/ as measurement record"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Chassis shell bucket (assembly root)__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.625, -0.495);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Chassis shell bucket (assembly root)", "level": "macro", "role": "housing", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid five-sided bucket (sides/top/back) with hard countable faces; box with top-rear chamfer cut. Doubles as assembly root: generator emits one mesh per component, so unit pivots coincide with unit housing meshes.", "geometryDescriptor": {"topologyIntent": "five-sided bucket with large top-rear chamfer; fascia closes the front", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.98, "height": 1.13, "depth": 0.88, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.625, -0.495], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grey-shell", "materialLayers": ["grey-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "topChamfer", "kind": "bevel", "description": "large chamfer/step across top-rear edge (carry recess), width ~0.22W — realized at blockout as shell-rear-step (height drop 0.11 over rear 0.17 depth)", "affects": "silhouette"}, {"id": "badgeStripes", "kind": "surface-relief", "description": "3 short horizontal debossed stripes lower-left rear quarter", "affects": "secondary"}, {"id": "sideVentLines", "kind": "surface-relief", "description": "faint horizontal vent lines lower side faces", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Three debossed badge stripes lower-left rear quarter as thin dark plates (geometry; matches ref-side-left)."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 137, 126, 1.0)", "secondaryAlbedo": "rgba(132, 127, 116, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "side-left"}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(0.98, 1.13, 0.88);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["grey-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Chassis shell bucket (assembly root)";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Chassis shell bucket (assembly root)", "level": "macro", "role": "housing", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rigid five-sided bucket (sides/top/back) with hard countable faces; box with top-rear chamfer cut. Doubles as assembly root: generator emits one mesh per component, so unit pivots coincide with unit housing meshes.", "geometryDescriptor": {"topologyIntent": "five-sided bucket with large top-rear chamfer; fascia closes the front", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.98, "height": 1.13, "depth": 0.88, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.625, -0.495], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grey-shell", "materialLayers": ["grey-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "topChamfer", "kind": "bevel", "description": "large chamfer/step across top-rear edge (carry recess), width ~0.22W — realized at blockout as shell-rear-step (height drop 0.11 over rear 0.17 depth)", "affects": "silhouette"}, {"id": "badgeStripes", "kind": "surface-relief", "description": "3 short horizontal debossed stripes lower-left rear quarter", "affects": "secondary"}, {"id": "sideVentLines", "kind": "surface-relief", "description": "faint horizontal vent lines lower side faces", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Three debossed badge stripes lower-left rear quarter as thin dark plates (geometry; matches ref-side-left)."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 137, 126, 1.0)", "secondaryAlbedo": "rgba(132, 127, 116, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "side-left"}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_shell_rear_step_1 = makeAttachmentEndpoint(null);
  const node_shell_rear_step_1 = new THREE.Group();
  node_shell_rear_step_1.name = "Shell rear step mass__pivot";
  node_shell_rear_step_1.scale.set(1, 1, 1);
  if (endpoint_shell_rear_step_1) {
    node_shell_rear_step_1.position.copy(endpoint_shell_rear_step_1.start);
    node_shell_rear_step_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_shell_rear_step_1.position.set(0.0, -0.055, -0.525);
    node_shell_rear_step_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_shell_rear_step_1.userData.sculptComponent = {"id": "shell-rear-step", "name": "Shell rear step mass", "level": "meso", "role": "housing", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rear segment of the bucket, lower than the main mass: the top-rear height drop reads as the carry-handle step in silhouette. Convex mass by design (a step, not a cavity).", "geometryDescriptor": {"topologyIntent": "Recessed plinth under shell; rigid box, darker grey; front jack recess + rear vents.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.98, "height": 1.02, "depth": 0.17, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, -0.055, -0.525], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grey-shell", "materialLayers": ["grey-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "grey-shell", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 137, 126, 1.0)", "secondaryAlbedo": "rgba(132, 127, 116, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "side-left"}};
  node_shell_rear_step_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_shell_rear_step_1);
  nodes["shell-rear-step"] = node_shell_rear_step_1;
  const mesh_shell_rear_step_1Geometry = endpoint_shell_rear_step_1
    ? new THREE.CylinderGeometry(endpoint_shell_rear_step_1.endRadius, endpoint_shell_rear_step_1.baseRadius, endpoint_shell_rear_step_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_shell_rear_step_1) {
    mesh_shell_rear_step_1Geometry.scale(0.98, 1.02, 0.17);
  }
  const mesh_shell_rear_step_1 = new THREE.Mesh(
    mesh_shell_rear_step_1Geometry,
    materialMap["grey-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_shell_rear_step_1.name = "Shell rear step mass";
  if (endpoint_shell_rear_step_1) {
    mesh_shell_rear_step_1.position.copy(endpoint_shell_rear_step_1.midpoint);
    mesh_shell_rear_step_1.quaternion.copy(endpoint_shell_rear_step_1.quaternion);
  }
  mesh_shell_rear_step_1.castShadow = options.castShadow ?? true;
  mesh_shell_rear_step_1.receiveShadow = options.receiveShadow ?? true;
  mesh_shell_rear_step_1.userData.sculptComponent = {"id": "shell-rear-step", "name": "Shell rear step mass", "level": "meso", "role": "housing", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rear segment of the bucket, lower than the main mass: the top-rear height drop reads as the carry-handle step in silhouette. Convex mass by design (a step, not a cavity).", "geometryDescriptor": {"topologyIntent": "Recessed plinth under shell; rigid box, darker grey; front jack recess + rear vents.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.98, "height": 1.02, "depth": 0.17, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, -0.055, -0.525], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "grey-shell", "materialLayers": ["grey-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "grey-shell", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 137, 126, 1.0)", "secondaryAlbedo": "rgba(132, 127, 116, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "side-left"}};
  node_shell_rear_step_1.add(mesh_shell_rear_step_1);
  meshes["shell-rear-step"] = mesh_shell_rear_step_1;
  colliders["shell-rear-step"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_shell_rear_step_1);

  const endpoint_front_fascia_2 = makeAttachmentEndpoint(null);
  const node_front_fascia_2 = new THREE.Group();
  node_front_fascia_2.name = "Front fascia__pivot";
  node_front_fascia_2.scale.set(1, 1, 1);
  if (endpoint_front_fascia_2) {
    node_front_fascia_2.position.copy(endpoint_front_fascia_2.start);
    node_front_fascia_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_fascia_2.position.set(0.0, -0.005, 0.44);
    node_front_fascia_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_fascia_2.userData.sculptComponent = {"id": "front-fascia", "name": "Front fascia", "level": "meso", "role": "face-plate", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cream front panel with chamfered outer corners; bezel, floppy and knob openings carved as extrude holes; recess floors provided by child plates behind.", "geometryDescriptor": {"topologyIntent": "Cream front panel, chamfered outer edges, proud of bucket by small lip; extruded rounded-rect profile.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.46, -0.565], [0.46, -0.565], [0.5, -0.5249999999999999], [0.5, 0.5249999999999999], [0.46, 0.565], [-0.46, 0.565], [-0.5, 0.5249999999999999], [-0.5, -0.5249999999999999]], "depth": 0.1, "holes": [[[-0.38, -0.21500000000000002], [0.38, -0.21500000000000002], [0.42, -0.17500000000000002], [0.42, 0.42500000000000004], [0.38, 0.465], [-0.38, 0.465], [-0.42, 0.42500000000000004], [-0.42, -0.17500000000000002]], [[0.05500000000000001, -0.38749999999999996], [0.31499999999999995, -0.38749999999999996], [0.33499999999999996, -0.36749999999999994], [0.33499999999999996, -0.3225], [0.31499999999999995, -0.3025], [0.05500000000000001, -0.3025], [0.035, -0.3225], [0.035, -0.36749999999999994]]]}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.13, "depth": 0.1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, -0.005, 0.44], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crtBezel", "kind": "inset-frame", "description": "bezel opening 0.84W x 0.68 centered y+0.125; borders sides 0.08, top 0.10, bottom 0.35 (user-directed larger screen)", "affects": "identity"}, {"id": "floppySlot", "kind": "recess", "description": "rounded-rect recess plate lower-right (0.30W x 0.075W) with horizontal slit and round eject pinhole right end — carved as fascia profile hole; child plate/knob component seats behind.", "affects": "identity"}, {"id": "powerSwitch", "kind": "micro-plate", "description": "small rect switch plate low on left edge near seam", "affects": "secondary"}, {"id": "appleBadge", "kind": "decal", "description": "rainbow Apple mark decal applied directly on the flat fascia lower-left (no recess; user-directed)", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(222, 216, 198, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_front_fascia_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_front_fascia_2);
  nodes["front-fascia"] = node_front_fascia_2;
  const mesh_front_fascia_2Geometry = endpoint_front_fascia_2
    ? new THREE.CylinderGeometry(endpoint_front_fascia_2.endRadius, endpoint_front_fascia_2.baseRadius, endpoint_front_fascia_2.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.46, -0.565], [0.46, -0.565], [0.5, -0.5249999999999999], [0.5, 0.5249999999999999], [0.46, 0.565], [-0.46, 0.565], [-0.5, 0.5249999999999999], [-0.5, -0.5249999999999999]], "depth": 0.1, "holes": [[[-0.38, -0.21500000000000002], [0.38, -0.21500000000000002], [0.42, -0.17500000000000002], [0.42, 0.42500000000000004], [0.38, 0.465], [-0.38, 0.465], [-0.42, 0.42500000000000004], [-0.42, -0.17500000000000002]], [[0.05500000000000001, -0.38749999999999996], [0.31499999999999995, -0.38749999999999996], [0.33499999999999996, -0.36749999999999994], [0.33499999999999996, -0.3225], [0.31499999999999995, -0.3025], [0.05500000000000001, -0.3025], [0.035, -0.3225], [0.035, -0.36749999999999994]]]});
  if (!endpoint_front_fascia_2) {
    mesh_front_fascia_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_front_fascia_2 = new THREE.Mesh(
    mesh_front_fascia_2Geometry,
    materialMap["cream-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_fascia_2.name = "Front fascia";
  if (endpoint_front_fascia_2) {
    mesh_front_fascia_2.position.copy(endpoint_front_fascia_2.midpoint);
    mesh_front_fascia_2.quaternion.copy(endpoint_front_fascia_2.quaternion);
  }
  mesh_front_fascia_2.castShadow = options.castShadow ?? true;
  mesh_front_fascia_2.receiveShadow = options.receiveShadow ?? true;
  mesh_front_fascia_2.userData.sculptComponent = {"id": "front-fascia", "name": "Front fascia", "level": "meso", "role": "face-plate", "importance": 1.0, "confidence": 0.95, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cream front panel with chamfered outer corners; bezel, floppy and knob openings carved as extrude holes; recess floors provided by child plates behind.", "geometryDescriptor": {"topologyIntent": "Cream front panel, chamfered outer edges, proud of bucket by small lip; extruded rounded-rect profile.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.46, -0.565], [0.46, -0.565], [0.5, -0.5249999999999999], [0.5, 0.5249999999999999], [0.46, 0.565], [-0.46, 0.565], [-0.5, 0.5249999999999999], [-0.5, -0.5249999999999999]], "depth": 0.1, "holes": [[[-0.38, -0.21500000000000002], [0.38, -0.21500000000000002], [0.42, -0.17500000000000002], [0.42, 0.42500000000000004], [0.38, 0.465], [-0.38, 0.465], [-0.42, 0.42500000000000004], [-0.42, -0.17500000000000002]], [[0.05500000000000001, -0.38749999999999996], [0.31499999999999995, -0.38749999999999996], [0.33499999999999996, -0.36749999999999994], [0.33499999999999996, -0.3225], [0.31499999999999995, -0.3025], [0.05500000000000001, -0.3025], [0.035, -0.3225], [0.035, -0.36749999999999994]]]}}, "parent": "root", "attachment": null, "dimensions": {"width": 1.0, "height": 1.13, "depth": 0.1, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, -0.005, 0.44], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crtBezel", "kind": "inset-frame", "description": "bezel opening 0.84W x 0.68 centered y+0.125; borders sides 0.08, top 0.10, bottom 0.35 (user-directed larger screen)", "affects": "identity"}, {"id": "floppySlot", "kind": "recess", "description": "rounded-rect recess plate lower-right (0.30W x 0.075W) with horizontal slit and round eject pinhole right end — carved as fascia profile hole; child plate/knob component seats behind.", "affects": "identity"}, {"id": "powerSwitch", "kind": "micro-plate", "description": "small rect switch plate low on left edge near seam", "affects": "secondary"}, {"id": "appleBadge", "kind": "decal", "description": "rainbow Apple mark decal applied directly on the flat fascia lower-left (no recess; user-directed)", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(222, 216, 198, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_front_fascia_2.add(mesh_front_fascia_2);
  meshes["front-fascia"] = mesh_front_fascia_2;
  colliders["front-fascia"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_front_fascia_2);

  const endpoint_screen_panel_3 = makeAttachmentEndpoint(null);
  const node_screen_panel_3 = new THREE.Group();
  node_screen_panel_3.name = "Screen panel with Finder UI__pivot";
  node_screen_panel_3.scale.set(1, 1, 1);
  if (endpoint_screen_panel_3) {
    node_screen_panel_3.position.copy(endpoint_screen_panel_3.start);
    node_screen_panel_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_screen_panel_3.position.set(0.0, 0.125, 0.028);
    node_screen_panel_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_screen_panel_3.userData.sculptComponent = {"id": "screen-panel", "name": "Screen panel with Finder UI", "level": "meso", "role": "display", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flat display slab seated inside bezel recess; carries the live 1-bit Finder canvas texture (material-only UI layer riding on this panel).", "geometryDescriptor": {"topologyIntent": "Flat display slab seated inside bezel recess; carries the live 1-bit Finder canvas texture (material-only UI layer riding on this panel).", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "authored planar UV 0-1 across visible face for canvas texture", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-fascia", "attachment": {"parentSocket": "crtBezel-cavity", "contactType": "embed", "embedDepth": 0.03, "overlap": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, -0.02], "note": "embedded behind fascia bezel opening; front face 0.062 behind fascia front"}, "dimensions": {"width": 0.9, "height": 0.74, "depth": 0.02, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0.125, 0.028], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "screen-1bit", "materialLayers": ["screen-1bit"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "finderUiCanvas", "kind": "material-only", "description": "live CanvasTexture: menu bar (apple,File,Edit,View,Special), System 1.0 disk window (4 items/196K/201K), System Folder+Empty Folder+TeachText+A document icons, right disk tabs, Trash, scrollbars; 1-bit black on #D6D6D2", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "screen-1bit", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 210, 1.0)", "secondaryAlbedo": "rgba(10, 10, 10, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.8, "evidenceRef": "full-object"}};
  node_screen_panel_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["front-fascia"] ?? root).add(node_screen_panel_3);
  nodes["screen-panel"] = node_screen_panel_3;
  const mesh_screen_panel_3Geometry = endpoint_screen_panel_3
    ? new THREE.CylinderGeometry(endpoint_screen_panel_3.endRadius, endpoint_screen_panel_3.baseRadius, endpoint_screen_panel_3.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_screen_panel_3) {
    mesh_screen_panel_3Geometry.scale(0.9, 0.74, 0.02);
  }
  const mesh_screen_panel_3 = new THREE.Mesh(
    mesh_screen_panel_3Geometry,
    materialMap["screen-1bit"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_screen_panel_3.name = "Screen panel with Finder UI";
  if (endpoint_screen_panel_3) {
    mesh_screen_panel_3.position.copy(endpoint_screen_panel_3.midpoint);
    mesh_screen_panel_3.quaternion.copy(endpoint_screen_panel_3.quaternion);
  }
  mesh_screen_panel_3.castShadow = options.castShadow ?? true;
  mesh_screen_panel_3.receiveShadow = options.receiveShadow ?? true;
  mesh_screen_panel_3.userData.sculptComponent = {"id": "screen-panel", "name": "Screen panel with Finder UI", "level": "meso", "role": "display", "importance": 1.0, "confidence": 0.95, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Flat display slab seated inside bezel recess; carries the live 1-bit Finder canvas texture (material-only UI layer riding on this panel).", "geometryDescriptor": {"topologyIntent": "Flat display slab seated inside bezel recess; carries the live 1-bit Finder canvas texture (material-only UI layer riding on this panel).", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "authored planar UV 0-1 across visible face for canvas texture", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-fascia", "attachment": {"parentSocket": "crtBezel-cavity", "contactType": "embed", "embedDepth": 0.03, "overlap": 0.0, "gapTolerance": 0.005, "localStart": [0, 0, 0], "localEnd": [0, 0, -0.02], "note": "embedded behind fascia bezel opening; front face 0.062 behind fascia front"}, "dimensions": {"width": 0.9, "height": 0.74, "depth": 0.02, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0.125, 0.028], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "screen-1bit", "materialLayers": ["screen-1bit"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "finderUiCanvas", "kind": "material-only", "description": "live CanvasTexture: menu bar (apple,File,Edit,View,Special), System 1.0 disk window (4 items/196K/201K), System Folder+Empty Folder+TeachText+A document icons, right disk tabs, Trash, scrollbars; 1-bit black on #D6D6D2", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "screen-1bit", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 210, 1.0)", "secondaryAlbedo": "rgba(10, 10, 10, 1.0)", "materialClass": "glass", "materialClassConfidence": 0.8, "evidenceRef": "full-object"}};
  node_screen_panel_3.add(mesh_screen_panel_3);
  meshes["screen-panel"] = mesh_screen_panel_3;
  colliders["screen-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_screen_panel_3);

  const endpoint_floppy_plate_4 = makeAttachmentEndpoint(null);
  const node_floppy_plate_4 = new THREE.Group();
  node_floppy_plate_4.name = "Floppy drive plate__pivot";
  node_floppy_plate_4.scale.set(1, 1, 1);
  if (endpoint_floppy_plate_4) {
    node_floppy_plate_4.position.copy(endpoint_floppy_plate_4.start);
    node_floppy_plate_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_floppy_plate_4.position.set(0.185, -0.345, 0.078);
    node_floppy_plate_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_floppy_plate_4.userData.sculptComponent = {"id": "floppy-plate", "name": "Floppy drive plate", "level": "meso", "role": "drive-plate", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Cream recessed plate behind floppy opening; slit and eject pinhole are separate dark micro parts.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-fascia", "attachment": {"parentSocket": "floppy-opening", "contactType": "embed", "embedDepth": 0.02, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02]}, "dimensions": {"width": 0.34, "height": 0.115, "depth": 0.02, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.185, -0.345, 0.078], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "slit", "kind": "groove", "description": "horizontal slit 0.26 x 0.014 centered", "affects": "identity"}, {"id": "ejectPinhole", "kind": "hole", "description": "round pinhole r=0.006 right of slit", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(58, 58, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "front-closeup"}};
  node_floppy_plate_4.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["front-fascia"] ?? root).add(node_floppy_plate_4);
  nodes["floppy-plate"] = node_floppy_plate_4;
  const mesh_floppy_plate_4Geometry = endpoint_floppy_plate_4
    ? new THREE.CylinderGeometry(endpoint_floppy_plate_4.endRadius, endpoint_floppy_plate_4.baseRadius, endpoint_floppy_plate_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_floppy_plate_4) {
    mesh_floppy_plate_4Geometry.scale(0.34, 0.115, 0.02);
  }
  const mesh_floppy_plate_4 = new THREE.Mesh(
    mesh_floppy_plate_4Geometry,
    materialMap["cream-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_floppy_plate_4.name = "Floppy drive plate";
  if (endpoint_floppy_plate_4) {
    mesh_floppy_plate_4.position.copy(endpoint_floppy_plate_4.midpoint);
    mesh_floppy_plate_4.quaternion.copy(endpoint_floppy_plate_4.quaternion);
  }
  mesh_floppy_plate_4.castShadow = options.castShadow ?? true;
  mesh_floppy_plate_4.receiveShadow = options.receiveShadow ?? true;
  mesh_floppy_plate_4.userData.sculptComponent = {"id": "floppy-plate", "name": "Floppy drive plate", "level": "meso", "role": "drive-plate", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Cream recessed plate behind floppy opening; slit and eject pinhole are separate dark micro parts.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "front-fascia", "attachment": {"parentSocket": "floppy-opening", "contactType": "embed", "embedDepth": 0.02, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02]}, "dimensions": {"width": 0.34, "height": 0.115, "depth": 0.02, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.185, -0.345, 0.078], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "slit", "kind": "groove", "description": "horizontal slit 0.26 x 0.014 centered", "affects": "identity"}, {"id": "ejectPinhole", "kind": "hole", "description": "round pinhole r=0.006 right of slit", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(58, 58, 56, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "front-closeup"}};
  node_floppy_plate_4.add(mesh_floppy_plate_4);
  meshes["floppy-plate"] = mesh_floppy_plate_4;
  colliders["floppy-plate"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_floppy_plate_4);

  const endpoint_floppy_slit_5 = makeAttachmentEndpoint(null);
  const node_floppy_slit_5 = new THREE.Group();
  node_floppy_slit_5.name = "Floppy slit__pivot";
  node_floppy_slit_5.scale.set(1, 1, 1);
  if (endpoint_floppy_slit_5) {
    node_floppy_slit_5.position.copy(endpoint_floppy_slit_5.start);
    node_floppy_slit_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_floppy_slit_5.position.set(0.0, 0.0, 0.012);
    node_floppy_slit_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_floppy_slit_5.userData.sculptComponent = {"id": "floppy-slit", "name": "Floppy slit", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Horizontal slit reading as the disk opening; thin dark bar proud of the cream plate.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "floppy-plate", "attachment": {"parentSocket": "floppy-plate", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.24, "height": 0.018, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_floppy_slit_5.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["floppy-plate"] ?? root).add(node_floppy_slit_5);
  nodes["floppy-slit"] = node_floppy_slit_5;
  const mesh_floppy_slit_5Geometry = endpoint_floppy_slit_5
    ? new THREE.CylinderGeometry(endpoint_floppy_slit_5.endRadius, endpoint_floppy_slit_5.baseRadius, endpoint_floppy_slit_5.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_floppy_slit_5) {
    mesh_floppy_slit_5Geometry.scale(0.24, 0.018, 0.012);
  }
  const mesh_floppy_slit_5 = new THREE.Mesh(
    mesh_floppy_slit_5Geometry,
    materialMap["dark-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_floppy_slit_5.name = "Floppy slit";
  if (endpoint_floppy_slit_5) {
    mesh_floppy_slit_5.position.copy(endpoint_floppy_slit_5.midpoint);
    mesh_floppy_slit_5.quaternion.copy(endpoint_floppy_slit_5.quaternion);
  }
  mesh_floppy_slit_5.castShadow = options.castShadow ?? true;
  mesh_floppy_slit_5.receiveShadow = options.receiveShadow ?? true;
  mesh_floppy_slit_5.userData.sculptComponent = {"id": "floppy-slit", "name": "Floppy slit", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Horizontal slit reading as the disk opening; thin dark bar proud of the cream plate.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "floppy-plate", "attachment": {"parentSocket": "floppy-plate", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.24, "height": 0.018, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0.012], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_floppy_slit_5.add(mesh_floppy_slit_5);
  meshes["floppy-slit"] = mesh_floppy_slit_5;
  colliders["floppy-slit"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_floppy_slit_5);

  const attachment_eject_pinhole_6 = {"parentSocket": "floppy-plate", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]};
  const endpoint_eject_pinhole_6 = makeAttachmentEndpoint(attachment_eject_pinhole_6);
  const node_eject_pinhole_6 = new THREE.Group();
  node_eject_pinhole_6.name = "Eject pinhole__pivot";
  node_eject_pinhole_6.scale.set(1, 1, 1);
  if (endpoint_eject_pinhole_6) {
    node_eject_pinhole_6.position.copy(endpoint_eject_pinhole_6.start);
    node_eject_pinhole_6.rotation.set(1.5708, 0.0, 0.0);
  } else {
    node_eject_pinhole_6.position.set(0.135, 0.0, 0.012);
    node_eject_pinhole_6.rotation.set(1.5708, 0.0, 0.0);
  }
  node_eject_pinhole_6.userData.sculptComponent = {"id": "eject-pinhole", "name": "Eject pinhole", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Round eject pinhole right of the slit.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "floppy-plate", "attachment": {"parentSocket": "floppy-plate", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.135, 0, 0.012], "rotation": [1.5708, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_eject_pinhole_6.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["floppy-plate"] ?? root).add(node_eject_pinhole_6);
  nodes["eject-pinhole"] = node_eject_pinhole_6;
  const mesh_eject_pinhole_6Geometry = endpoint_eject_pinhole_6
    ? new THREE.CylinderGeometry(endpoint_eject_pinhole_6.endRadius, endpoint_eject_pinhole_6.baseRadius, endpoint_eject_pinhole_6.length, 32, 12)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
  if (!endpoint_eject_pinhole_6) {
    mesh_eject_pinhole_6Geometry.scale(0.016, 0.016, 0.012);
  }
  const mesh_eject_pinhole_6 = new THREE.Mesh(
    mesh_eject_pinhole_6Geometry,
    materialMap["dark-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_eject_pinhole_6.name = "Eject pinhole";
  if (endpoint_eject_pinhole_6) {
    mesh_eject_pinhole_6.position.copy(endpoint_eject_pinhole_6.midpoint);
    mesh_eject_pinhole_6.quaternion.copy(endpoint_eject_pinhole_6.quaternion);
  }
  mesh_eject_pinhole_6.castShadow = options.castShadow ?? true;
  mesh_eject_pinhole_6.receiveShadow = options.receiveShadow ?? true;
  mesh_eject_pinhole_6.userData.sculptComponent = {"id": "eject-pinhole", "name": "Eject pinhole", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Round eject pinhole right of the slit.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "floppy-plate", "attachment": {"parentSocket": "floppy-plate", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.016, "height": 0.016, "depth": 0.012, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.135, 0, 0.012], "rotation": [1.5708, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_eject_pinhole_6.add(mesh_eject_pinhole_6);
  meshes["eject-pinhole"] = mesh_eject_pinhole_6;
  colliders["eject-pinhole"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_eject_pinhole_6);

  const endpoint_pedestal_7 = makeAttachmentEndpoint(null);
  const node_pedestal_7 = new THREE.Group();
  node_pedestal_7.name = "Pedestal base__pivot";
  node_pedestal_7.scale.set(1, 1, 1);
  if (endpoint_pedestal_7) {
    node_pedestal_7.position.copy(endpoint_pedestal_7.start);
    node_pedestal_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_pedestal_7.position.set(0.0, -0.555, -0.115);
    node_pedestal_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_pedestal_7.userData.sculptComponent = {"id": "pedestal", "name": "Pedestal base", "level": "meso", "role": "base", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Recessed plinth under shell; rigid box, darker grey; front jack recess + rear vents.", "geometryDescriptor": {"topologyIntent": "Recessed plinth under shell; rigid box, darker grey; front jack recess + rear vents.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.92, "height": 0.145, "depth": 1.1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.555, -0.115], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "pedestal-grey", "materialLayers": ["pedestal-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "jackRecess", "kind": "socket-recess", "description": "front-bottom rounded recess with keyboard jack socket plate", "affects": "identity"}, {"id": "rearSocketPlate", "kind": "socket-recess", "description": "rear-right socket plate receiving mouse cable", "affects": "identity"}, {"id": "rearVents", "kind": "slot-array", "description": "horizontal vent slats across rear face", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.62, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Rear vent slats: 6 thin dark horizontal bars across rear face (geometry)."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "pedestal-grey", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 123, 113, 1.0)", "secondaryAlbedo": "rgba(110, 106, 97, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_pedestal_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_pedestal_7);
  nodes["pedestal"] = node_pedestal_7;
  const mesh_pedestal_7Geometry = endpoint_pedestal_7
    ? new THREE.CylinderGeometry(endpoint_pedestal_7.endRadius, endpoint_pedestal_7.baseRadius, endpoint_pedestal_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_pedestal_7) {
    mesh_pedestal_7Geometry.scale(0.92, 0.145, 1.1);
  }
  const mesh_pedestal_7 = new THREE.Mesh(
    mesh_pedestal_7Geometry,
    materialMap["pedestal-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_pedestal_7.name = "Pedestal base";
  if (endpoint_pedestal_7) {
    mesh_pedestal_7.position.copy(endpoint_pedestal_7.midpoint);
    mesh_pedestal_7.quaternion.copy(endpoint_pedestal_7.quaternion);
  }
  mesh_pedestal_7.castShadow = options.castShadow ?? true;
  mesh_pedestal_7.receiveShadow = options.receiveShadow ?? true;
  mesh_pedestal_7.userData.sculptComponent = {"id": "pedestal", "name": "Pedestal base", "level": "meso", "role": "base", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Recessed plinth under shell; rigid box, darker grey; front jack recess + rear vents.", "geometryDescriptor": {"topologyIntent": "Recessed plinth under shell; rigid box, darker grey; front jack recess + rear vents.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.92, "height": 0.145, "depth": 1.1, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.555, -0.115], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "pedestal-grey", "materialLayers": ["pedestal-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "jackRecess", "kind": "socket-recess", "description": "front-bottom rounded recess with keyboard jack socket plate", "affects": "identity"}, {"id": "rearSocketPlate", "kind": "socket-recess", "description": "rear-right socket plate receiving mouse cable", "affects": "identity"}, {"id": "rearVents", "kind": "slot-array", "description": "horizontal vent slats across rear face", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.62, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Rear vent slats: 6 thin dark horizontal bars across rear face (geometry)."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "pedestal-grey", "colorMaterialRecipe": {"dominantAlbedo": "rgba(127, 123, 113, 1.0)", "secondaryAlbedo": "rgba(110, 106, 97, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_pedestal_7.add(mesh_pedestal_7);
  meshes["pedestal"] = mesh_pedestal_7;
  colliders["pedestal"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_pedestal_7);

  const endpoint_jack_plate_front_8 = makeAttachmentEndpoint(null);
  const node_jack_plate_front_8 = new THREE.Group();
  node_jack_plate_front_8.name = "Keyboard jack plate__pivot";
  node_jack_plate_front_8.scale.set(1, 1, 1);
  if (endpoint_jack_plate_front_8) {
    node_jack_plate_front_8.position.copy(endpoint_jack_plate_front_8.start);
    node_jack_plate_front_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_jack_plate_front_8.position.set(-0.12, -0.01, 0.556);
    node_jack_plate_front_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_jack_plate_front_8.userData.sculptComponent = {"id": "jack-plate-front", "name": "Keyboard jack plate", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Front socket plate where the coiled cable terminates.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pedestal", "attachment": {"parentSocket": "pedestal", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.1, "height": 0.06, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.12, -0.01, 0.556], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_jack_plate_front_8.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["pedestal"] ?? root).add(node_jack_plate_front_8);
  nodes["jack-plate-front"] = node_jack_plate_front_8;
  const mesh_jack_plate_front_8Geometry = endpoint_jack_plate_front_8
    ? new THREE.CylinderGeometry(endpoint_jack_plate_front_8.endRadius, endpoint_jack_plate_front_8.baseRadius, endpoint_jack_plate_front_8.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_jack_plate_front_8) {
    mesh_jack_plate_front_8Geometry.scale(0.1, 0.06, 0.014);
  }
  const mesh_jack_plate_front_8 = new THREE.Mesh(
    mesh_jack_plate_front_8Geometry,
    materialMap["dark-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_jack_plate_front_8.name = "Keyboard jack plate";
  if (endpoint_jack_plate_front_8) {
    mesh_jack_plate_front_8.position.copy(endpoint_jack_plate_front_8.midpoint);
    mesh_jack_plate_front_8.quaternion.copy(endpoint_jack_plate_front_8.quaternion);
  }
  mesh_jack_plate_front_8.castShadow = options.castShadow ?? true;
  mesh_jack_plate_front_8.receiveShadow = options.receiveShadow ?? true;
  mesh_jack_plate_front_8.userData.sculptComponent = {"id": "jack-plate-front", "name": "Keyboard jack plate", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Front socket plate where the coiled cable terminates.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pedestal", "attachment": {"parentSocket": "pedestal", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.1, "height": 0.06, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.12, -0.01, 0.556], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_jack_plate_front_8.add(mesh_jack_plate_front_8);
  meshes["jack-plate-front"] = mesh_jack_plate_front_8;
  colliders["jack-plate-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_jack_plate_front_8);

  const endpoint_socket_plate_rear_9 = makeAttachmentEndpoint(null);
  const node_socket_plate_rear_9 = new THREE.Group();
  node_socket_plate_rear_9.name = "Mouse socket plate__pivot";
  node_socket_plate_rear_9.scale.set(1, 1, 1);
  if (endpoint_socket_plate_rear_9) {
    node_socket_plate_rear_9.position.copy(endpoint_socket_plate_rear_9.start);
    node_socket_plate_rear_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_socket_plate_rear_9.position.set(0.3, -0.01, -0.556);
    node_socket_plate_rear_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_socket_plate_rear_9.userData.sculptComponent = {"id": "socket-plate-rear", "name": "Mouse socket plate", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rear socket plate where the mouse cable terminates.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pedestal", "attachment": {"parentSocket": "pedestal", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.1, "height": 0.06, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.3, -0.01, -0.556], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_socket_plate_rear_9.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["pedestal"] ?? root).add(node_socket_plate_rear_9);
  nodes["socket-plate-rear"] = node_socket_plate_rear_9;
  const mesh_socket_plate_rear_9Geometry = endpoint_socket_plate_rear_9
    ? new THREE.CylinderGeometry(endpoint_socket_plate_rear_9.endRadius, endpoint_socket_plate_rear_9.baseRadius, endpoint_socket_plate_rear_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_socket_plate_rear_9) {
    mesh_socket_plate_rear_9Geometry.scale(0.1, 0.06, 0.014);
  }
  const mesh_socket_plate_rear_9 = new THREE.Mesh(
    mesh_socket_plate_rear_9Geometry,
    materialMap["dark-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_socket_plate_rear_9.name = "Mouse socket plate";
  if (endpoint_socket_plate_rear_9) {
    mesh_socket_plate_rear_9.position.copy(endpoint_socket_plate_rear_9.midpoint);
    mesh_socket_plate_rear_9.quaternion.copy(endpoint_socket_plate_rear_9.quaternion);
  }
  mesh_socket_plate_rear_9.castShadow = options.castShadow ?? true;
  mesh_socket_plate_rear_9.receiveShadow = options.receiveShadow ?? true;
  mesh_socket_plate_rear_9.userData.sculptComponent = {"id": "socket-plate-rear", "name": "Mouse socket plate", "level": "micro", "role": "detail", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Rear socket plate where the mouse cable terminates.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "pedestal", "attachment": {"parentSocket": "pedestal", "contactType": "embed", "embedDepth": 0.006, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, 0, 0.006]}, "dimensions": {"width": 0.1, "height": 0.06, "depth": 0.014, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.3, -0.01, -0.556], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.85, "evidenceRef": "front-closeup"}};
  node_socket_plate_rear_9.add(mesh_socket_plate_rear_9);
  meshes["socket-plate-rear"] = mesh_socket_plate_rear_9;
  colliders["socket-plate-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_socket_plate_rear_9);

  const endpoint_kb_tray_10 = makeAttachmentEndpoint(null);
  const node_kb_tray_10 = new THREE.Group();
  node_kb_tray_10.name = "Keyboard tray + skirt (keyboard unit pivot)__pivot";
  node_kb_tray_10.scale.set(1, 1, 1);
  if (endpoint_kb_tray_10) {
    node_kb_tray_10.position.copy(endpoint_kb_tray_10.start);
    node_kb_tray_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_kb_tray_10.position.set(-0.1, -0.595, 1.175);
    node_kb_tray_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_kb_tray_10.userData.sculptComponent = {"id": "kb-tray", "name": "Keyboard tray + skirt (keyboard unit pivot)", "level": "macro", "role": "housing", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Low wedge tray; box at blockout, wedge side-profile extrude added at form-refinement.", "geometryDescriptor": {"topologyIntent": "Cream wedge tray: top plate with rounded corners + base skirt; slight rearward rise.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.55, "height": 0.06, "depth": 0.66, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.1, -0.595, 1.175], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "unit-pivot", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "keyWell", "kind": "recess", "description": "rect recess holding key field, inset ~0.06W margin", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(242, 238, 225, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_kb_tray_10.userData.actionProfile = {"animationRole": "unit-pivot", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_kb_tray_10);
  nodes["kb-tray"] = node_kb_tray_10;
  const mesh_kb_tray_10Geometry = endpoint_kb_tray_10
    ? new THREE.CylinderGeometry(endpoint_kb_tray_10.endRadius, endpoint_kb_tray_10.baseRadius, endpoint_kb_tray_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_kb_tray_10) {
    mesh_kb_tray_10Geometry.scale(1.55, 0.06, 0.66);
  }
  const mesh_kb_tray_10 = new THREE.Mesh(
    mesh_kb_tray_10Geometry,
    materialMap["cream-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_kb_tray_10.name = "Keyboard tray + skirt (keyboard unit pivot)";
  if (endpoint_kb_tray_10) {
    mesh_kb_tray_10.position.copy(endpoint_kb_tray_10.midpoint);
    mesh_kb_tray_10.quaternion.copy(endpoint_kb_tray_10.quaternion);
  }
  mesh_kb_tray_10.castShadow = options.castShadow ?? true;
  mesh_kb_tray_10.receiveShadow = options.receiveShadow ?? true;
  mesh_kb_tray_10.userData.sculptComponent = {"id": "kb-tray", "name": "Keyboard tray + skirt (keyboard unit pivot)", "level": "macro", "role": "housing", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Low wedge tray; box at blockout, wedge side-profile extrude added at form-refinement.", "geometryDescriptor": {"topologyIntent": "Cream wedge tray: top plate with rounded corners + base skirt; slight rearward rise.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.55, "height": 0.06, "depth": 0.66, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.1, -0.595, 1.175], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "unit-pivot", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "keyWell", "kind": "recess", "description": "rect recess holding key field, inset ~0.06W margin", "affects": "identity"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(242, 238, 225, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_kb_tray_10.add(mesh_kb_tray_10);
  meshes["kb-tray"] = mesh_kb_tray_10;
  colliders["kb-tray"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_kb_tray_10);

  const endpoint_kb_midband_11 = makeAttachmentEndpoint(null);
  const node_kb_midband_11 = new THREE.Group();
  node_kb_midband_11.name = "Keyboard mid band__pivot";
  node_kb_midband_11.scale.set(1, 1, 1);
  if (endpoint_kb_midband_11) {
    node_kb_midband_11.position.copy(endpoint_kb_midband_11.start);
    node_kb_midband_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_kb_midband_11.position.set(0.0, -0.024, 0.0);
    node_kb_midband_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_kb_midband_11.userData.sculptComponent = {"id": "kb-midband", "name": "Keyboard mid band", "level": "meso", "role": "trim", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Dark grey band between cream top tray and skirt, visible on all sides.", "geometryDescriptor": {"topologyIntent": "Dark grey band between cream top tray and skirt, visible on all sides.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.01, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "kb-tray", "attachment": null, "dimensions": {"width": 1.555, "height": 0.012, "depth": 0.665, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.024, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_kb_midband_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["kb-tray"] ?? root).add(node_kb_midband_11);
  nodes["kb-midband"] = node_kb_midband_11;
  const mesh_kb_midband_11Geometry = endpoint_kb_midband_11
    ? new THREE.CylinderGeometry(endpoint_kb_midband_11.endRadius, endpoint_kb_midband_11.baseRadius, endpoint_kb_midband_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_kb_midband_11) {
    mesh_kb_midband_11Geometry.scale(1.555, 0.012, 0.665);
  }
  const mesh_kb_midband_11 = new THREE.Mesh(
    mesh_kb_midband_11Geometry,
    materialMap["dark-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_kb_midband_11.name = "Keyboard mid band";
  if (endpoint_kb_midband_11) {
    mesh_kb_midband_11.position.copy(endpoint_kb_midband_11.midpoint);
    mesh_kb_midband_11.quaternion.copy(endpoint_kb_midband_11.quaternion);
  }
  mesh_kb_midband_11.castShadow = options.castShadow ?? true;
  mesh_kb_midband_11.receiveShadow = options.receiveShadow ?? true;
  mesh_kb_midband_11.userData.sculptComponent = {"id": "kb-midband", "name": "Keyboard mid band", "level": "meso", "role": "trim", "importance": 0.6, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Dark grey band between cream top tray and skirt, visible on all sides.", "geometryDescriptor": {"topologyIntent": "Dark grey band between cream top tray and skirt, visible on all sides.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.01, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "kb-tray", "attachment": null, "dimensions": {"width": 1.555, "height": 0.012, "depth": 0.665, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.024, 0], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-accent", "materialLayers": ["dark-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "dark-accent", "colorMaterialRecipe": {"dominantAlbedo": "rgba(58, 58, 56, 1.0)", "secondaryAlbedo": "rgba(110, 107, 100, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_kb_midband_11.add(mesh_kb_midband_11);
  meshes["kb-midband"] = mesh_kb_midband_11;
  colliders["kb-midband"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_kb_midband_11);

  const endpoint_key_field_12 = makeAttachmentEndpoint(null);
  const node_key_field_12 = new THREE.Group();
  node_key_field_12.name = "Key array__pivot";
  node_key_field_12.scale.set(1, 1, 1);
  if (endpoint_key_field_12) {
    node_key_field_12.position.copy(endpoint_key_field_12.start);
    node_key_field_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_key_field_12.position.set(0.0, 0.045, 0.01);
    node_key_field_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_key_field_12.userData.sculptComponent = {"id": "key-field", "name": "Key array", "level": "meso", "role": "keys", "importance": 1.0, "confidence": 0.95, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "~58 truncated-pyramid keycaps generated by repetition system kb-keys; individual frusta with hard faces.", "geometryDescriptor": {"topologyIntent": "~58 truncated-pyramid keycaps generated by repetition system kb-keys; individual frusta with hard faces.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "kb-tray", "attachment": null, "dimensions": {"width": 1.4, "height": 0.04, "depth": 0.54, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0.045, 0.01], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "keycap-grey", "materialLayers": ["keycap-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "legends", "kind": "surface-relief", "description": "engraved lighter-grey legends per canonical M0110 layout (canvas texture per cap top or vertex-tint)", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Per-cap legends from one shared 16x4 canvas atlas (light ink #C9C5B9 on cap grey), top-face UVs remapped per cap; M0110 legend set."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "keycap-grey", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 133, 120, 1.0)", "secondaryAlbedo": "rgba(176, 172, 160, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_key_field_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["kb-tray"] ?? root).add(node_key_field_12);
  nodes["key-field"] = node_key_field_12;
  const mesh_key_field_12Geometry = endpoint_key_field_12
    ? new THREE.CylinderGeometry(endpoint_key_field_12.endRadius, endpoint_key_field_12.baseRadius, endpoint_key_field_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_key_field_12) {
    mesh_key_field_12Geometry.scale(1.4, 0.04, 0.54);
  }
  const mesh_key_field_12 = new THREE.Mesh(
    mesh_key_field_12Geometry,
    materialMap["keycap-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_key_field_12.name = "Key array";
  if (endpoint_key_field_12) {
    mesh_key_field_12.position.copy(endpoint_key_field_12.midpoint);
    mesh_key_field_12.quaternion.copy(endpoint_key_field_12.quaternion);
  }
  mesh_key_field_12.castShadow = options.castShadow ?? true;
  mesh_key_field_12.receiveShadow = options.receiveShadow ?? true;
  mesh_key_field_12.userData.sculptComponent = {"id": "key-field", "name": "Key array", "level": "meso", "role": "keys", "importance": 1.0, "confidence": 0.95, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "~58 truncated-pyramid keycaps generated by repetition system kb-keys; individual frusta with hard faces.", "geometryDescriptor": {"topologyIntent": "~58 truncated-pyramid keycaps generated by repetition system kb-keys; individual frusta with hard faces.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "kb-tray", "attachment": null, "dimensions": {"width": 1.4, "height": 0.04, "depth": 0.54, "units": "relative", "confidence": 0.95}, "transform": {"position": [0, 0.045, 0.01], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "keycap-grey", "materialLayers": ["keycap-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "legends", "kind": "surface-relief", "description": "engraved lighter-grey legends per canonical M0110 layout (canvas texture per cap top or vertex-tint)", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.5, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Per-cap legends from one shared 16x4 canvas atlas (light ink #C9C5B9 on cap grey), top-face UVs remapped per cap; M0110 legend set."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "keycap-grey", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 133, 120, 1.0)", "secondaryAlbedo": "rgba(176, 172, 160, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_key_field_12.add(mesh_key_field_12);
  meshes["key-field"] = mesh_key_field_12;
  colliders["key-field"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_key_field_12);

  const attachment_kb_cable_13 = {"parentSocket": "kb-rear-left-port", "contactType": "socket", "embedDepth": 0.02, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [-0.62, 0.0, -0.345], "localEnd": [0.22, 0.03, -0.74], "note": "start=keyboard rear-left port, end=pedestal front jack recess; local to kb-tray pivot", "baseRadius": 0.032, "endRadius": 0.032};
  const endpoint_kb_cable_13 = makeAttachmentEndpoint(attachment_kb_cable_13);
  const node_kb_cable_13 = new THREE.Group();
  node_kb_cable_13.name = "Coiled keyboard cable__pivot";
  node_kb_cable_13.scale.set(1, 1, 1);
  if (endpoint_kb_cable_13) {
    node_kb_cable_13.position.copy(endpoint_kb_cable_13.start);
    node_kb_cable_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_kb_cable_13.position.set(0.35, 0.03, -0.3);
    node_kb_cable_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_kb_cable_13.userData.sculptComponent = {"id": "kb-cable", "name": "Coiled keyboard cable", "level": "meso", "role": "connector", "importance": 0.9, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Helix tube (~20 turns) along a sagging catenary path from keyboard rear-left to chassis front jack; TubeGeometry on CatmullRom path, never a box.", "geometryDescriptor": {"topologyIntent": "Helix tube (~20 turns) along a sagging catenary path from keyboard rear-left to chassis front jack; TubeGeometry on CatmullRom path, never a box.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "kb-tray", "attachment": {"parentSocket": "kb-rear-left-port", "contactType": "socket", "embedDepth": 0.02, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [-0.62, 0.0, -0.345], "localEnd": [0.22, 0.03, -0.74], "note": "start=keyboard rear-left port, end=pedestal front jack recess; local to kb-tray pivot", "baseRadius": 0.032, "endRadius": 0.032}, "dimensions": {"width": 0.55, "height": 0.16, "depth": 0.3, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.35, 0.03, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cable", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cable-dark", "materialLayers": ["cable-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cable-dark", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 28, 28, 1.0)", "secondaryAlbedo": "rgba(38, 38, 38, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_kb_cable_13.userData.actionProfile = {"animationRole": "cable", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["kb-tray"] ?? root).add(node_kb_cable_13);
  nodes["kb-cable"] = node_kb_cable_13;
  const mesh_kb_cable_13Geometry = endpoint_kb_cable_13
    ? new THREE.CylinderGeometry(endpoint_kb_cable_13.endRadius, endpoint_kb_cable_13.baseRadius, endpoint_kb_cable_13.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_kb_cable_13) {
    mesh_kb_cable_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_kb_cable_13 = new THREE.Mesh(
    mesh_kb_cable_13Geometry,
    materialMap["cable-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_kb_cable_13.name = "Coiled keyboard cable";
  if (endpoint_kb_cable_13) {
    mesh_kb_cable_13.position.copy(endpoint_kb_cable_13.midpoint);
    mesh_kb_cable_13.quaternion.copy(endpoint_kb_cable_13.quaternion);
  }
  mesh_kb_cable_13.castShadow = options.castShadow ?? true;
  mesh_kb_cable_13.receiveShadow = options.receiveShadow ?? true;
  mesh_kb_cable_13.userData.sculptComponent = {"id": "kb-cable", "name": "Coiled keyboard cable", "level": "meso", "role": "connector", "importance": 0.9, "confidence": 0.9, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Helix tube (~20 turns) along a sagging catenary path from keyboard rear-left to chassis front jack; TubeGeometry on CatmullRom path, never a box.", "geometryDescriptor": {"topologyIntent": "Helix tube (~20 turns) along a sagging catenary path from keyboard rear-left to chassis front jack; TubeGeometry on CatmullRom path, never a box.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "kb-tray", "attachment": {"parentSocket": "kb-rear-left-port", "contactType": "socket", "embedDepth": 0.02, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [-0.62, 0.0, -0.345], "localEnd": [0.22, 0.03, -0.74], "note": "start=keyboard rear-left port, end=pedestal front jack recess; local to kb-tray pivot", "baseRadius": 0.032, "endRadius": 0.032}, "dimensions": {"width": 0.55, "height": 0.16, "depth": 0.3, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.35, 0.03, -0.3], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cable", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cable-dark", "materialLayers": ["cable-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cable-dark", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 28, 28, 1.0)", "secondaryAlbedo": "rgba(38, 38, 38, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_kb_cable_13.add(mesh_kb_cable_13);
  meshes["kb-cable"] = mesh_kb_cable_13;
  colliders["kb-cable"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_kb_cable_13);

  const endpoint_mouse_body_14 = makeAttachmentEndpoint(null);
  const node_mouse_body_14 = new THREE.Group();
  node_mouse_body_14.name = "Mouse body (mouse unit pivot)__pivot";
  node_mouse_body_14.scale.set(1, 1, 1);
  if (endpoint_mouse_body_14) {
    node_mouse_body_14.position.copy(endpoint_mouse_body_14.start);
    node_mouse_body_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mouse_body_14.position.set(0.91, -0.555, 1.445);
    node_mouse_body_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_mouse_body_14.userData.sculptComponent = {"id": "mouse-body", "name": "Mouse body (mouse unit pivot)", "level": "macro", "role": "housing", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Cream cuboid with large front-top chamfer (wedge nose) and small side chamfers; grey lower half.", "geometryDescriptor": {"topologyIntent": "Cream cuboid with large front-top chamfer (wedge nose) and small side chamfers; grey lower half.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.28, "height": 0.14, "depth": 0.42, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.91, -0.555, 1.445], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "unit-pivot", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "badgeRecess", "kind": "recess", "description": "small square emblem inset ~0.036, darker grey, flush with top face center", "affects": "secondary"}, {"id": "bottomShell", "kind": "color-split", "description": "grey base band 0.03 tall around the bottom, realized as integral geometry", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Badge recess: small grey plate inset on top face center."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(127, 123, 113, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_mouse_body_14.userData.actionProfile = {"animationRole": "unit-pivot", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_mouse_body_14);
  nodes["mouse-body"] = node_mouse_body_14;
  const mesh_mouse_body_14Geometry = endpoint_mouse_body_14
    ? new THREE.CylinderGeometry(endpoint_mouse_body_14.endRadius, endpoint_mouse_body_14.baseRadius, endpoint_mouse_body_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_mouse_body_14) {
    mesh_mouse_body_14Geometry.scale(0.28, 0.14, 0.42);
  }
  const mesh_mouse_body_14 = new THREE.Mesh(
    mesh_mouse_body_14Geometry,
    materialMap["cream-plastic"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouse_body_14.name = "Mouse body (mouse unit pivot)";
  if (endpoint_mouse_body_14) {
    mesh_mouse_body_14.position.copy(endpoint_mouse_body_14.midpoint);
    mesh_mouse_body_14.quaternion.copy(endpoint_mouse_body_14.quaternion);
  }
  mesh_mouse_body_14.castShadow = options.castShadow ?? true;
  mesh_mouse_body_14.receiveShadow = options.receiveShadow ?? true;
  mesh_mouse_body_14.userData.sculptComponent = {"id": "mouse-body", "name": "Mouse body (mouse unit pivot)", "level": "macro", "role": "housing", "importance": 0.85, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Cream cuboid with large front-top chamfer (wedge nose) and small side chamfers; grey lower half.", "geometryDescriptor": {"topologyIntent": "Cream cuboid with large front-top chamfer (wedge nose) and small side chamfers; grey lower half.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.28, "height": 0.14, "depth": 0.42, "units": "relative", "confidence": 0.9}, "transform": {"position": [0.91, -0.555, 1.445], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "unit-pivot", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cream-plastic", "materialLayers": ["cream-plastic"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "badgeRecess", "kind": "recess", "description": "small square emblem inset ~0.036, darker grey, flush with top face center", "affects": "secondary"}, {"id": "bottomShell", "kind": "color-split", "description": "grey base band 0.03 tall around the bottom, realized as integral geometry", "affects": "secondary"}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": "Badge recess: small grey plate inset on top face center."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cream-plastic", "colorMaterialRecipe": {"dominantAlbedo": "rgba(233, 228, 213, 1.0)", "secondaryAlbedo": "rgba(127, 123, 113, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.95, "evidenceRef": "full-object"}};
  node_mouse_body_14.add(mesh_mouse_body_14);
  meshes["mouse-body"] = mesh_mouse_body_14;
  colliders["mouse-body"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mouse_body_14);

  const endpoint_mouse_button_15 = makeAttachmentEndpoint(null);
  const node_mouse_button_15 = new THREE.Group();
  node_mouse_button_15.name = "Mouse button plate__pivot";
  node_mouse_button_15.scale.set(1, 1, 1);
  if (endpoint_mouse_button_15) {
    node_mouse_button_15.position.copy(endpoint_mouse_button_15.start);
    node_mouse_button_15.rotation.set(-0.274, 0.0, 0.0);
  } else {
    node_mouse_button_15.position.set(0.0, 0.053, -0.14);
    node_mouse_button_15.rotation.set(-0.274, 0.0, 0.0);
  }
  node_mouse_button_15.userData.sculptComponent = {"id": "mouse-button", "name": "Mouse button plate", "level": "meso", "role": "control", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Wide button plate inset into the nose slope well, slope-aligned (rot.x=-0.274 matching slope normal); reads flush like the M0100 button.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mouse-body", "attachment": {"parentSocket": "button-well", "contactType": "embed", "embedDepth": 0.008, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, -0.008, 0]}, "dimensions": {"width": 0.19, "height": 0.012, "depth": 0.118, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.053, -0.14], "rotation": [-0.274, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "keycap-grey", "materialLayers": ["keycap-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "keycap-grey", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 133, 120, 1.0)", "secondaryAlbedo": "rgba(176, 172, 160, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_mouse_button_15.userData.actionProfile = {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mouse-body"] ?? root).add(node_mouse_button_15);
  nodes["mouse-button"] = node_mouse_button_15;
  const mesh_mouse_button_15Geometry = endpoint_mouse_button_15
    ? new THREE.CylinderGeometry(endpoint_mouse_button_15.endRadius, endpoint_mouse_button_15.baseRadius, endpoint_mouse_button_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_mouse_button_15) {
    mesh_mouse_button_15Geometry.scale(0.19, 0.012, 0.118);
  }
  const mesh_mouse_button_15 = new THREE.Mesh(
    mesh_mouse_button_15Geometry,
    materialMap["keycap-grey"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouse_button_15.name = "Mouse button plate";
  if (endpoint_mouse_button_15) {
    mesh_mouse_button_15.position.copy(endpoint_mouse_button_15.midpoint);
    mesh_mouse_button_15.quaternion.copy(endpoint_mouse_button_15.quaternion);
  }
  mesh_mouse_button_15.castShadow = options.castShadow ?? true;
  mesh_mouse_button_15.receiveShadow = options.receiveShadow ?? true;
  mesh_mouse_button_15.userData.sculptComponent = {"id": "mouse-button", "name": "Mouse button plate", "level": "meso", "role": "control", "importance": 0.8, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Wide button plate inset into the nose slope well, slope-aligned (rot.x=-0.274 matching slope normal); reads flush like the M0100 button.", "geometryDescriptor": {"topologyIntent": "Wide rounded-rect plate inset into front-top chamfered area, slightly darker grey, sits 0.005 proud gap.", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.02, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mouse-body", "attachment": {"parentSocket": "button-well", "contactType": "embed", "embedDepth": 0.008, "overlap": 0.0, "gapTolerance": 0.003, "localStart": [0, 0, 0], "localEnd": [0, -0.008, 0]}, "dimensions": {"width": 0.19, "height": 0.012, "depth": 0.118, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.053, -0.14], "rotation": [-0.274, 0, 0]}, "actionProfile": {"animationRole": "button", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "keycap-grey", "materialLayers": ["keycap-grey"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "keycap-grey", "colorMaterialRecipe": {"dominantAlbedo": "rgba(138, 133, 120, 1.0)", "secondaryAlbedo": "rgba(176, 172, 160, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_mouse_button_15.add(mesh_mouse_button_15);
  meshes["mouse-button"] = mesh_mouse_button_15;
  colliders["mouse-button"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mouse_button_15);

  const attachment_mouse_cable_16 = {"parentSocket": "mouse-rear-port", "contactType": "socket", "embedDepth": 0.015, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [0, 0.0, -0.21], "localEnd": [-0.15, -0.01, -2.18], "note": "start=mouse rear port, end=pedestal rear-right socket plate; local to mouse-body pivot", "baseRadius": 0.012, "endRadius": 0.012};
  const endpoint_mouse_cable_16 = makeAttachmentEndpoint(attachment_mouse_cable_16);
  const node_mouse_cable_16 = new THREE.Group();
  node_mouse_cable_16.name = "Mouse cable__pivot";
  node_mouse_cable_16.scale.set(1, 1, 1);
  if (endpoint_mouse_cable_16) {
    node_mouse_cable_16.position.copy(endpoint_mouse_cable_16.start);
    node_mouse_cable_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mouse_cable_16.position.set(0.0, -0.03, 0.2);
    node_mouse_cable_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_mouse_cable_16.userData.sculptComponent = {"id": "mouse-cable", "name": "Mouse cable", "level": "meso", "role": "connector", "importance": 0.7, "confidence": 0.85, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Thin dark tube on gentle S-curve path from mouse rear to pedestal rear socket plate; TubeGeometry on CatmullRom path.", "geometryDescriptor": {"topologyIntent": "Thin dark tube on gentle S-curve path from mouse rear to pedestal rear socket plate; TubeGeometry on CatmullRom path.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mouse-body", "attachment": {"parentSocket": "mouse-rear-port", "contactType": "socket", "embedDepth": 0.015, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [0, 0.0, -0.21], "localEnd": [-0.15, -0.01, -2.18], "note": "start=mouse rear port, end=pedestal rear-right socket plate; local to mouse-body pivot", "baseRadius": 0.012, "endRadius": 0.012}, "dimensions": {"width": 0.7, "height": 0.03, "depth": 0.9, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, -0.03, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cable", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cable-dark", "materialLayers": ["cable-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cable-dark", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 28, 28, 1.0)", "secondaryAlbedo": "rgba(38, 38, 38, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_mouse_cable_16.userData.actionProfile = {"animationRole": "cable", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["mouse-body"] ?? root).add(node_mouse_cable_16);
  nodes["mouse-cable"] = node_mouse_cable_16;
  const mesh_mouse_cable_16Geometry = endpoint_mouse_cable_16
    ? new THREE.CylinderGeometry(endpoint_mouse_cable_16.endRadius, endpoint_mouse_cable_16.baseRadius, endpoint_mouse_cable_16.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  if (!endpoint_mouse_cable_16) {
    mesh_mouse_cable_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_mouse_cable_16 = new THREE.Mesh(
    mesh_mouse_cable_16Geometry,
    materialMap["cable-dark"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_mouse_cable_16.name = "Mouse cable";
  if (endpoint_mouse_cable_16) {
    mesh_mouse_cable_16.position.copy(endpoint_mouse_cable_16.midpoint);
    mesh_mouse_cable_16.quaternion.copy(endpoint_mouse_cable_16.quaternion);
  }
  mesh_mouse_cable_16.castShadow = options.castShadow ?? true;
  mesh_mouse_cable_16.receiveShadow = options.receiveShadow ?? true;
  mesh_mouse_cable_16.userData.sculptComponent = {"id": "mouse-cable", "name": "Mouse cable", "level": "meso", "role": "connector", "importance": 0.7, "confidence": 0.85, "primitive": "tube", "topologyClass": "fiber-strand", "topologyRationale": "Thin dark tube on gentle S-curve path from mouse rear to pedestal rear socket plate; TubeGeometry on CatmullRom path.", "geometryDescriptor": {"topologyIntent": "Thin dark tube on gentle S-curve path from mouse rear to pedestal rear socket plate; TubeGeometry on CatmullRom path.", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "mouse-body", "attachment": {"parentSocket": "mouse-rear-port", "contactType": "socket", "embedDepth": 0.015, "overlap": 0.0, "gapTolerance": 0.004, "localStart": [0, 0.0, -0.21], "localEnd": [-0.15, -0.01, -2.18], "note": "start=mouse rear port, end=pedestal rear-right socket plate; local to mouse-body pivot", "baseRadius": 0.012, "endRadius": 0.012}, "dimensions": {"width": 0.7, "height": 0.03, "depth": 0.9, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, -0.03, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "cable", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "cable-dark", "materialLayers": ["cable-dark"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "materialRef": "cable-dark", "colorMaterialRecipe": {"dominantAlbedo": "rgba(28, 28, 28, 1.0)", "secondaryAlbedo": "rgba(38, 38, 38, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.9, "evidenceRef": "full-object"}};
  node_mouse_cable_16.add(mesh_mouse_cable_16);
  meshes["mouse-cable"] = mesh_mouse_cable_16;
  colliders["mouse-cable"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_mouse_cable_16);
  // repetition system "kb-keys" describes 1 parts that are already built individually; not instanced.
  // repetition system "coil-turns" describes 1 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "balanced", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createMacintosh128KDesktopSetLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Macintosh 128K Desktop Set look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": "from upper-front-right", "intensity": 1.1, "color": "#FFFFFF", "evidence": "keycap top faces lighter than sides; soft shadows right of units"}, {"id": "fill", "type": "hemisphere/ambient", "intensity": 0.55, "color": "#F2F0EA", "evidence": "near-shadowless white-cyc studio look"}, {"id": "rim", "type": "directional", "direction": "from rear-left, low", "intensity": 0.25, "color": "#FFFFFF", "evidence": "subtle edge lift on shell left edges"}, {"id": "contact-shadow", "type": "contact-shadow", "behavior": "soft ground contact shadow under all three units and cable sag (ContactShadows-style radial gradient plane or soft shadow map)", "intensity": 0.35, "evidence": "soft diffuse shadows under units in all renders"}];
  lights.userData.lookDevTargets = {"qualityPriority": "balanced", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createMacintosh128KDesktopSetEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameMacintosh128KDesktopSetCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createMacintosh128KDesktopSetPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureMacintosh128KDesktopSetRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createMacintosh128KDesktopSetInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
