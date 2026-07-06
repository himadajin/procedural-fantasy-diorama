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

// --- 開口(窓・扉・屋根小窓)の造形(PHASE 4b commit 14) ---
/**
 * 開口の奥面の暗色(art-direction 5.1節 `#352c22`)。壁に穴は開けず、
 * 枠より奥まった暗色面でセットバックを読ませる(同 6節)。
 * 発光させない(窓明かりの emissive は使わない。発光は魔法専用)。
 */
const OPENING_COLOR = new THREE.Color("#352c22");
/** 扉板の沈み(木部 × 0.55。art-direction 5.1節) */
const DOOR_LEAF_SHADE = 0.55;
/** 枠の見付け(実寸) */
const FRAME_T = 0.13;
/** 窓の奥面のローカル z(枠前面 +0.5 より奥 = セットバックの読み) */
const OPENING_INSET_Z = 0.1;
/** 扉板のローカル z */
const DOOR_LEAF_Z = 0.16;
/** 石垣・ジェッティ帯の足元の焼き込み */
const FENCE_FOOT_AO = 0.85;
/** 屋根小窓の躯体(頬・前面)の沈み(勾配面より一段暗く) */
const DORMER_BODY_SHADE = 0.88;

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
 * 軸平行の小直方体(枠・段・笠などの部分形状)をローカル座標で押し込む。
 * shade は全頂点一律の明度係数。
 */
function subBox(
  buf: GeoBuffer,
  xf: (p: L) => W,
  base: THREE.Color,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  shade = 1,
): void {
  const inside = xf([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
  const s4 = [shade, shade, shade, shade];
  face(buf, xf, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], s4, inside, base);
  face(buf, xf, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], s4, inside, base);
  face(buf, xf, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], s4, inside, base);
  face(buf, xf, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], s4, inside, base);
  face(buf, xf, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], s4, inside, base);
  face(buf, xf, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], s4, inside, base);
}

/**
 * 開口(窓・扉): 壁面上の枠+枠より奥まった暗色面(壁に穴は開けない。
 * art-direction 6節のセットバック表現)。position は壁面上の開口下端中心、
 * ローカル +z が外向き法線(contracts/worldmodel.md 開口部品の変換規約)。
 * 枠は z −0.2〜+0.5 で壁へ半ば埋まり、奥面は枠より低い +z に置く。
 */
function openingPart(
  part: Part,
  buf: GeoBuffer,
  base: THREE.Color,
  kind: "window" | "door",
): void {
  const xf = makeXform(part);
  const [sx, sy] = part.transform.scale;
  const tx = Math.min(0.3, FRAME_T / Math.max(sx, 1e-6));
  const ty = Math.min(0.3, FRAME_T / Math.max(sy, 1e-6));
  // 枠: 左右+上(窓は下枠=窓台も)
  subBox(buf, xf, base, -0.5, -0.5 + tx, 0, 1, -0.2, 0.5);
  subBox(buf, xf, base, 0.5 - tx, 0.5, 0, 1, -0.2, 0.5);
  subBox(buf, xf, base, -0.5 + tx, 0.5 - tx, 1 - ty, 1, -0.2, 0.5);
  if (kind === "window") {
    subBox(buf, xf, base, -0.5 + tx, 0.5 - tx, 0, ty, -0.2, 0.5);
  }
  // 奥面(窓は開口の暗色固定、扉は木部を沈めた扉板。発光させない)
  const y0 = kind === "window" ? ty : 0;
  const z = kind === "window" ? OPENING_INSET_Z : DOOR_LEAF_Z;
  const inner =
    kind === "window" ? OPENING_COLOR : base.clone().multiplyScalar(DOOR_LEAF_SHADE);
  const inside = xf([0, 0.5, -0.5]);
  face(
    buf,
    xf,
    [[-0.5 + tx, y0, z], [0.5 - tx, y0, z], [0.5 - tx, 1 - ty, z], [-0.5 + tx, 1 - ty, z]],
    [1, 1, 1, 1],
    inside,
    inner,
  );
}

/** 煙突: 胴+笠(過大な冠)。頂面の焚き口は開口の暗色 */
function chimneyPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  subBox(buf, xf, base, -0.5, 0.5, 0, 0.88, -0.5, 0.5);
  subBox(buf, xf, base, -0.66, 0.66, 0.86, 1, -0.66, 0.66);
  face(
    buf,
    xf,
    [[-0.34, 1.002, -0.34], [0.34, 1.002, -0.34], [0.34, 1.002, 0.34], [-0.34, 1.002, 0.34]],
    [1, 1, 1, 1],
    xf([0, 0.5, 0]),
    OPENING_COLOR,
  );
}

/** 外階段: 踏面の直方体の段列(−z が壁側、+z へ降りる) */
function stairPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const n = Math.max(1, Math.round(part.params?.steps ?? 3));
  for (let i = 0; i < n; i++) {
    subBox(buf, xf, base, -0.5, 0.5, 0, (n - i) / n, -0.5 + i / n, -0.5 + (i + 1) / n);
  }
}

/**
 * 屋根の小窓(dormer): 小さな切妻箱+前面の暗色開口。屋根勾配面に
 * 背面を埋めて置く(交差部は貫通で処理。複合屋根と同じ流儀)。
 */
function dormerPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.4, 0]);
  const bt = 0.58; // 躯体天端(この上に小屋根)
  subBox(buf, xf, base, -0.5, 0.5, 0, bt, -0.5, 0.5, DORMER_BODY_SHADE);
  // 小屋根(棟はローカル z 方向 = 開口の外向き)
  const A: L = [-0.5, bt, -0.5];
  const B: L = [0.5, bt, -0.5];
  const C: L = [0.5, bt, 0.5];
  const D: L = [-0.5, bt, 0.5];
  const E: L = [0, 1, -0.5];
  const F: L = [0, 1, 0.5];
  face(buf, xf, [A, D, F, E], [1, 1, 1, 1], inside, base);
  face(buf, xf, [B, C, F, E], [1, 1, 1, 1], inside, base);
  face(buf, xf, [D, C, F], [1, 1, 1], inside, base);
  face(buf, xf, [A, B, E], [1, 1, 1], inside, base);
  // 前面の開口(枠+暗色の奥面)
  subBox(buf, xf, base, -0.38, -0.26, 0.06, 0.52, 0.5, 0.56);
  subBox(buf, xf, base, 0.26, 0.38, 0.06, 0.52, 0.5, 0.56);
  subBox(buf, xf, base, -0.26, 0.26, 0.42, 0.52, 0.5, 0.56);
  subBox(buf, xf, base, -0.26, 0.26, 0.06, 0.16, 0.5, 0.56);
  face(
    buf,
    xf,
    [[-0.26, 0.16, 0.515], [0.26, 0.16, 0.515], [0.26, 0.42, 0.515], [-0.26, 0.42, 0.515]],
    [1, 1, 1, 1],
    inside,
    OPENING_COLOR,
  );
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

/**
 * マージ経路の型ハンドラ(PHASE 5 以降もここへ追加登録する)。
 * PHASE 4b commit 14 の window / door / beam / chimney は commit 15 で
 * INSTANCED_TYPES へ移す(登録表の型キー単位で経路を切り替えられる。
 * それまでマージ束なのは正常なスコープ分割)。
 */
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
  // --- PHASE 4b commit 14: 開口・木組み・煙突・付属 ---
  window: (part, buf, base) => openingPart(part, buf, base, "window"),
  door: (part, buf, base) => openingPart(part, buf, base, "door"),
  beam: (part, buf, base) => boxPart(part, buf, base, 1),
  jetty: (part, buf, base) => boxPart(part, buf, base, FENCE_FOOT_AO),
  chimney: (part, buf, base) => chimneyPart(part, buf, base),
  fence: (part, buf, base) => boxPart(part, buf, base, FENCE_FOOT_AO),
  stair: (part, buf, base) => stairPart(part, buf, base),
  dormer: (part, buf, base) => dormerPart(part, buf, base),
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
