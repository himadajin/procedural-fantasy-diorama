/**
 * 植生メッシュビルダー: Vegetation(trees / shrubs / grassPatches)を
 * 専用の InstancedMesh 2 + マージ 1 で立体化する(PHASE 6 commit 20。
 * contracts/worldmodel.md Vegetation 節「植生の立体化」)。
 *
 * - `vegetation-trunks`: 幹の 6 角円錐台(castShadow: false)。色 #55452f
 * - `vegetation-canopy`: 不整形な塊のプール。樹冠(木ごとに 2〜3 個)と
 *   低木(1 個)を合流させる。主要 InstancedMesh として castShadow: true。
 *   instanceColor = 樹冠 #5f7a4a〜#45603c の colorVar 補間(低木 #6b7f52)
 *   × ±8% ムラ。塊ジオメトリの頂点カラーで下面を一段暗く焼き込む
 *   (下端 0.66 → 上端 1.0。art-direction 3節の頂点カラーAO)
 * - `vegetation-grass`: 草むらの低いドームのマージ 1 メッシュ
 * - 樹形は「幹+2〜3個の不整形な塊、やや大ぶり」(art-direction 6節)。
 *   broadleaf = 主塊+側塊 1〜2 / conifer = 縦積み 3 塊の先細り。
 *   個体差は tree フィールド+位置ハッシュ由来(乱数ストリーム非消費)
 * - 色は art-direction 5.3節。樹冠は明度階段の「屋根と壁の間」(同 2.2節)
 */
import * as THREE from "three";
import type { WorldModel } from "../model/worldmodel";
import { hash2 } from "./paving";

/** 幹・樹冠・低木・草むらの基準色(art-direction 5.3節) */
const TRUNK_COLOR = "#55452f";
const CANOPY_LIGHT = "#5f7a4a";
const CANOPY_DARK = "#45603c";
const SHRUB_COLOR = "#6b7f52";
const GRASS_COLOR = "#6b7f52";
/** 樹冠下面の焼き込みAO(下端 → 上端。art-direction 3節) */
const CANOPY_UNDER_AO = 0.66;
/** 個体の明度ムラ(±8%。art-direction 5.3節「±8%程度の明度ムラ」) */
const MOTTLE_AMP = 0.08;
/** 草むらのドーム高(縁 → 中心) */
const GRASS_EDGE_Y = 0.03;
const GRASS_CENTER_Y = 0.16;

/** 塊(樹冠・低木)1 個の配置。プレーンデータ(テストが直接検証できる) */
export interface CanopyLump {
  position: [number, number, number];
  rotation: number;
  scale: [number, number, number];
}

/** 位置ハッシュ(0〜1)。salt で同一 xz から複数の独立値を取る */
function vegHash(x: number, z: number, salt: number): number {
  return hash2(x * 1.37 + salt * 19.19, z * 1.37 - salt * 7.07);
}

/**
 * 樹木 1 本 → 塊 2〜3 個の展開(乱数ストリーム非消費・決定論的)。
 * broadleaf: 主塊+側塊 1〜2(頂部横並び・大ぶり)。
 * conifer: 縦積み 3 塊の先細り(尖ったシルエット)。
 */
export function treeLumps(tree: {
  position: { x: number; z: number };
  form: "conifer" | "broadleaf";
  scale: number;
  rotation: number;
}): CanopyLump[] {
  const { x, z } = tree.position;
  const s = tree.scale;
  const lumps: CanopyLump[] = [];
  if (tree.form === "conifer") {
    // 縦積み 3 塊(下ほど広く、上は尖る)
    const tiers: [number, number, number][] = [
      [3.0, 2.4, 1.1], // [幅係数, 高さ係数, 下端係数]
      [2.2, 2.1, 2.7],
      [1.3, 2.0, 4.3],
    ];
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      if (!t) continue;
      const w = t[0] * s * (0.92 + 0.16 * vegHash(x, z, i));
      lumps.push({
        position: [x, t[2] * s, z],
        rotation: tree.rotation + i * 1.7,
        scale: [w, t[1] * s, w],
      });
    }
  } else {
    // 主塊+側塊 1〜2(頂部横並び)
    const sideCount = vegHash(x, z, 9) < 0.6 ? 2 : 1;
    const mainW = 3.5 * s * (0.92 + 0.16 * vegHash(x, z, 0));
    lumps.push({
      position: [x, 2.0 * s, z],
      rotation: tree.rotation,
      scale: [mainW, 3.1 * s, mainW],
    });
    for (let i = 0; i < sideCount; i++) {
      const a = tree.rotation + (i === 0 ? 0.6 : 3.4) + vegHash(x, z, i + 3);
      const r = 1.25 * s;
      const w = 2.2 * s * (0.85 + 0.3 * vegHash(x, z, i + 5));
      lumps.push({
        position: [x + r * Math.cos(a), 1.6 * s, z - r * Math.sin(a)],
        rotation: tree.rotation + 2.1 * (i + 1),
        scale: [w, 2.2 * s, w],
      });
    }
  }
  return lumps;
}

/** 幹(円錐台)の寸法。conifer は低め(樹冠が覆う) */
export function trunkTransform(tree: {
  position: { x: number; z: number };
  form: "conifer" | "broadleaf";
  scale: number;
  rotation: number;
}): CanopyLump {
  const s = tree.scale;
  const h = (tree.form === "conifer" ? 2.0 : 2.8) * s;
  const w = 0.55 * s;
  return {
    position: [tree.position.x, 0, tree.position.z],
    rotation: tree.rotation,
    scale: [w, h, w],
  };
}

/**
 * 不整形な塊の単位形状(底面中心 y 0〜1)。頂部・赤道をずらした八面体系
 * (mesh/buildings.ts の浮石と同族の造形)で、フラット法線。
 * 頂点カラーで下面を一段暗く焼き込む(instanceColor と乗算で合成)。
 */
function canopyLumpGeometry(): THREE.BufferGeometry {
  const bottom: [number, number, number] = [0.05, 0, -0.03];
  const top: [number, number, number] = [-0.06, 1, 0.05];
  const ring: [number, number, number][] = [
    [-0.5, 0.42, -0.1],
    [-0.12, 0.5, -0.5],
    [0.42, 0.38, -0.16],
    [0.5, 0.46, 0.24],
    [-0.05, 0.44, 0.5],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const shadeAt = (y: number): number => {
    const t = Math.min(1, Math.max(0, y / 0.7));
    return CANOPY_UNDER_AO + (1 - CANOPY_UNDER_AO) * t * t * (3 - 2 * t);
  };
  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): void => {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    let v1 = b;
    let v2 = c;
    // 法線を塊の中心 (0, 0.5, 0) から外向きへ(巻き順も反転)
    if (nx * cx + ny * (cy - 0.5) + nz * cz < 0) {
      [v1, v2] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const v of [a, v1, v2]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(nx, ny, nz);
      const shade = shadeAt(v[1]);
      colors.push(shade, shade, shade);
    }
  };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] as [number, number, number];
    const b = ring[(i + 1) % ring.length] as [number, number, number];
    pushTri(a, b, top);
    pushTri(a, b, bottom);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  g.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(normals), 3),
  );
  g.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  return g;
}

/** 幹の単位形状: 6 角の円錐台(底面中心 y 0〜1、先細り 0.62) */
function trunkGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.31, 0.5, 1, 6);
  g.translate(0, 0.5, 0);
  return g;
}

/** インスタンス列(位置・回転・スケール・色) */
interface Instance {
  position: [number, number, number];
  rotation: number;
  scale: [number, number, number];
  color: THREE.Color;
}

/** ±8% の個体ムラを掛けた色 */
function mottled(base: THREE.Color, x: number, z: number, salt: number): THREE.Color {
  const m = 1 + MOTTLE_AMP * (vegHash(x, z, salt) * 2 - 1);
  return base.clone().multiplyScalar(m);
}

function buildInstancedMesh(
  instances: Instance[],
  geometry: THREE.BufferGeometry,
  name: string,
  castShadow: boolean,
  vertexColors: boolean,
): THREE.InstancedMesh | null {
  if (instances.length === 0) {
    geometry.dispose();
    return null;
  }
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ roughness: 1, vertexColors }),
    instances.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    if (!inst) continue;
    q.setFromAxisAngle(up, inst.rotation);
    pos.set(inst.position[0], inst.position[1], inst.position[2]);
    scl.set(inst.scale[0], inst.scale[1], inst.scale[2]);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, inst.color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** 草むら: polygon の扇形分割による低いドームのマージ 1 メッシュ */
function buildGrass(model: WorldModel): THREE.Mesh | null {
  const patches = model.vegetation.grassPatches;
  if (patches.length === 0) return null;
  const base = new THREE.Color(GRASS_COLOR);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (const patch of patches) {
    const poly = patch.polygon;
    if (poly.length < 3) continue;
    let cx = 0;
    let cz = 0;
    for (const p of poly) {
      cx += p.x;
      cz += p.z;
    }
    cx /= poly.length;
    cz /= poly.length;
    const centerIdx = positions.length / 3;
    const centerColor = mottled(base, cx, cz, 21).multiplyScalar(1.05);
    positions.push(cx, GRASS_CENTER_Y, cz);
    normals.push(0, 1, 0);
    colors.push(centerColor.r, centerColor.g, centerColor.b);
    const edgeStart = positions.length / 3;
    for (const p of poly) {
      const c = mottled(base, p.x, p.z, 22).multiplyScalar(0.94);
      positions.push(p.x, GRASS_EDGE_Y, p.z);
      normals.push(0, 1, 0);
      colors.push(c.r, c.g, c.b);
    }
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      // polygon は時計回り(Polygon 規約)なのでこの並びで法線 +y
      indices.push(centerIdx, edgeStart + i, edgeStart + j);
    }
  }
  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(normals), 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  mesh.name = "vegetation-grass";
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 植生一式のメッシュを構築する。
 * 戻り値: vegetation-trunks / vegetation-canopy / vegetation-grass の
 * うち存在するもの(draw call +3 以内)。
 */
export function buildVegetation(model: WorldModel): THREE.Object3D[] {
  const trunkBase = new THREE.Color(TRUNK_COLOR);
  const canopyLight = new THREE.Color(CANOPY_LIGHT);
  const canopyDark = new THREE.Color(CANOPY_DARK);
  const shrubBase = new THREE.Color(SHRUB_COLOR);

  const trunks: Instance[] = [];
  const lumps: Instance[] = [];
  for (const tree of model.vegetation.trees) {
    const { x, z } = tree.position;
    const trunk = trunkTransform(tree);
    trunks.push({ ...trunk, color: mottled(trunkBase, x, z, 30) });
    const canopyBase = canopyLight.clone().lerp(canopyDark, tree.colorVar);
    const treeLumpList = treeLumps(tree);
    for (let i = 0; i < treeLumpList.length; i++) {
      const lump = treeLumpList[i];
      if (!lump) continue;
      lumps.push({ ...lump, color: mottled(canopyBase, x, z, 40 + i) });
    }
  }
  for (const shrub of model.vegetation.shrubs) {
    const { x, z } = shrub.position;
    const w = 1.7 * shrub.scale * (0.9 + 0.2 * vegHash(x, z, 50));
    lumps.push({
      position: [x, 0, z],
      rotation: vegHash(x, z, 51) * Math.PI * 2,
      scale: [w, 1.0 * shrub.scale, w],
      color: mottled(shrubBase, x, z, 52),
    });
  }

  const out: THREE.Object3D[] = [];
  const trunkMesh = buildInstancedMesh(
    trunks,
    trunkGeometry(),
    "vegetation-trunks",
    false,
    false,
  );
  if (trunkMesh) out.push(trunkMesh);
  // 主要 InstancedMesh として影を落とす(implementation-spec 1.8節)
  const canopyMesh = buildInstancedMesh(
    lumps,
    canopyLumpGeometry(),
    "vegetation-canopy",
    true,
    true,
  );
  if (canopyMesh) out.push(canopyMesh);
  const grass = buildGrass(model);
  if (grass) out.push(grass);
  return out;
}
