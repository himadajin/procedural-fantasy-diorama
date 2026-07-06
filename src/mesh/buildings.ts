/**
 * 建物メッシュビルダー: Building.parts(「型+パラメータ」)を型ごとに
 * 一括処理する(implementation-spec 1.8節・9節、contracts/worldmodel.md
 * 「Part の型語彙」)。WorldModel のみを入力とする(contracts/pipeline.md)。
 *
 * - マージ経路(plinth / wall / gable / hip): マテリアル束(躯体/屋根)別の
 *   頂点カラー付き統合ジオメトリへ集約する(束ごとに 1 draw call)
 * - インスタンス経路(pile): 型ごとの InstancedMesh
 * - PHASE 4b 以降の部品型(窓・扉・梁・煙突など)は MERGE_HANDLERS /
 *   INSTANCED_TYPES へのハンドラ追加登録のみで加える(後付けの最適化に
 *   しない。同 9節)。未知の型は warn を出して読み飛ばす(生成は壊さない)
 * - 頂点カラー: 基準色(art-direction 5.1節)× 面ごとの ±8% 明度ムラ
 *   (位置ハッシュ由来。乱数ストリーム非消費)× 壁足元・基壇下端・軒裏の
 *   焼き込みAO(同 3節)
 * - 影: castShadow は統合ジオメトリ(躯体・屋根)に限定し、
 *   杭 InstancedMesh は受けるだけにする(1.8節の影キャスター規律)
 */
import * as THREE from "three";
import type { Building, Part, WorldModel } from "../model/worldmodel";

/**
 * materialId → 基準色(contracts/worldmodel.md「materialId の語彙」の正。
 * art-direction 5.1節と同期させる)。
 */
export const MATERIAL_COLORS: Record<string, string> = {
  stone: "#8e8a84",
  ashlar: "#a8a49b",
  plaster: "#d9cfbc",
  "rough-wood": "#6e5a44",
  wood: "#5d4a38",
  thatch: "#97855a",
  shingle: "#7a6a52",
  tile: "#a0563c",
  slate: "#5c6b7a",
};

/** 屋根系 materialId(「屋根」束へマージ。それ以外は「躯体」束) */
const ROOF_MATERIAL_IDS = new Set(["thatch", "shingle", "tile", "slate"]);

/** 明度ムラの振幅(±8%。art-direction 5.1節) */
const MOTTLE_AMP = 0.08;
/** 壁の足元(1階の下端)の焼き込みAO係数(art-direction 3節) */
const WALL_FOOT_AO = 0.74;
/** 上階の下端のごく弱い暗まり(階の継ぎ目を読ませる) */
const WALL_UPPER_AO = 0.94;
/** 基壇下端の焼き込み(5.1節「目地・下端の焼き込み」#6f6d6a ≒ 石×0.78) */
const PLINTH_FOOT_AO = 0.78;
/** 軒裏(屋根の底面)の沈み */
const ROOF_SOFFIT_SHADE = 0.7;
/** 杭の個体ムラ幅 */
const PILE_MOTTLE = 0.16;

/** 位置ハッシュ(0〜1)。乱数ストリームを消費しない決定論的なムラの元 */
function hash3(x: number, y: number, z: number): number {
  let h =
    (Math.imul(Math.round(x * 8) | 0, 0x9e3779b1) ^
      Math.imul(Math.round(y * 8) | 0, 0x85ebca77) ^
      Math.imul(Math.round(z * 8) | 0, 0xc2b2ae3d)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  h ^= h >>> 16;
  return h / 4294967296;
}

/** マージ用のジオメトリバッファ(マテリアル束ごと) */
interface GeoBuffer {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

/** ローカル点 */
type L = [number, number, number];
/** ワールド点 */
type W = [number, number, number];

/**
 * 部品の変換(contracts/worldmodel.md「Part の変換規約」):
 * ローカル [-0.5,0.5]×[0,1]×[-0.5,0.5] → scale → Y回転(three.js の
 * rotateY と同義: +x → (cosθ, 0, −sinθ))→ position(底面中心)。
 */
function makeXform(part: Part): (p: L) => W {
  const [px, py, pz] = part.transform.position;
  const [sx, sy, sz] = part.transform.scale;
  const cos = Math.cos(part.transform.rotation);
  const sin = Math.sin(part.transform.rotation);
  return ([lx, ly, lz]: L): W => {
    const x = lx * sx;
    const z = lz * sz;
    return [px + x * cos + z * sin, py + ly * sy, pz - x * sin + z * cos];
  };
}

/**
 * 面(三角形または四角形)をバッファへ押し込む。
 * 法線は面のワールド頂点から算出し、solid の内部点 inside から外向きに
 * 揃える(巻き順も合わせる)。shades は頂点ごとの明度係数(色 = base ×
 * 面ムラ × shade)。連続する同一頂点(hip の縮退)は間引く。
 */
function pushFace(
  buf: GeoBuffer,
  verts: W[],
  shades: number[],
  inside: W,
  base: THREE.Color,
  mottle: number,
): void {
  // 縮退頂点の除去
  const vs: W[] = [];
  const sh: number[] = [];
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    if (!v) continue;
    const prev = vs[vs.length - 1];
    if (prev && Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]) < 1e-6) {
      continue;
    }
    vs.push(v);
    sh.push(shades[i] ?? 1);
  }
  if (vs.length < 3) return;

  const [a, b, c] = [vs[0], vs[1], vs[2]] as [W, W, W];
  let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return;
  nx /= len;
  ny /= len;
  nz /= len;
  // 内部点から外向きへ(内向きなら巻き順と法線を反転)
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of vs) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  cx /= vs.length;
  cy /= vs.length;
  cz /= vs.length;
  const outwardDot =
    nx * (cx - inside[0]) + ny * (cy - inside[1]) + nz * (cz - inside[2]);
  if (outwardDot < 0) {
    vs.reverse();
    sh.reverse();
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  const start = buf.positions.length / 3;
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i];
    if (!v) continue;
    buf.positions.push(v[0], v[1], v[2]);
    buf.normals.push(nx, ny, nz);
    const s = mottle * (sh[i] ?? 1);
    buf.colors.push(base.r * s, base.g * s, base.b * s);
  }
  for (let i = 1; i + 1 < vs.length; i++) {
    buf.indices.push(start, start + i, start + i + 1);
  }
}

/** 面ムラ(±8%): 面の中心の位置ハッシュから */
function faceMottle(verts: W[]): number {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const v of verts) {
    cx += v[0];
    cy += v[1];
    cz += v[2];
  }
  const n = Math.max(1, verts.length);
  return 1 + MOTTLE_AMP * (hash3(cx / n, cy / n, cz / n) * 2 - 1);
}

/** 面の押し込み(面ムラ算出込み)のショートハンド */
function face(
  buf: GeoBuffer,
  xf: (p: L) => W,
  locals: L[],
  shades: number[],
  inside: W,
  base: THREE.Color,
): void {
  const verts = locals.map(xf);
  pushFace(buf, verts, shades, inside, base, faceMottle(verts));
}

/**
 * 直方体(plinth / wall)。footAo は下端頂点の焼き込み係数
 * (壁足元・基壇下端の頂点カラーAO。art-direction 3節)。
 */
function boxPart(
  part: Part,
  buf: GeoBuffer,
  base: THREE.Color,
  footAo: number,
): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.5, 0]);
  const bottomShades = [footAo, footAo, 1, 1];
  // 側面 4 面(下端 2 頂点 → footAo、上端 2 頂点 → 1)
  face(buf, xf, [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]], bottomShades, inside, base);
  face(buf, xf, [[0.5, 0, -0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5]], bottomShades, inside, base);
  face(buf, xf, [[0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [0.5, 1, 0.5]], bottomShades, inside, base);
  face(buf, xf, [[-0.5, 0, 0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [-0.5, 1, 0.5]], bottomShades, inside, base);
  // 天面・底面
  face(buf, xf, [[-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]], [1, 1, 1, 1], inside, base);
  const fa = footAo * 0.9;
  face(buf, xf, [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]], [fa, fa, fa, fa], inside, base);
}

/**
 * 切妻(gable)/ 寄棟(hip)の閉じた屋根ソリッド。
 * 棟はローカル +x 軸・y=1。hip は棟が両端からスパン/2 ずつ縮み、
 * 妻側も同じ勾配で流れる(contracts/worldmodel.md「Part の型語彙」)。
 */
function roofPart(part: Part, buf: GeoBuffer, base: THREE.Color, hip: boolean): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.35, 0]);
  const [sx, , sz] = part.transform.scale;
  // 寄棟の棟の縮み(ローカル単位)。妻側の勾配面がスパン側と同じ勾配になる量
  const r = hip ? Math.max(0, 0.5 - sz / 2 / Math.max(sx, 1e-9)) : 0.5;
  const A: L = [-0.5, 0, -0.5];
  const B: L = [0.5, 0, -0.5];
  const C: L = [0.5, 0, 0.5];
  const D: L = [-0.5, 0, 0.5];
  const E: L = [-r, 1, 0];
  const F: L = [r, 1, 0];
  const s4 = [1, 1, 1, 1];
  // 勾配面 2
  face(buf, xf, [A, B, F, E], s4, inside, base);
  face(buf, xf, [D, C, F, E], s4, inside, base);
  // 妻(gable は垂直の三角、hip は勾配の三角)
  face(buf, xf, [B, C, F], [1, 1, 1], inside, base);
  face(buf, xf, [A, D, E], [1, 1, 1], inside, base);
  // 軒裏(底面)は沈める
  const soff = [ROOF_SOFFIT_SHADE, ROOF_SOFFIT_SHADE, ROOF_SOFFIT_SHADE, ROOF_SOFFIT_SHADE];
  face(buf, xf, [A, B, C, D], soff, inside, base);
}

/** マージ経路の型ハンドラ(4b 以降はここへ追加登録する) */
const MERGE_HANDLERS: Record<
  string,
  (part: Part, buf: GeoBuffer, base: THREE.Color) => void
> = {
  plinth: (part, buf, base) => boxPart(part, buf, base, PLINTH_FOOT_AO),
  wall: (part, buf, base) =>
    boxPart(
      part,
      buf,
      base,
      (part.params?.floor ?? 0) === 0 ? WALL_FOOT_AO : WALL_UPPER_AO,
    ),
  gable: (part, buf, base) => roofPart(part, buf, base, false),
  hip: (part, buf, base) => roofPart(part, buf, base, true),
};

/** インスタンス経路の型(4b 以降はここへ追加登録する) */
const INSTANCED_TYPES: Record<
  string,
  { name: string; makeGeometry: () => THREE.BufferGeometry; castShadow: boolean }
> = {
  pile: {
    name: "building-piles",
    makeGeometry: () => {
      const g = new THREE.BoxGeometry(1, 1, 1);
      g.translate(0, 0.5, 0); // 原点=底面中心(Part の変換規約と一致)
      return g;
    },
    // 影のキャスターは統合ジオメトリに限定(implementation-spec 1.8節)
    castShadow: false,
  },
};

function buildGeoBuffer(buf: GeoBuffer): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(buf.positions), 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(buf.colors), 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(buf.normals), 3),
  );
  geometry.setIndex(buf.indices);
  return geometry;
}

function materialColor(id: string): THREE.Color {
  const hex = MATERIAL_COLORS[id];
  // 未知の materialId は石にフォールバック(語彙違反は warn 済み扱いにしない
  // ため、ここでは黙って規律内の色に収める)
  return new THREE.Color(hex ?? MATERIAL_COLORS.stone);
}

/**
 * 建物一式のメッシュを構築する。
 * 戻り値: 躯体マージ 1 + 屋根マージ 1 + 型ごとの InstancedMesh(存在する
 * もののみ)。draw call は建物全体で 3 前後に収まる(1.8節の予算)。
 */
export function buildBuildings(model: WorldModel): THREE.Object3D[] {
  const solid: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const roof: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const instanceParts = new Map<string, Part[]>();
  let unknown = 0;

  for (const building of model.buildings as Building[]) {
    for (const part of building.parts) {
      const handler = MERGE_HANDLERS[part.type];
      if (handler) {
        const buf = ROOF_MATERIAL_IDS.has(part.materialId) ? roof : solid;
        handler(part, buf, materialColor(part.materialId));
        continue;
      }
      if (INSTANCED_TYPES[part.type]) {
        let list = instanceParts.get(part.type);
        if (!list) {
          list = [];
          instanceParts.set(part.type, list);
        }
        list.push(part);
        continue;
      }
      unknown++;
    }
  }
  if (unknown > 0) {
    console.warn(`mesh/buildings: 未知の部品型 ${unknown} 件を読み飛ばした`);
  }

  const out: THREE.Object3D[] = [];
  const addMerged = (buf: GeoBuffer, name: string, roughness: number): void => {
    if (buf.indices.length === 0) return;
    const mesh = new THREE.Mesh(
      buildGeoBuffer(buf),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness }),
    );
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  };
  addMerged(solid, "buildings-solid", 1);
  addMerged(roof, "buildings-roof", 0.92);

  // インスタンス経路(型ごとに 1 InstancedMesh)
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  for (const [type, parts] of instanceParts) {
    const def = INSTANCED_TYPES[type];
    if (!def || parts.length === 0) continue;
    const mesh = new THREE.InstancedMesh(
      def.makeGeometry(),
      new THREE.MeshStandardMaterial({ roughness: 0.95 }),
      parts.length,
    );
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const [px, py, pz] = part.transform.position;
      const [sx, sy, sz] = part.transform.scale;
      q.setFromAxisAngle(up, part.transform.rotation);
      m.compose(
        new THREE.Vector3(px, py, pz),
        q,
        new THREE.Vector3(sx, sy, sz),
      );
      mesh.setMatrixAt(i, m);
      // 個体の明度ムラ(位置ハッシュ。乱数非消費)
      const mottle = 1 + PILE_MOTTLE * (hash3(px, py, pz) - 0.5);
      color.copy(materialColor(part.materialId)).multiplyScalar(mottle);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = def.name;
    mesh.castShadow = def.castShadow;
    mesh.receiveShadow = true;
    out.push(mesh);
  }
  return out;
}
