/**
 * 建物メッシュビルダー: Building.parts(「型+パラメータ」)を型ごとに
 * 一括処理する(implementation-spec 1.8節・9節、contracts/buildings.md
 * 「Part の型語彙」)。WorldModel のみを入力とする(contracts/pipeline.md)。
 *
 * - マージ経路(plinth / wall / gable / hip / jetty / fence / stair /
 *   dormer / deck): マテリアル束(躯体/屋根)別の頂点カラー付き統合
 *   ジオメトリへ集約する(束ごとに 1 draw call)
 * - インスタンス経路(pile / window / door / beam / chimney):
 *   型ごとのハンドラが部品を共有プールのピース(軸平行の箱・+z 向きの面)へ
 *   分解し、`building-trim`(箱)/ `building-openings`(面)/
 *   `building-piles`(杭)の InstancedMesh へ集約する
 *   (contracts/buildings.md「インスタンス経路のピース分解」)。
 *   経路の切替は MERGE_HANDLERS / INSTANCED_TYPES の型キー単位の登録移動
 *   のみで行える。未知の型は warn を出して読み飛ばす(生成は壊さない)
 * - 頂点カラー / instanceColor: 基準色(art-direction 5.1節)× ±8% 明度ムラ
 *   (位置ハッシュ由来。乱数ストリーム非消費)× 壁足元・基壇下端・軒裏の
 *   焼き込みAO(同 3節)。インスタンスは基準色×個体ムラを instanceColor に
 *   持ち、形状・寸法はマージ展開と同一(経路変更で絵を変えない)
 * - 影: castShadow は統合ジオメトリ(躯体・屋根)と主要 InstancedMesh
 *   (building-trim)に限定する(1.8節の影キャスター規律)
 * - 発光束: crystal / sigil / glow-window の発光面は
 *   独立の小さなマージ束 `buildings-glow` 1 つに集約する(draw call +1)。
 *   emissive #5fd4c0 / emissiveIntensity 2.0、明滅 ±0.3 はビューワーの
 *   時間 uniform(水面と共有)で行い、reduced-motion では静止する
 *   (contracts/buildings.md「中心建築の拡張文法」の追加語彙、
 *   art-direction 5.4節)。Bloom・動的光源は使わない
 * - 結界構造: mesh/wardparts.ts の展開結果
 *   (ward-wall / arch / ward-stone と再利用部品)を同じ束へ合流させる。
 *   境界標・立石は専用プールの InstancedMesh `ward-stones` 1 つ
 *   (contracts/wards.md「結界構造の立体化」)
 * - 魔法灯・浮遊要素・橋: 灯の柱(lamp-post)は
 *   building-trim プールへ、橋(mesh/bridgeparts.ts)は既存の束へ合流。
 *   火屋+浮遊水晶は発光の共有 InstancedMesh `ward-glow-crystals`、
 *   浮石は `ward-floatstones`(draw call +2)。上下動・明滅は
 *   ビューワーの時間 uniform+id ハッシュ位相で、reduced-motion では
 *   静止する(contracts/wards.md「魔法灯・浮遊要素・橋の立体化」)
 */
import * as THREE from "three";
import type { Building, Part, WorldModel } from "../model/worldmodel";
import { expandWardParts, type FloatInstance } from "./wardparts";
import { expandBridgeParts } from "./bridgeparts";

/** ビューワーが毎フレーム更新する時間 uniform(mesh/build.ts と共有の形) */
export interface TimeUniform {
  value: number;
}

/**
 * materialId → 基準色(contracts/materials.md「materialId の語彙」の正。
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
  // --- 施設(art-direction 5.5節) ---
  "tilled-soil": "#63513e",
  meadow: "#94a166",
  canvas: "#c9b48e",
  "awning-madder": "#8f6350",
  "awning-slate": "#6b7a8c",
  void: "#352c22",
  "wet-wood": "#4a3c2e",
};

/** 屋根系 materialId(「屋根」束へマージ。それ以外は「躯体」束) */
export const ROOF_MATERIAL_IDS = new Set(["thatch", "shingle", "tile", "slate"]);

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

// --- 開口(窓・扉・屋根小窓)の造形 ---
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

// --- 発光束(art-direction 5.4節の数値規範) ---
/** 発光面のベース(拡散)色。夕光の加算で濁らせない暗色に固定 */
const GLOW_BASE_COLOR = "#2a3a38";
/** 発光コア(emissive)の色 */
const GLOW_EMISSIVE_COLOR = "#5fd4c0";
/** 発光強度の基準(明滅 ±0.3 はシェーダーの時間 uniform で行う) */
const GLOW_EMISSIVE_INTENSITY = 2.0;
/** 発光の重み: コア(水晶・発光開口)1.0 / 紋様・縁 0.35(実効 0.7 ≒ 0.6〜0.8 帯) */
const GLOW_CORE_WEIGHT = 1.0;
const GLOW_EDGE_WEIGHT = 0.35;
/** 中庭壁の笠より下の壁体の暗まり */
const COURTYARD_BODY_SHADE = 0.97;

// --- 遠距離 LOD(contracts/pipeline.md
//     「描画プリセット・LOD・デバッグ表示」) ---
/**
 * 小部品(building-trim / building-openings)のフェード帯
 * (ワールド一辺比のカメラ距離)。初期構図の距離(一辺×0.75。
 * art-direction 8節)では減衰しない(署名の絵を変えない)。
 * プリセット非依存で常に有効。
 */
const LOD_FADE_START_RATIO = 1.15;
const LOD_FADE_END_RATIO = 1.5;

/**
 * カメラ距離によるディザ(alphaHash)の減衰をマテリアルへ付ける。
 * 透明ソートなしでポッピングを見せずに小部品を消す(遠距離 LOD)。
 */
function applyDistanceFade(
  material: THREE.MeshStandardMaterial,
  worldSize: number,
): void {
  material.alphaHash = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer);
    shader.uniforms.uFadeStart = { value: worldSize * LOD_FADE_START_RATIO };
    shader.uniforms.uFadeEnd = { value: worldSize * LOD_FADE_END_RATIO };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uFadeStart;\nuniform float uFadeEnd;",
      )
      .replace(
        "#include <alphahash_fragment>",
        `diffuseColor.a *= 1.0 - smoothstep(uFadeStart, uFadeEnd, length(vViewPosition));
        #include <alphahash_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "pfd-lod-fade";
}

/** 位置ハッシュ(0〜1)。乱数ストリームを消費しない決定論的なムラの元 */
export function hash3(x: number, y: number, z: number): number {
  let h =
    (Math.imul(Math.round(x * 8) | 0, 0x9e3779b1) ^
      Math.imul(Math.round(y * 8) | 0, 0x85ebca77) ^
      Math.imul(Math.round(z * 8) | 0, 0xc2b2ae3d)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  // XOR は符号付き 32bit を返すため必ず符号なしへ戻す(0〜1 の契約)
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** マージ用のジオメトリバッファ(マテリアル束ごと) */
export interface GeoBuffer {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

/** ローカル点 */
export type L = [number, number, number];
/** ワールド点 */
export type W = [number, number, number];

/**
 * 部品の変換(contracts/buildings.md「Part の変換規約」):
 * ローカル [-0.5,0.5]×[0,1]×[-0.5,0.5] → scale → Y回転(three.js の
 * rotateY と同義: +x → (cosθ, 0, −sinθ))→ position(底面中心)。
 */
export function makeXform(part: Part): (p: L) => W {
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
export function face(
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
export function boxPart(
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

// --- インスタンス経路のピース分解
//     (contracts/buildings.md「インスタンス経路のピース分解」) ---

/** 共有プールへ積むピース(色は基準色×個体ムラを掛けた最終値) */
interface Piece {
  position: W;
  rotation: number;
  scale: [number, number, number];
  color: THREE.Color;
}

/** インスタンス経路の共有プール */
interface InstancePools {
  /** 単位箱 [-0.5,0.5]×[0,1]×[-0.5,0.5](building-trim) */
  boxes: Piece[];
  /** +z 向きの単位面 [-0.5,0.5]×[0,1](building-openings) */
  planes: Piece[];
  /** 杭(building-piles。従来どおり部品 1 つ = 1 インスタンス) */
  piles: Piece[];
  /** 境界標・立石(ward-stones。部品 1 つ = 1 インスタンス) */
  stones: Piece[];
}

/** ピース中心の位置ハッシュによる ±8% の個体ムラ(faceMottle と同係数) */
function pieceColor(base: THREE.Color, center: W): THREE.Color {
  const mottle =
    1 + MOTTLE_AMP * (hash3(center[0], center[1], center[2]) * 2 - 1);
  return base.clone().multiplyScalar(mottle);
}

/**
 * 部品ローカルの軸平行の箱 [x0,x1]×[y0,y1]×[z0,z1] を箱ピースとして積む。
 * ワールド形状はマージ経路の subBox / boxPart と同一になる
 * (makeXform と同じ変換をピースのトランスフォームへ畳み込む)。
 */
function boxPiece(
  pools: InstancePools,
  part: Part,
  color: THREE.Color,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  const xf = makeXform(part);
  const [sx, sy, sz] = part.transform.scale;
  pools.boxes.push({
    position: xf([(x0 + x1) / 2, y0, (z0 + z1) / 2]),
    rotation: part.transform.rotation,
    scale: [(x1 - x0) * sx, (y1 - y0) * sy, (z1 - z0) * sz],
    color: pieceColor(color, xf([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2])),
  });
}

/** 部品ローカルの +z 向きの矩形(z 固定)を面ピースとして積む */
function planePiece(
  pools: InstancePools,
  part: Part,
  color: THREE.Color,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z: number,
): void {
  const xf = makeXform(part);
  const [sx, sy] = part.transform.scale;
  pools.planes.push({
    position: xf([(x0 + x1) / 2, y0, z]),
    rotation: part.transform.rotation,
    scale: [(x1 - x0) * sx, (y1 - y0) * sy, 1],
    color: pieceColor(color, xf([(x0 + x1) / 2, (y0 + y1) / 2, z])),
  });
}

/**
 * 開口(窓・扉): 壁面上の枠+枠より奥まった暗色面(壁に穴は開けない。
 * art-direction 6節のセットバック表現)。position は壁面上の開口下端中心、
 * ローカル +z が外向き法線(contracts/buildings.md 開口部品の変換規約)。
 * 枠は z −0.2〜+0.5 で壁へ半ば埋まり、奥面は枠より低い +z に置く。
 * 枠の見付け(FRAME_T)は部品寸法からピース生成時に計算するため実寸固定。
 */
function openingPieces(
  pools: InstancePools,
  part: Part,
  base: THREE.Color,
  kind: "window" | "door",
): void {
  const [sx, sy] = part.transform.scale;
  const tx = Math.min(0.3, FRAME_T / Math.max(sx, 1e-6));
  const ty = Math.min(0.3, FRAME_T / Math.max(sy, 1e-6));
  // 枠: 左右+上(窓は下枠=窓台も)
  boxPiece(pools, part, base, -0.5, -0.5 + tx, 0, 1, -0.2, 0.5);
  boxPiece(pools, part, base, 0.5 - tx, 0.5, 0, 1, -0.2, 0.5);
  boxPiece(pools, part, base, -0.5 + tx, 0.5 - tx, 1 - ty, 1, -0.2, 0.5);
  if (kind === "window") {
    boxPiece(pools, part, base, -0.5 + tx, 0.5 - tx, 0, ty, -0.2, 0.5);
  }
  // 奥面(窓は開口の暗色固定、扉は木部を沈めた扉板。発光させない)
  const y0 = kind === "window" ? ty : 0;
  const z = kind === "window" ? OPENING_INSET_Z : DOOR_LEAF_Z;
  const inner =
    kind === "window" ? OPENING_COLOR : base.clone().multiplyScalar(DOOR_LEAF_SHADE);
  planePiece(pools, part, inner, -0.5 + tx, 0.5 - tx, y0, 1 - ty, z);
}

/**
 * 開口(窓・扉)のマージ経路版: `openingPieces`(インスタンス経路)と同じ
 * 枠寸法・奥面の色/沈み(FRAME_T・OPENING_INSET_Z・DOOR_LEAF_Z・
 * OPENING_COLOR・DOOR_LEAF_SHADE)を、共有プールでなくマージバッファへ
 * 直接描く(subBox / face は boxPart 等の他のマージ形状と同じ押し込み経路
 * のため、ワールド形状は openingPieces と同一になる)。呼び出し元は
 * mesh/facilities.ts(施設の door / window。施設はインスタンス経路の
 * 共有プールを持たないためマージへ寄せる)。
 */
export function openingPart(
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
  const y1 = 1 - ty;
  const z = kind === "window" ? OPENING_INSET_Z : DOOR_LEAF_Z;
  const inner =
    kind === "window" ? OPENING_COLOR : base.clone().multiplyScalar(DOOR_LEAF_SHADE);
  const inside = xf([0, (y0 + y1) / 2, z - 0.5]);
  face(
    buf,
    xf,
    [
      [-0.5 + tx, y0, z],
      [0.5 - tx, y0, z],
      [0.5 - tx, y1, z],
      [-0.5 + tx, y1, z],
    ],
    [1, 1, 1, 1],
    inside,
    inner,
  );
}

/** 煙突: 胴+笠(過大な冠)+頂部の焚き口(開口の暗色の薄箱) */
function chimneyPieces(pools: InstancePools, part: Part, base: THREE.Color): void {
  boxPiece(pools, part, base, -0.5, 0.5, 0, 0.88, -0.5, 0.5);
  boxPiece(pools, part, base, -0.66, 0.66, 0.86, 1, -0.66, 0.66);
  // 頂面の暗色(マージ経路の y=1.002 の面と同等。笠へ薄く埋めた箱で表す)
  boxPiece(pools, part, OPENING_COLOR, -0.34, 0.34, 0.996, 1.004, -0.34, 0.34);
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
 * 妻側も同じ勾配で流れる(contracts/buildings.md「Part の型語彙」)。
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

// --- 中心建築の部品(contracts/buildings.md
//     「中心建築の拡張文法」の追加語彙) ---

/** 塔身: 先細りの角柱(上端の辺長 = 底辺 × taper)+天端面 */
function towerPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.5, 0]);
  const t = Math.min(1, Math.max(0.3, part.params?.taper ?? 0.85));
  const h = t * 0.5;
  const bs = [WALL_FOOT_AO, WALL_FOOT_AO, 1, 1];
  face(buf, xf, [[-0.5, 0, -0.5], [0.5, 0, -0.5], [h, 1, -h], [-h, 1, -h]], bs, inside, base);
  face(buf, xf, [[0.5, 0, -0.5], [0.5, 0, 0.5], [h, 1, h], [h, 1, -h]], bs, inside, base);
  face(buf, xf, [[0.5, 0, 0.5], [-0.5, 0, 0.5], [-h, 1, h], [h, 1, h]], bs, inside, base);
  face(buf, xf, [[-0.5, 0, 0.5], [-0.5, 0, -0.5], [-h, 1, -h], [-h, 1, h]], bs, inside, base);
  face(buf, xf, [[-h, 1, -h], [h, 1, -h], [h, 1, h], [-h, 1, h]], [1, 1, 1, 1], inside, base);
}

/** 尖塔屋根: 四角錐+軒裏 */
function spirePart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.25, 0]);
  const A: L = [-0.5, 0, -0.5];
  const B: L = [0.5, 0, -0.5];
  const C: L = [0.5, 0, 0.5];
  const D: L = [-0.5, 0, 0.5];
  const E: L = [0, 1, 0];
  face(buf, xf, [A, B, E], [1, 1, 1], inside, base);
  face(buf, xf, [B, C, E], [1, 1, 1], inside, base);
  face(buf, xf, [C, D, E], [1, 1, 1], inside, base);
  face(buf, xf, [D, A, E], [1, 1, 1], inside, base);
  const soff = [ROOF_SOFFIT_SHADE, ROOF_SOFFIT_SHADE, ROOF_SOFFIT_SHADE, ROOF_SOFFIT_SHADE];
  face(buf, xf, [A, B, C, D], soff, inside, base);
}

/** 中庭壁: 壁体(内側へ絞る)+笠 */
function courtyardWallPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  subBox(buf, xf, base, -0.5, 0.5, 0, 0.88, -0.38, 0.38, COURTYARD_BODY_SHADE);
  subBox(buf, xf, base, -0.5, 0.5, 0.88, 1, -0.5, 0.5);
}

// --- 結界構造(contracts/buildings.md 結界構造の追加語彙、
//     contracts/wards.md「結界構造の立体化」) ---

/** 結界壁の基部高・頂縁高・張り出し(実寸固定。scale から逆算する) */
const WARD_WALL_BASE_H = 0.42;
const WARD_WALL_RIM_H = 0.3;
const WARD_WALL_BASE_EXTRA = 0.17;
const WARD_WALL_RIM_EXTRA = 0.15;
/** 基部・壁体の沈み(足元AOと同族の焼き込み) */
const WARD_WALL_BASE_SHADE = 0.84;
const WARD_WALL_BODY_SHADE = 0.97;

/**
 * 結界壁セグメント: 基部+壁体+頂縁(胸壁・狭間なし=非軍事)。
 * scale = 長さ×高さ×厚み(壁体)。基部・頂縁は実寸固定で厚みへ張り出す。
 */
function wardWallPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const [, sy, sz] = part.transform.scale;
  const bh = Math.min(0.35, WARD_WALL_BASE_H / Math.max(sy, 1e-6));
  const rh = Math.min(0.2, WARD_WALL_RIM_H / Math.max(sy, 1e-6));
  const eb = WARD_WALL_BASE_EXTRA / Math.max(sz, 1e-6);
  const er = WARD_WALL_RIM_EXTRA / Math.max(sz, 1e-6);
  subBox(buf, xf, base, -0.5, 0.5, 0, bh, -0.5 - eb, 0.5 + eb, WARD_WALL_BASE_SHADE);
  subBox(buf, xf, base, -0.5, 0.5, bh, 1 - rh, -0.5, 0.5, WARD_WALL_BODY_SHADE);
  subBox(buf, xf, base, -0.5, 0.5, 1 - rh, 1, -0.5 - er, 0.5 + er);
}

/**
 * アーチ開口を持つ門躯体(両脚+アーチ頭+開口ソフィット)。開口はローカル
 * z 方向へ貫通する。scale = スパン×全高×厚み。params.open = 開口幅/スパン、
 * params.rise = 開口天端高/全高。アーチの縦半径はワールドで半円に近づくよう
 * scale から決める(結界門。橋と共用できる汎用形状)。
 */
function archPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const [sx, sy] = part.transform.scale;
  const open = Math.min(0.92, Math.max(0.1, part.params?.open ?? 0.55));
  const rise = Math.min(0.95, Math.max(0.2, part.params?.rise ?? 0.75));
  const hw = open / 2;
  // 縦半径(ローカル)。ワールドで半円 = (hw·sx)/sy。天端が潰れない範囲へ
  const ry = Math.min((hw * sx) / Math.max(sy, 1e-6), rise * 0.55);
  const ys = rise - ry; // アーチの起拱点
  // 両脚(y 0〜rise)と頭部の帯(y rise〜1)
  subBox(buf, xf, base, -0.5, -hw, 0, rise, -0.5, 0.5, 0.94);
  subBox(buf, xf, base, hw, 0.5, 0, rise, -0.5, 0.5, 0.94);
  subBox(buf, xf, base, -0.5, 0.5, rise, 1, -0.5, 0.5);
  // アーチ曲線(起拱点 → 天端 → 起拱点)
  const m = 8;
  const arc: [number, number][] = [];
  for (let j = 0; j <= m; j++) {
    const t = (j / m) * Math.PI;
    arc.push([-hw * Math.cos(t), ys + ry * Math.sin(t)]);
  }
  const insideMid = xf([0, (rise + 1) / 2, 0]);
  for (let j = 0; j < m; j++) {
    const p0 = arc[j];
    const p1 = arc[j + 1];
    if (!p0 || !p1) continue;
    // 前面・背面のスパンドレル(アーチと天端ラインの間の帯)
    for (const zf of [0.5, -0.5]) {
      const inside = xf([(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 - 0.05, 0]);
      pushFace(
        buf,
        [
          xf([p0[0], p0[1], zf]),
          xf([p1[0], p1[1], zf]),
          xf([p1[0], rise, zf]),
          xf([p0[0], rise, zf]),
        ],
        [1, 1, 1, 1],
        inside,
        base,
        faceMottle([xf([p0[0], p0[1], zf]), xf([p1[0], rise, zf])]),
      );
    }
    // 開口ソフィット(アーチ裏。上方の内部点から離れる=下向き)
    pushFace(
      buf,
      [
        xf([p0[0], p0[1], 0.5]),
        xf([p1[0], p1[1], 0.5]),
        xf([p1[0], p1[1], -0.5]),
        xf([p0[0], p0[1], -0.5]),
      ],
      [0.8, 0.8, 0.8, 0.8],
      insideMid,
      base,
      1,
    );
  }
  // 開口脚の内側面(起拱点まで)は脚の subBox が持つ(重複させない)
}

/** 発光の重み色(頂点カラー = 発光束の emissive・拡散の両方に乗る) */
function glowWeightColor(weight: number): THREE.Color {
  return new THREE.Color(weight, weight, weight);
}

/**
 * 頂部水晶: 八面体(全面が発光コア)。発光束へ集約する。
 * 位置ハッシュのムラは使わない(発光の重みを正確に保つ)。
 */
function crystalPart(part: Part, glow: GeoBuffer): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.45, 0]);
  const eq = 0.42; // 赤道(最大断面)の高さ
  const bottom: L = [0, 0, 0];
  const top: L = [0, 1, 0];
  const ring: L[] = [
    [-0.5, eq, 0],
    [0, eq, -0.5],
    [0.5, eq, 0],
    [0, eq, 0.5],
  ];
  const w = glowWeightColor(GLOW_CORE_WEIGHT);
  for (let i = 0; i < 4; i++) {
    const a = ring[i] as L;
    const b = ring[(i + 1) % 4] as L;
    const verts = [a, b, top].map(xf);
    pushFace(glow, verts, [1, 1, 1], inside, w, 1);
    const verts2 = [a, b, bottom].map(xf);
    pushFace(glow, verts2, [1, 1, 1], inside, w, 1);
  }
}

/**
 * 結界紋様の発光帯: 壁面上の薄い面(縁の弱い光)。
 * params.tilt は面内回転(菱形紋の合成用。ローカル矩形の中心まわり)。
 */
function sigilPart(part: Part, glow: GeoBuffer): void {
  const xf = makeXform(part);
  const tilt = part.params?.tilt ?? 0;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const rot = (x: number, y: number): L => {
    const dx = x;
    const dy = y - 0.5;
    return [dx * cosT - dy * sinT, 0.5 + dx * sinT + dy * cosT, 0];
  };
  const verts = [rot(-0.5, 0), rot(0.5, 0), rot(0.5, 1), rot(-0.5, 1)].map(xf);
  const inside = xf([0, 0.5, -1]);
  pushFace(glow, verts, [1, 1, 1, 1], inside, glowWeightColor(GLOW_EDGE_WEIGHT), 1);
}

/** 開口枠の 2D 輪郭(x, y)。z は framedOpening が付ける */
type P2 = [number, number];

/**
 * 枠付き開口の汎用形状: 外輪郭と内輪郭の間の枠(前面+外周の返し)、
 * 内輪郭の奥面(暗色または発光面)、奥面までのリベール(見込み)を張る。
 * 開口部品の変換規約(枠 z −0.2〜+0.5、奥面は枠より低い +z)に従う。
 */
function framedOpening(
  solid: GeoBuffer,
  xf: (p: L) => W,
  base: THREE.Color,
  outer: P2[],
  inner: P2[],
  innerFace: { buf: GeoBuffer; color: THREE.Color; mottle: number },
): void {
  const zf = 0.5; // 枠の前面
  const zd = OPENING_INSET_Z; // 奥面
  const zb = -0.2; // 枠の背(壁へ埋まる側)
  const n = outer.length;
  let icx = 0;
  let icy = 0;
  for (const [x, y] of inner) {
    icx += x;
    icy += y;
  }
  icx /= inner.length;
  icy /= inner.length;
  const axisFront = xf([icx, icy, -1]); // 開口の奥(壁の中)
  // 奥面
  const faceVerts = inner.map(([x, y]) => xf([x, y, zd]));
  pushFace(
    innerFace.buf,
    faceVerts,
    inner.map(() => 1),
    axisFront,
    innerFace.color,
    innerFace.mottle,
  );
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o0 = outer[i] as P2;
    const o1 = outer[j] as P2;
    const i0 = inner[i] as P2;
    const i1 = inner[j] as P2;
    // 枠の前面(外輪郭 ↔ 内輪郭)
    pushFace(
      solid,
      [xf([o0[0], o0[1], zf]), xf([o1[0], o1[1], zf]), xf([i1[0], i1[1], zf]), xf([i0[0], i0[1], zf])],
      [1, 1, 1, 1],
      axisFront,
      base,
      1,
    );
    // リベール(内輪郭に沿って奥面 → 前面)。法線は開口の中心軸を向く
    const mid = xf([(i0[0] + i1[0]) / 2, (i0[1] + i1[1]) / 2, (zd + zf) / 2]);
    const axis = xf([icx, icy, (zd + zf) / 2]);
    const away: W = [mid[0] * 2 - axis[0], mid[1] * 2 - axis[1], mid[2] * 2 - axis[2]];
    pushFace(
      solid,
      [xf([i0[0], i0[1], zd]), xf([i1[0], i1[1], zd]), xf([i1[0], i1[1], zf]), xf([i0[0], i0[1], zf])],
      [0.82, 0.82, 0.82, 0.82],
      away,
      base,
      1,
    );
    // 枠の外周の返し(壁へ埋まる側 → 前面)。法線は中心軸から外向き
    const oaxis = xf([icx, icy, zf / 2]);
    pushFace(
      solid,
      [xf([o0[0], o0[1], zb]), xf([o1[0], o1[1], zb]), xf([o1[0], o1[1], zf]), xf([o0[0], o0[1], zf])],
      [1, 1, 1, 1],
      oaxis,
      base,
      1,
    );
  }
}

/** 正 n 角形の輪郭(中心 (cx, cy)、半径 r) */
function ngon(cx: number, cy: number, r: number, n: number): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** 矩形の輪郭(枠の見付け t を内側へ取るときは inset に渡す) */
function rectOutline(inset: number, insetY: number): P2[] {
  return [
    [-0.5 + inset, insetY],
    [0.5 - inset, insetY],
    [0.5 - inset, 1 - insetY],
    [-0.5 + inset, 1 - insetY],
  ];
}

/** 発光開口: 枠(躯体)+発光面(発光束)。開口部品の変換規約に従う */
function glowWindowPart(
  part: Part,
  solid: GeoBuffer,
  glow: GeoBuffer,
  base: THREE.Color,
): void {
  const xf = makeXform(part);
  const [sx, sy] = part.transform.scale;
  const tx = Math.min(0.3, FRAME_T / Math.max(sx, 1e-6));
  const ty = Math.min(0.3, FRAME_T / Math.max(sy, 1e-6));
  framedOpening(solid, xf, base, rectOutline(0, 0), rectOutline(tx, ty), {
    buf: glow,
    color: glowWeightColor(GLOW_CORE_WEIGHT),
    mottle: 1,
  });
}

/** 薔薇窓風: 16角形の枠+スポーク+暗色奥面(非発光) */
function roseWindowPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  framedOpening(buf, xf, base, ngon(0, 0.5, 0.5, 16), ngon(0, 0.5, 0.36, 16), {
    buf,
    color: OPENING_COLOR,
    mottle: 1,
  });
  // スポーク(車輪の桟): 中心のハブ+十字・斜めの細い桟
  const zs = OPENING_INSET_Z + 0.06;
  const inside = xf([0, 0.5, -1]);
  const spoke = (angle: number): void => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const r = 0.36;
    const w = 0.035;
    const verts = [
      xf([-c * r - s * w, 0.5 - s * r + c * w, zs]),
      xf([-c * r + s * w, 0.5 - s * r - c * w, zs]),
      xf([c * r + s * w, 0.5 + s * r - c * w, zs]),
      xf([c * r - s * w, 0.5 + s * r + c * w, zs]),
    ];
    pushFace(buf, verts, [1, 1, 1, 1], inside, base, 1);
  };
  spoke(0);
  spoke(Math.PI / 4);
  spoke(Math.PI / 2);
  spoke((3 * Math.PI) / 4);
  const hub = ngon(0, 0.5, 0.09, 8).map(([x, y]) => xf([x, y, zs + 0.02]));
  pushFace(buf, hub, ngon(0, 0.5, 0.09, 8).map(() => 1), inside, base, 1);
}

/** 尖頭窓風: 五角形(尖りアーチ)の枠+暗色奥面(非発光) */
function archWindowPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const outer: P2[] = [
    [-0.5, 0],
    [0.5, 0],
    [0.5, 0.72],
    [0, 1],
    [-0.5, 0.72],
  ];
  const inner: P2[] = [
    [-0.36, 0.04],
    [0.36, 0.04],
    [0.36, 0.66],
    [0, 0.88],
    [-0.36, 0.66],
  ];
  framedOpening(buf, xf, base, outer, inner, {
    buf,
    color: OPENING_COLOR,
    mottle: 1,
  });
}

/**
 * マージ経路の型ハンドラ(新しい部品型はここへ追加登録する)。
 * 経路の切替は MERGE_HANDLERS / INSTANCED_TYPES の型キー単位の登録移動で
 * 行う。
 */
export const MERGE_HANDLERS: Record<
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
  // --- 付属(ジェッティ・石垣・外階段・屋根小窓) ---
  jetty: (part, buf, base) => boxPart(part, buf, base, FENCE_FOOT_AO),
  fence: (part, buf, base) => boxPart(part, buf, base, FENCE_FOOT_AO),
  stair: (part, buf, base) => stairPart(part, buf, base),
  dormer: (part, buf, base) => dormerPart(part, buf, base),
  // --- 中心建築(塔・尖塔・中庭壁・大型開口) ---
  tower: (part, buf, base) => towerPart(part, buf, base),
  spire: (part, buf, base) => spirePart(part, buf, base),
  "courtyard-wall": (part, buf, base) => courtyardWallPart(part, buf, base),
  "rose-window": (part, buf, base) => roseWindowPart(part, buf, base),
  "arch-window": (part, buf, base) => archWindowPart(part, buf, base),
  // --- 結界構造(結界壁・結界門のアーチ) ---
  "ward-wall": (part, buf, base) => wardWallPart(part, buf, base),
  arch: (part, buf, base) => archPart(part, buf, base),
  // --- 水辺建築の拡張(杭支持デッキの床板) ---
  deck: (part, buf, base) => boxPart(part, buf, base, FENCE_FOOT_AO),
};

/**
 * 発光束の型ハンドラ。crystal / sigil は発光束のみ、
 * glow-window は枠を躯体束へ・発光面を発光束へ振り分ける。
 */
const GLOW_HANDLERS: Record<
  string,
  (part: Part, solid: GeoBuffer, glow: GeoBuffer, base: THREE.Color) => void
> = {
  crystal: (part, _solid, glow) => crystalPart(part, glow),
  sigil: (part, _solid, glow) => sigilPart(part, glow),
  "glow-window": (part, solid, glow, base) =>
    glowWindowPart(part, solid, glow, base),
};

/**
 * インスタンス経路の型ハンドラ(部品を共有プールのピースへ分解する。
 * 新しい部品型はここへ追加登録する)。
 */
const INSTANCED_TYPES: Record<
  string,
  (part: Part, base: THREE.Color, pools: InstancePools) => void
> = {
  pile: (part, base, pools) => {
    const [px, py, pz] = part.transform.position;
    // 個体の明度ムラ(位置ハッシュ。乱数非消費)
    const mottle = 1 + PILE_MOTTLE * (hash3(px, py, pz) - 0.5);
    pools.piles.push({
      position: [px, py, pz],
      rotation: part.transform.rotation,
      scale: [...part.transform.scale],
      color: base.clone().multiplyScalar(mottle),
    });
  },
  // --- 開口・梁・煙突のインスタンス化 ---
  window: (part, base, pools) => openingPieces(pools, part, base, "window"),
  door: (part, base, pools) => openingPieces(pools, part, base, "door"),
  beam: (part, base, pools) =>
    boxPiece(pools, part, base, -0.5, 0.5, 0, 1, -0.5, 0.5),
  chimney: (part, base, pools) => chimneyPieces(pools, part, base),
  // --- 境界標・立石(専用プール ward-stones) ---
  "ward-stone": (part, base, pools) => {
    const [px, py, pz] = part.transform.position;
    pools.stones.push({
      position: [px, py, pz],
      rotation: part.transform.rotation,
      scale: [...part.transform.scale],
      color: pieceColor(base, [px, py + part.transform.scale[1] / 2, pz]),
    });
  },
  // --- 魔法灯の柱(柱身+足元+天板のピース分解。
  //     火屋は部品ではなく ward-glow-crystals のインスタンス) ---
  "lamp-post": (part, base, pools) => {
    const [sx, sy] = part.transform.scale;
    // 柱身
    boxPiece(pools, part, base, -0.5, 0.5, 0, 1, -0.5, 0.5);
    // 足元の座(実寸固定 0.3 角 × 高さ 0.12)
    const fx = 0.15 / Math.max(sx, 1e-6);
    const fh = 0.12 / Math.max(sy, 1e-6);
    boxPiece(pools, part, base, -fx, fx, 0, fh, -fx, fx);
    // 天板(実寸固定 0.36 角 × 厚み 0.07。火屋がこの上に浮く)
    const cx = 0.18 / Math.max(sx, 1e-6);
    const ch = 0.07 / Math.max(sy, 1e-6);
    boxPiece(pools, part, base, -cx, cx, 1, 1 + ch, -cx, cx);
  },
};

export function buildGeoBuffer(buf: GeoBuffer): THREE.BufferGeometry {
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

export function materialColor(id: string): THREE.Color {
  const hex = MATERIAL_COLORS[id];
  // 未知の materialId は石にフォールバック(語彙違反は warn 済み扱いにしない
  // ため、ここでは黙って規律内の色に収める)
  return new THREE.Color(hex ?? MATERIAL_COLORS.stone);
}

/** 原点=底面中心の単位箱(Part の変換規約と一致) */
function unitBoxGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/** 原点=下端中心・+z 向きの単位面(開口の暗色面・扉板) */
function unitPlaneGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/**
 * 境界標・立石の単位形状(ward-stones プール用): 先細り(0.58)+
 * 頂部が +z 側へ前傾した立石。フラット法線(面ごとに頂点を持つ)。
 */
function wardStoneGeometry(): THREE.BufferGeometry {
  const t = 0.29; // 頂部の半幅(taper 0.58)
  const b: [number, number, number][] = [
    [-0.5, 0, -0.5],
    [0.5, 0, -0.5],
    [0.5, 0, 0.5],
    [-0.5, 0, 0.5],
  ];
  const tp: [number, number, number][] = [
    [-t, 1, -t],
    [t, 1, -t],
    [t, 0.86, t],
    [-t, 0.86, t],
  ];
  const quads: [number, number, number, number][] = [
    [0, 1, 5, 4], // -z 面
    [1, 2, 6, 5], // +x 面
    [2, 3, 7, 6], // +z 面(前傾側)
    [3, 0, 4, 7], // -x 面
    [4, 5, 6, 7], // 頂面
    [3, 2, 1, 0], // 底面
  ];
  const v = [...b, ...tp];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const quad of quads) {
    let [p0, p1, p2, p3] = quad.map((i) => v[i]) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    let nx =
      (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]);
    let ny =
      (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
    let nz =
      (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    // 法線を立石の中心 (0, 0.5, 0) から外向きへ揃える(巻き順も反転)
    const cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
    const cy = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;
    const cz = (p0[2] + p1[2] + p2[2] + p3[2]) / 4;
    if (nx * cx + ny * (cy - 0.5) + nz * cz < 0) {
      [p0, p1, p2, p3] = [p3, p2, p1, p0];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const p of [p0, p1, p2, p0, p2, p3]) {
      positions.push(p[0], p[1], p[2]);
      normals.push(nx, ny, nz);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  return g;
}

// --- 魔法灯の火屋・浮遊要素の InstancedMesh ---

/** 上下動の角速度(ゆっくり。周期 約8.4秒)と明滅の位相係数 */
const FLOAT_BOB_SPEED = 0.75;

/**
 * 尖った塊(八面体系)の単位形状(底面中心 y 0〜1)。フラット法線。
 * 発光八面体(crystalPart と同形)と浮石(不整形)で共用する。
 */
function lumpGeometry(
  bottom: [number, number, number],
  top: [number, number, number],
  ring: [number, number, number][],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
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
    const v0 = a;
    let v1 = b;
    let v2 = c;
    // 法線を塊の中心 (0, 0.5, 0) から外向きへ(巻き順も反転)
    if (nx * cx + ny * (cy - 0.5) + nz * cz < 0) {
      [v1, v2] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const v of [v0, v1, v2]) {
      positions.push(v[0], v[1], v[2]);
      normals.push(nx, ny, nz);
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
  return g;
}

/** 発光八面体(火屋・浮遊水晶)。crystalPart と同じ単位形状 */
function glowOctahedronGeometry(): THREE.BufferGeometry {
  return lumpGeometry(
    [0, 0, 0],
    [0, 1, 0],
    [
      [-0.5, 0.42, 0],
      [0, 0.42, -0.5],
      [0.5, 0.42, 0],
      [0, 0.42, 0.5],
    ],
  );
}

/** 浮石: 不整形に潰した塊(頂部・赤道をずらした八面体) */
function floatStoneGeometry(): THREE.BufferGeometry {
  return lumpGeometry(
    [0.06, 0, -0.04],
    [-0.05, 1, 0.04],
    [
      [-0.5, 0.46, -0.08],
      [0.1, 0.4, -0.5],
      [0.5, 0.52, 0.05],
      [-0.07, 0.56, 0.5],
    ],
  );
}

/**
 * 上下動のシェーダーパッチ: インスタンス属性 aPhase(id ハッシュ由来の
 * 位相)・aAmp(ローカル振幅)とビューワーの時間 uniform で
 * y をオフセットする。reduced-motion では uniform が更新されず静止する。
 */
function patchFloatBobVertex(shader: {
  vertexShader: string;
}): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
      attribute float aPhase;
      attribute float aAmp;
      uniform float uGlowTime;
      varying float vFloatPhase;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      transformed.y += aAmp * sin(uGlowTime * ${FLOAT_BOB_SPEED.toFixed(2)} + aPhase);
      vFloatPhase = aPhase;`,
    );
}

/**
 * 発光インスタンス(火屋・浮遊水晶)のマテリアル: 発光束と同じ数値規範
 * (ベース #2a3a38 / emissive #5fd4c0 × 2.0、明滅 ±15%・周期約5.5秒)。
 * 明滅の位相は aPhase(id ハッシュ由来)、上下動は aAmp。
 */
function glowInstancedMaterial(
  timeUniform: TimeUniform,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(GLOW_BASE_COLOR),
    emissive: new THREE.Color(GLOW_EMISSIVE_COLOR),
    emissiveIntensity: GLOW_EMISSIVE_INTENSITY,
    roughness: 0.55,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowTime = timeUniform;
    patchFloatBobVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uGlowTime;\nvarying float vFloatPhase;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= 1.0 + 0.15 * sin(uGlowTime * 1.14 + vFloatPhase * 1.7);`,
      );
  };
  material.customProgramCacheKey = () => "pfd-ward-glow-inst";
  return material;
}

/** 浮石のマテリアル(石色+個体ムラ instanceColor+上下動) */
function floatStoneMaterial(
  timeUniform: TimeUniform,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.95,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowTime = timeUniform;
    patchFloatBobVertex(shader);
  };
  material.customProgramCacheKey = () => "pfd-ward-floatstone";
  return material;
}

/**
 * FloatInstance の列から InstancedMesh を組む(aPhase / aAmp 属性付き)。
 * baseColor があれば instanceColor = 基準色×個体ムラ(浮石)。
 * どちらも影は落とさない(小さく動く要素。1.8節の影キャスター規律)。
 */
function buildFloatInstancedMesh(
  instances: FloatInstance[],
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  baseColor: THREE.Color | null,
): THREE.InstancedMesh | null {
  if (instances.length === 0) {
    geometry.dispose();
    material.dispose();
    return null;
  }
  const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
  const phases = new Float32Array(instances.length);
  const amps = new Float32Array(instances.length);
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
    phases[i] = inst.phase;
    // 振幅はワールド指定 → インスタンススケール前のローカル単位へ換算
    amps[i] = inst.amp / Math.max(inst.scale[1], 1e-6);
    if (baseColor) {
      mesh.setColorAt(
        i,
        pieceColor(baseColor, [
          inst.position[0],
          inst.position[1] + inst.scale[1] / 2,
          inst.position[2],
        ]),
      );
    }
  }
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  geometry.setAttribute("aAmp", new THREE.InstancedBufferAttribute(amps, 1));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * ピースのプールから InstancedMesh を組む(instanceColor = 基準色×個体ムラ)。
 * fadeWorldSize を渡すと遠距離 LOD のディザ減衰が付く(小部品プール用)。
 */
function buildPoolMesh(
  pieces: Piece[],
  geometry: THREE.BufferGeometry,
  name: string,
  castShadow: boolean,
  roughness: number,
  fadeWorldSize?: number,
): THREE.InstancedMesh | null {
  if (pieces.length === 0) {
    geometry.dispose();
    return null;
  }
  const material = new THREE.MeshStandardMaterial({ roughness });
  if (fadeWorldSize !== undefined) applyDistanceFade(material, fadeWorldSize);
  const mesh = new THREE.InstancedMesh(geometry, material, pieces.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    q.setFromAxisAngle(up, piece.rotation);
    pos.set(piece.position[0], piece.position[1], piece.position[2]);
    scl.set(piece.scale[0], piece.scale[1], piece.scale[2]);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, piece.color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * 発光束のマテリアル: ベース #2a3a38 + emissive #5fd4c0 ×
 * emissiveIntensity 2.0(art-direction 5.4節)。頂点カラーは発光の重み
 * (コア 1.0 / 紋様 0.35)として拡散と emissive の両方に乗る。
 * 明滅(±0.3 = ±15%、周期約 5.5 秒)はビューワーの時間 uniform で行い、
 * 位相は位置ハッシュ由来。reduced-motion では uniform が更新されず静止する。
 */
function glowMaterial(timeUniform: TimeUniform): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    color: new THREE.Color(GLOW_BASE_COLOR),
    emissive: new THREE.Color(GLOW_EMISSIVE_COLOR),
    emissiveIntensity: GLOW_EMISSIVE_INTENSITY,
    roughness: 0.55,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowTime = timeUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGlowWorld;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvGlowWorld = transformed;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uGlowTime;\nvarying vec3 vGlowWorld;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          // 明滅 ±15%(= 2.0 ± 0.3)・周期 約5.5秒。位相は位置ハッシュ由来
          float phase = fract(sin(dot(floor(vGlowWorld.xz * 0.5),
            vec2(12.9898, 78.233))) * 43758.5453) * 6.2832;
          totalEmissiveRadiance *= 1.0 + 0.15 * sin(uGlowTime * 1.14 + phase);
          #ifdef USE_COLOR
          // 頂点カラー = 発光の重み(コア 1.0 / 紋様 0.35)。
          // three r185 では vColor は vec4(color_pars_fragment)
          totalEmissiveRadiance *= vColor.rgb;
          #endif
        }`,
      );
  };
  material.customProgramCacheKey = () => "pfd-buildings-glow";
  return material;
}

/**
 * 建物+結界構造+魔法灯・浮遊要素+橋の一式のメッシュを構築する
 * (結界・灯・浮遊は mesh/wardparts.ts、橋は mesh/bridgeparts.ts の
 * 展開結果を合流)。
 * 戻り値: 躯体マージ 1 + 屋根マージ 1 + 発光束マージ 1(発光部品が
 * あるときのみ)+ インスタンスプールの InstancedMesh(building-trim /
 * building-openings / building-piles / ward-stones / ward-glow-crystals /
 * ward-floatstones。存在するもののみ)。
 * draw call は建物+結界+橋の全体で 9 前後に収まる(1.8節の予算)。
 * timeUniform はビューワーが毎フレーム更新する共有の時間(水面と同じ流儀)。
 */
export function buildBuildings(
  model: WorldModel,
  timeUniform: TimeUniform,
): THREE.Object3D[] {
  const solid: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const roof: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const glow: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const pools: InstancePools = { boxes: [], planes: [], piles: [], stones: [] };
  let unknown = 0;

  const processPart = (part: Part): void => {
    const handler = MERGE_HANDLERS[part.type];
    if (handler) {
      const buf = ROOF_MATERIAL_IDS.has(part.materialId) ? roof : solid;
      handler(part, buf, materialColor(part.materialId));
      return;
    }
    const glowHandler = GLOW_HANDLERS[part.type];
    if (glowHandler) {
      glowHandler(part, solid, glow, materialColor(part.materialId));
      return;
    }
    const instanced = INSTANCED_TYPES[part.type];
    if (instanced) {
      instanced(part, materialColor(part.materialId), pools);
      return;
    }
    unknown++;
  };

  for (const building of model.buildings as Building[]) {
    for (const part of building.parts) processPart(part);
  }
  // 結界構造+魔法灯・浮遊要素:
  // mesh/wardparts.ts の展開結果を同じ束へ合流させる
  const wardExpansion = expandWardParts(model);
  for (const part of wardExpansion.parts) processPart(part);
  // 橋: mesh/bridgeparts.ts の展開結果を合流させる
  for (const part of expandBridgeParts(model).parts) processPart(part);

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

  // 発光束(1 マージ束のみ。影は落とさない。Bloom・動的光源は使わない)
  if (glow.indices.length > 0) {
    const mesh = new THREE.Mesh(buildGeoBuffer(glow), glowMaterial(timeUniform));
    mesh.name = "buildings-glow";
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    out.push(mesh);
  }

  // インスタンス経路(共有プールごとに 1 InstancedMesh)。
  // 影は building-trim(主要 InstancedMesh)のみ落とす(1.8節)。
  // 窓枠・扉・梁・煙突などの小部品プールには遠距離 LOD の
  // ディザ減衰を付ける(contracts/pipeline.md「描画プリセット・LOD・
  // デバッグ表示」)
  const trim = buildPoolMesh(
    pools.boxes,
    unitBoxGeometry(),
    "building-trim",
    true,
    1,
    model.ground.size,
  );
  if (trim) out.push(trim);
  const openings = buildPoolMesh(
    pools.planes,
    unitPlaneGeometry(),
    "building-openings",
    false,
    1,
    model.ground.size,
  );
  if (openings) out.push(openings);
  const piles = buildPoolMesh(
    pools.piles,
    unitBoxGeometry(),
    "building-piles",
    false,
    0.95,
  );
  if (piles) out.push(piles);
  // 境界標・立石。wardLevel 1 の主要な結界表現のため
  // 主要 InstancedMesh として影を落とす(contracts「結界構造の立体化」)
  const stones = buildPoolMesh(
    pools.stones,
    wardStoneGeometry(),
    "ward-stones",
    true,
    0.95,
  );
  if (stones) out.push(stones);

  // 魔法灯の火屋+浮遊水晶(発光の共有 InstancedMesh)と
  // 浮石。上下動・明滅はビューワーの時間 uniform(reduced-motion で静止)
  const glowInstanced = buildFloatInstancedMesh(
    [...wardExpansion.lampHeads, ...wardExpansion.floatCrystals],
    glowOctahedronGeometry(),
    glowInstancedMaterial(timeUniform),
    "ward-glow-crystals",
    null,
  );
  if (glowInstanced) out.push(glowInstanced);
  const floatStones = buildFloatInstancedMesh(
    wardExpansion.floatStones,
    floatStoneGeometry(),
    floatStoneMaterial(timeUniform),
    "ward-floatstones",
    materialColor("stone"),
  );
  if (floatStones) out.push(floatStones);
  return out;
}
