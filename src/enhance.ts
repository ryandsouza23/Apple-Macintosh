import * as THREE from 'three';

// Structural hand modules for systems the spec documents but the generated
// factory cannot express (see object-sculpt-spec.json repetitionSystems):
//  - kb-keys: staggered key grid (the generator only instances radially)
//  - coil-turns: helix wound along a sagging spine (attachment endpoints emit rods)
// All parameters mirror the spec; the spec remains the authority.

const KEY_UNIT = 0.0966; // key-field width 1.40 / 14.5 units
const KEY_GAP = 0.009;
const KEY_HEIGHT = 0.05;
const KEY_TOP_SCALE = 0.68;

// M0110-style rows, widths in key units. 58 caps total.
const ROWS: { widths: number[]; legends: string[] }[] = [
  {
    widths: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
    legends: ['~', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace'],
  },
  {
    widths: [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    legends: ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'],
  },
  {
    widths: [1.75, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.75],
    legends: ['Caps Lock', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter'],
  },
  {
    widths: [2.25, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.25],
    legends: ['Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'Shift'],
  },
  {
    widths: [1.5, 1.25, 9, 1.25, 1.5],
    legends: ['Ctrl', 'Alt', '', 'Alt', 'Ctrl'],
  },
];

export type KeycapInfo = { legend: string; mesh: THREE.Mesh };

function keycapGeometry(w: number, d: number): THREE.BufferGeometry {
  // truncated pyramid: base w x d, top scaled, flat shading
  const geo = new THREE.BoxGeometry(w, KEY_HEIGHT, d, 1, 1, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // absolute-clamped taper so wide caps (space bar) keep near-parallel sides
  const insetX = Math.min(((1 - KEY_TOP_SCALE) / 2) * w, 0.013);
  const insetZ = Math.min(((1 - KEY_TOP_SCALE) / 2) * d, 0.013);
  for (let i = 0; i < pos.count; i += 1) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) - Math.sign(pos.getX(i)) * insetX);
      pos.setZ(i, pos.getZ(i) - Math.sign(pos.getZ(i)) * insetZ);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildKeyField(material: THREE.Material): {
  group: THREE.Group;
  keys: KeycapInfo[];
} {
  const group = new THREE.Group();
  group.name = 'key-grid';
  const keys: KeycapInfo[] = [];
  const totalUnits = 14.5;
  const fieldW = totalUnits * KEY_UNIT;
  const rowDepth = KEY_UNIT;
  const fieldD = ROWS.length * rowDepth;
  ROWS.forEach((row, r) => {
    let xUnits = 0;
    const z = -fieldD / 2 + rowDepth * (r + 0.5);
    const y = (ROWS.length - 1 - r) * 0.004; // slight rearward rise
    row.widths.forEach((wu, i) => {
      const w = wu * KEY_UNIT - KEY_GAP;
      const d = rowDepth - KEY_GAP;
      const cx = (xUnits + wu / 2) * KEY_UNIT - fieldW / 2;
      const mesh = new THREE.Mesh(keycapGeometry(w, d), material);
      mesh.position.set(cx, y + KEY_HEIGHT / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `key-${r}-${i}`;
      mesh.userData.legend = row.legends[i];
      mesh.userData.explodeWithParent = true;
      group.add(mesh);
      keys.push({ legend: row.legends[i], mesh });
      xUnits += wu;
    });
  });
  return { group, keys };
}

function sagSpine(start: THREE.Vector3, end: THREE.Vector3, sag: number): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const t = i / 8;
    const p = start.clone().lerp(end, t);
    p.y -= sag * Math.sin(Math.PI * t);
    pts.push(p);
  }
  return new THREE.CatmullRomCurve3(pts);
}

export function buildCoilCable(
  start: THREE.Vector3,
  end: THREE.Vector3,
  material: THREE.Material,
): THREE.Mesh {
  // 20 helix turns wound around a sagging spine (spec: repetitionSystems.coil-turns)
  const lead = 0.05;
  const dir = end.clone().sub(start).normalize();
  const coilStart = start.clone().addScaledVector(dir, lead);
  const coilEnd = end.clone().addScaledVector(dir, -lead);
  const spine = sagSpine(coilStart, coilEnd, 0.09);
  const turns = 20;
  const coilR = 0.026;
  const tubeR = 0.0095;
  const samples = turns * 14;
  const pts: THREE.Vector3[] = [start.clone()];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const p = spine.getPointAt(t);
    const tan = spine.getTangentAt(t);
    const side = new THREE.Vector3().crossVectors(tan, up).normalize();
    const norm = new THREE.Vector3().crossVectors(side, tan).normalize();
    const ang = t * turns * Math.PI * 2;
    p.addScaledVector(side, Math.cos(ang) * coilR);
    p.addScaledVector(norm, Math.sin(ang) * coilR);
    pts.push(p);
  }
  pts.push(end.clone());
  const curve = new THREE.CatmullRomCurve3(pts);
  const geo = new THREE.TubeGeometry(curve, samples * 2, tubeR, 8, false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.name = 'Coiled keyboard cable';
  return mesh;
}

export function buildMouseCable(
  start: THREE.Vector3,
  end: THREE.Vector3,
  material: THREE.Material,
): THREE.Mesh {
  // thin cable arcing on the desk from mouse rear around the chassis side
  const mid1 = new THREE.Vector3(
    start.x + 0.30,
    0.02,
    THREE.MathUtils.lerp(start.z, end.z, 0.3),
  );
  const mid2 = new THREE.Vector3(
    end.x + 0.45,
    0.03,
    THREE.MathUtils.lerp(start.z, end.z, 0.72),
  );
  const curve = new THREE.CatmullRomCurve3([start, mid1, mid2, end]);
  const geo = new THREE.TubeGeometry(curve, 120, 0.0085, 8, false);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.name = 'Mouse cable';
  return mesh;
}

// --- form-refinement profiles (side profiles in (z, y), extruded along X) ---

/** Path with each corner filleted (radius clamped to half of the adjacent edges). */
function roundedPath(pts: [number, number][], r: number): THREE.Shape {
  const shape = new THREE.Shape();
  const n = pts.length;
  const v = (i: number) => new THREE.Vector2(pts[(i + n) % n][0], pts[(i + n) % n][1]);
  for (let i = 0; i < n; i += 1) {
    const prev = v(i - 1);
    const cur = v(i);
    const next = v(i + 1);
    const inLen = cur.distanceTo(prev);
    const outLen = cur.distanceTo(next);
    const rr = Math.min(r, inLen / 2.5, outLen / 2.5);
    const a = cur.clone().add(prev.clone().sub(cur).setLength(rr));
    const b = cur.clone().add(next.clone().sub(cur).setLength(rr));
    if (i === 0) shape.moveTo(a.x, a.y);
    else shape.lineTo(a.x, a.y);
    shape.quadraticCurveTo(cur.x, cur.y, b.x, b.y);
  }
  shape.closePath();
  return shape;
}

function sideProfileGeometry(
  pts: [number, number][],
  width: number,
  fillet = 0,
  edgeBevel = 0,
): THREE.BufferGeometry {
  const shape = fillet > 0 ? roundedPath(pts, fillet) : new THREE.Shape();
  if (fillet <= 0) {
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i][0], pts[i][1]);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: edgeBevel > 0,
    bevelThickness: edgeBevel,
    bevelSize: edgeBevel,
    bevelOffset: -edgeBevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  // profile plane is (z, y); extrusion axis becomes X after this rotation
  geo.rotateY(-Math.PI / 2);
  geo.translate(width / 2 - (edgeBevel > 0 ? edgeBevel : 0), 0, 0);
  geo.computeVertexNormals();
  return geo;
}

/** Rebuild the fascia from its spec profile with a molded-plastic bevel: soft outer
 *  edges and a sloped lip running around the bezel/floppy/knob openings. */
function refineFasciaGeometry(mesh: THREE.Mesh): void {
  const comp = mesh.userData.sculptComponent as {
    geometryDescriptor?: { profile2D?: { points: [number, number][]; depth: number; holes?: [number, number][][] } };
  };
  const profile = comp?.geometryDescriptor?.profile2D;
  if (!profile) return;
  const bev = 0.014;
  const shape = roundedPath(profile.points, 0.02);
  for (const loop of profile.holes ?? []) {
    const hole = roundedPath(loop, 0.02);
    shape.holes.push(hole);
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth - bev * 2,
    bevelEnabled: true,
    bevelThickness: bev,
    bevelSize: bev,
    bevelOffset: -bev,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geo.translate(0, 0, bev);
  geo.computeVertexNormals();
  mesh.geometry.dispose();
  mesh.geometry = geo;
}

function refineShellGeometry(mesh: THREE.Mesh): void {
  // rear-top chamfer into the carry step (dimensions from spec: 0.98 x 1.13 x 0.88)
  const h = 1.13 / 2;
  const d = 0.88 / 2;
  const geo = sideProfileGeometry(
    [
      [d, -h],
      [d, h],
      [-d + 0.20, h],
      [-d + 0.10, h - 0.11],
      [-d, h - 0.11],
      [-d, -h],
    ],
    0.98,
    0.025,
    0.012,
  );
  mesh.geometry.dispose();
  mesh.geometry = geo;
}

function refineTrayGeometry(mesh: THREE.Mesh): void {
  // wedge tray: thin front lip rising to rear (spec kb-tray 1.55 x 0.06 x 0.66)
  const d = 0.66 / 2;
  const geo = sideProfileGeometry(
    [
      [d, -0.03],
      [d, 0.012],
      [-d, 0.038],
      [-d, -0.03],
    ],
    1.55,
    0.01,
    0.008,
  );
  mesh.geometry.dispose();
  mesh.geometry = geo;
}

function refineMouseGeometry(mesh: THREE.Mesh): void {
  // chamfered nose: front-top slope toward the button (spec mouse-body 0.28 x 0.14 x 0.42)
  const d = 0.42 / 2;
  const h = 0.14 / 2;
  const geo = sideProfileGeometry(
    [
      [d, -h],
      [d, h - 0.02],
      [d - 0.04, h],
      [-d + 0.16, h],
      [-d, h - 0.045],
      [-d, -h],
    ],
    0.28,
    0.012,
    0.01,
  );
  mesh.geometry.dispose();
  mesh.geometry = geo;
}

// --- surface pass: legend atlas + micro details ---

function buildLegendAtlas(): { canvas: HTMLCanvasElement; cell: (i: number) => [number, number] } {
  const COLS = 16;
  const ROWS_A = 4;
  const CELL = 96;
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL;
  canvas.height = ROWS_A * CELL;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8a8578';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#c9c5b9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let i = 0;
  const positions: [number, number][] = [];
  for (const row of ROWS) {
    for (const legend of row.legends) {
      const cx = (i % COLS) * CELL + CELL / 2;
      const cy = Math.floor(i / COLS) * CELL + CELL / 2;
      positions.push([i % COLS, Math.floor(i / COLS)]);
      const small = legend.length > 2;
      let size = small ? 26 : 50;
      ctx.font = `${size}px 'Helvetica Neue', sans-serif`;
      const maxW = CELL - 14;
      const w = ctx.measureText(legend).width;
      if (w > maxW) {
        size = Math.floor((size * maxW) / w);
        ctx.font = `${size}px 'Helvetica Neue', sans-serif`;
      }
      ctx.fillText(legend, cx, cy);
      i += 1;
    }
  }
  return { canvas, cell: (idx: number) => positions[idx] };
}

export function applyKeyLegends(keys: KeycapInfo[]): void {
  const { canvas, cell } = buildLegendAtlas();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0 });
  const COLS = 16;
  const ROWS_A = 4;
  keys.forEach((k, idx) => {
    const [cx, cy] = cell(idx);
    const geo = k.mesh.geometry as THREE.BufferGeometry;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    // BoxGeometry(…,1,1,1) vertex layout: 4 verts per face in group order
    // +x, -x, +y, -y, +z, -z — the top (+y) face is vertices 8..11. Top face
    // gets the cell (with its centered legend); every other face samples a
    // uniform-color corner of the same cell.
    for (let i = 0; i < uv.count; i += 1) {
      if (i >= 8 && i <= 11) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        uv.setXY(i, (cx + u) / COLS, 1 - (cy + 1 - v) / ROWS_A);
      } else {
        uv.setXY(i, (cx + 0.03) / COLS, 1 - (cy + 0.03) / ROWS_A);
      }
    }
    uv.needsUpdate = true;
    k.mesh.material = mat;
  });
}

/** Six-stripe rainbow Apple mark drawn procedurally: stripes clipped by an
 *  apple silhouette (body with notch + bite cut out, leaf on top). */
function appleLogoTexture(): THREE.CanvasTexture {
  const size = 256;
  const shape = document.createElement('canvas');
  shape.width = size;
  shape.height = size;
  const g = shape.getContext('2d')!;
  // body
  g.fillStyle = '#000';
  g.beginPath();
  g.moveTo(128, 78);
  g.bezierCurveTo(104, 54, 58, 62, 42, 102);
  g.bezierCurveTo(22, 152, 50, 218, 88, 236);
  g.bezierCurveTo(106, 245, 116, 238, 128, 238);
  g.bezierCurveTo(140, 238, 150, 245, 168, 236);
  g.bezierCurveTo(206, 218, 234, 152, 214, 102);
  g.bezierCurveTo(198, 62, 152, 54, 128, 78);
  g.closePath();
  g.fill();
  // top notch + bite
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.ellipse(128, 62, 24, 26, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(232, 128, 42, 0, Math.PI * 2);
  g.fill();
  // leaf
  g.globalCompositeOperation = 'source-over';
  g.save();
  g.translate(148, 44);
  g.rotate(-0.6);
  g.beginPath();
  g.ellipse(0, 0, 26, 12, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const colors = ['#61bb46', '#fdb827', '#f5821f', '#e03a3e', '#963d97', '#009ddc'];
  const top = 24;
  const bottom = 240;
  const band = (bottom - top) / colors.length;
  colors.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(0, top + i * band, size, band + 1);
  });
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(shape, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function addStripePlate(
  parent: THREE.Object3D,
  size: [number, number, number],
  pos: [number, number, number],
  color: number,
  name: string,
): void {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0 }),
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.name = name;
  mesh.userData.explodeWithParent = true;
  parent.add(mesh);
}

export function applyMicroSurface(runtime: {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
}): void {
  const { nodes, meshes } = runtime;
  // badge stripes: lower-left rear quarter of the shell's left side (ref-side-left)
  const shell = nodes['root'];
  if (shell) {
    for (let i = 0; i < 3; i += 1) {
      addStripePlate(
        shell,
        [0.004, 0.012, 0.09],
        [-0.492, -0.42 + i * 0.032, -0.30],
        0x6e6b64,
        `badge-stripe-${i}`,
      );
    }
  }
  // pedestal rear vents
  const ped = nodes['pedestal'];
  if (ped) {
    for (let i = 0; i < 6; i += 1) {
      addStripePlate(
        ped,
        [0.09, 0.01, 0.004],
        [-0.30 + i * 0.12, 0.0, -0.552],
        0x2a2a28,
        `rear-vent-${i}`,
      );
    }
  }
  // rainbow Apple badge directly on the flat fascia (no recess)
  const fascia = nodes['front-fascia'];
  if (fascia) {
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(0.075, 0.084),
      new THREE.MeshBasicMaterial({
        map: appleLogoTexture(),
        transparent: true,
        toneMapped: false,
      }),
    );
    decal.position.set(-0.3, -0.345, 0.102);
    decal.name = 'apple-badge-decal';
    decal.userData.explodeWithParent = true;
    fascia.add(decal);
  }
  // mouse details: recessed button well rim, flush emblem, grey base band
  const mouse = nodes['mouse-body'];
  if (mouse) {
    // well rim under the button plate, slope-aligned (slope normal (0,0.963,-0.271))
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(0.21, 0.006, 0.138),
      new THREE.MeshStandardMaterial({ color: 0x7e7a6e, roughness: 0.55, metalness: 0 }),
    );
    rim.position.set(0, 0.0482, -0.1385);
    rim.rotation.x = -0.274;
    rim.name = 'mouse-button-well';
    rim.userData.explodeWithParent = true;
    mouse.add(rim);
    // flush square emblem, darker so it reads as an inset
    addStripePlate(mouse, [0.036, 0.004, 0.036], [0, 0.0685, 0.07], 0x8f8b80, 'mouse-badge');
    // grey base band like the reference's lower shell
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.284, 0.032, 0.424),
      new THREE.MeshStandardMaterial({ color: 0x8d897e, roughness: 0.6, metalness: 0 }),
    );
    base.position.set(0, -0.054, 0);
    base.name = 'mouse-base-shell';
    base.userData.explodeWithParent = true;
    mouse.add(base);
  }
}

export function applyScreenCanvas(
  screenMesh: THREE.Mesh,
  canvas: HTMLCanvasElement,
): THREE.CanvasTexture {
  // live 1-bit Finder canvas on the CRT face (material-pass: screen-1bit identity finish)
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  const face = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const rim = new THREE.MeshStandardMaterial({ color: 0x1a1a18, roughness: 0.5 });
  // BoxGeometry group order: +x, -x, +y, -y, +z (front), -z
  screenMesh.material = [rim, rim, rim, rim, face, rim];
  // The panel overhangs the bezel opening (0.90x0.74 panel vs 0.84x0.68 opening) so its
  // edges hide behind the fascia. Remap UVs so the visible opening spans the full canvas;
  // the hidden border clamps to edge pixels.
  const mx = 0.03 / 0.90;
  const my = 0.03 / 0.74;
  const uv = screenMesh.geometry.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i += 1) {
    uv.setXY(i, -mx + uv.getX(i) * (1 + 2 * mx), -my + uv.getY(i) * (1 + 2 * my));
  }
  uv.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function enhanceMacModel(root: THREE.Group): { keys: KeycapInfo[] } {
  root.updateMatrixWorld(true);
  const runtime = root.userData.sculptRuntime as {
    nodes: Record<string, THREE.Object3D>;
    meshes: Record<string, THREE.Mesh>;
  };
  const { nodes, meshes } = runtime;
  let keys: KeycapInfo[] = [];

  // --- form-refinement geometry replacements (profiles documented in spec assumptions) ---
  if (meshes['root']) refineShellGeometry(meshes['root']);
  if (meshes['front-fascia']) refineFasciaGeometry(meshes['front-fascia']);
  if (meshes['kb-tray']) refineTrayGeometry(meshes['kb-tray']);
  if (meshes['mouse-body']) refineMouseGeometry(meshes['mouse-body']);
  // rear step mass merges visually with the chamfered shell
  if (meshes['shell-rear-step']) {
    meshes['shell-rear-step'].position.y -= 0.0;
  }

  // --- key grid replaces the key-field slab ---
  const keyFieldMesh = meshes['key-field'];
  if (keyFieldMesh) {
    const mat = keyFieldMesh.material as THREE.Material;
    const built = buildKeyField(mat);
    keys = built.keys;
    const pivot = nodes['key-field'];
    // the placeholder slab becomes the dark well floor visible in the cap gaps
    keyFieldMesh.material = new THREE.MeshStandardMaterial({
      color: 0x3f3d38,
      roughness: 0.65,
      metalness: 0,
    });
    keyFieldMesh.scale.y = 0.4;
    keyFieldMesh.scale.z = 0.92;
    keyFieldMesh.scale.x = 0.995;
    keyFieldMesh.position.y = -0.03;
    pivot.add(built.group);
    built.group.position.y = 0.002; // caps ride proud of the tray surface
  }

  // --- real cables replace attachment rods ---
  const toRoot = (obj: THREE.Object3D, local: THREE.Vector3): THREE.Vector3 => {
    const w = local.clone();
    obj.localToWorld(w);
    return root.worldToLocal(w);
  };
  const cableMat =
    (meshes['kb-cable']?.material as THREE.Material) ??
    new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.4 });

  const kbNode = nodes['kb-tray'];
  const pedNode = nodes['pedestal'];
  if (kbNode && pedNode && meshes['kb-cable']) {
    meshes['kb-cable'].visible = false;
    const start = toRoot(kbNode, new THREE.Vector3(-0.62, 0.01, -0.345));
    const end = toRoot(pedNode, new THREE.Vector3(-0.12, 0.0, 0.56));
    root.add(buildCoilCable(start, end, cableMat));
  }
  const mouseNode = nodes['mouse-body'];
  if (mouseNode && pedNode && meshes['mouse-cable']) {
    meshes['mouse-cable'].visible = false;
    const start = toRoot(mouseNode, new THREE.Vector3(0, -0.02, -0.215));
    const end = toRoot(pedNode, new THREE.Vector3(0.30, 0.0, -0.56));
    root.add(buildMouseCable(start, end, cableMat));
  }

  // --- surface pass: legends + micro details ---
  applyKeyLegends(keys);
  applyMicroSurface(runtime);

  return { keys };
}
