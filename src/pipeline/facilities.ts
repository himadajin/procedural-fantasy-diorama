/**
 * 段14「施設」: 施設(Facility)の生成(Phase D。
 * `docs/internal/plans/2026-07-14-worldgen-rework-facilities.md`)。
 * 契約の正は docs/internal/contracts/facilities.md(kind 一覧・配置条件・
 * 衝突/帯検証則・RNG ラベル体系・造形の純関数分離・kind ごとの造形の性質)。
 *
 * D2b: field(畑)/ pasture(牧草地)— farmland 区画への生成。
 * D3: well(井戸)/ stall(市場屋台)— 市街広場・農村道路ノードへの生成。
 * windmill / watermill / pier は D4〜D5 で追う。
 *
 * 造形は「入力(寸法・向き・当該施設の rng サブストリーム)→ Part[]」の
 * 純関数(buildXxxParts)として配置ロジックから分離する(契約 3.8b。
 * ギャラリーは buildFarmlandFacility / buildPlazaWellFacility /
 * buildPlazaStallFacilities を経由してこの本番の造形関数のみを呼ぶ)。
 * 乱数は新設ストリーム `"facility/<...>"` のみを消費し、既存ストリームの
 * 消費列は変えない。
 */
import { makeRng, type Rng } from "../rng";
import type {
  Facility,
  Parcel,
  Part,
  Plaza,
  Vec2,
  WorldModel,
} from "../model/worldmodel";
import { distToPolyline, polygonSignedDistance } from "../model/waterfield";
import { sampleFieldGrid } from "../model/fieldgrid";
import { ensureClockwise } from "../model/geometry";
import { createSiteContext } from "./parcels";

// --- field / pasture の造形数値(すべて提案値。contracts/facilities.md
//     「kind ごとの造形の性質」。調整時は契約を同一 commit で更新する) ---
/** kind 抽選: field の確率(残りが pasture) */
const FIELD_RATE = 0.68;
/** 畑: 基盤パッチの内側マージン・高さ */
const FIELD_BASE_INSET = 0.5;
const FIELD_BASE_H = 0.06;
/** 畑: 畝の幅・高さ・高さ揺らぎ・間隔帯・端マージン */
const RIDGE_W = 1.0;
const RIDGE_H = 0.3;
const RIDGE_H_JITTER = 0.05;
const RIDGE_SPACING_MIN = 1.7;
const RIDGE_SPACING_MAX = 2.0;
/** 畝の長さ = 基盤の奥行き − 両端 1.6 */
const RIDGE_END_MARGIN = 1.6;
/** 畝の列数 = floor((基盤の間口 − 2.4) / 間隔) + 1 */
const RIDGE_SIDE_MARGIN_TOTAL = 2.4;
/** 畑: 作物の有無(外れは裸の耕土) */
const CROP_CHANCE = 0.72;
/** 柵: 区画境界からの内側オフセット・柱間隔 */
const FENCE_INSET = 0.3;
const POST_SPACING = 2.4;
/** 柵: 柱の断面・高さ(field) */
const POST_SIZE = 0.14;
const FIELD_POST_H = 0.75;
/** 柵: 横木の断面(高さ 0.14 × 厚み 0.09)と field の横木中心高 */
const RAIL_H = 0.14;
const RAIL_T = 0.09;
const FIELD_RAIL_Y = 0.5;
/** 柵: ゲート開口(field)と門柱 */
const FIELD_GATE_W = 2.0;
const GATE_POST_SIZE = 0.18;
const FIELD_GATE_POST_H = 0.95;
/** 短すぎる横木セグメントは省略(建物の石垣と同じ流儀) */
const MIN_RAIL_LEN = 0.5;
/** 牧草地: パッチの内側マージン・高さ */
const PASTURE_PATCH_INSET = 1.0;
const PASTURE_PATCH_H = 0.05;
/** 牧草地: 柱高・横木 2 本の中心高・ゲート・門柱(高さは ±10% 揺らぎ共通) */
const PASTURE_POST_H = 0.9;
const PASTURE_RAIL_YS = [0.38, 0.72] as const;
const PASTURE_GATE_W = 2.4;
const PASTURE_GATE_POST_H = 1.05;
/** 施設 parts の footprint 帯(契約「衝突・帯検証則」) */
const PART_BAND = 0.9;

/**
 * 造形純関数の入力(契約「造形の純関数分離」: footprint 寸法・向き・
 * 当該施設の rng サブストリームに限る)。farmland 区画の矩形フレーム。
 */
export interface FarmlandShapeInput {
  /** 前面(接道辺)の中点 */
  origin: Vec2;
  /** 接線単位ベクトル(frontEdge の始点 → 終点) */
  tangent: Vec2;
  /** 奥行き単位ベクトル(前面 → 背面) */
  depthDir: Vec2;
  /** 間口(接道辺の長さ) */
  frontage: number;
  /** 奥行き */
  depth: number;
  /** 当該施設の rng(`facility/farmland/<parcelId>`。kind 抽選の続き) */
  rng: Rng;
}

/** ローカル +x を世界方向 (ux, uz) へ写す Y 回転(Part の変換規約) */
function rotationFor(ux: number, uz: number): number {
  return Math.atan2(-uz, ux);
}

/** フレーム内座標(u = 接線方向、v = 奥行き方向)→ 世界座標 */
function frameAt(input: FarmlandShapeInput, u: number, v: number): Vec2 {
  return {
    x: input.origin.x + input.tangent.x * u + input.depthDir.x * v,
    z: input.origin.z + input.tangent.z * u + input.depthDir.z * v,
  };
}

function makePart(
  type: string,
  materialId: string,
  pos: Vec2,
  y: number,
  rotation: number,
  sx: number,
  sy: number,
  sz: number,
  params?: Record<string, number>,
): Part {
  const part: Part = {
    type,
    transform: {
      position: [pos.x, y, pos.z],
      rotation,
      scale: [sx, sy, sz],
    },
    materialId,
  };
  if (params) part.params = params;
  return part;
}

/** 柵 1 周(post-and-rail)の仕様 */
interface FenceSpec {
  /** 柱の高さ・断面 */
  postH: number;
  postSize: number;
  /** 横木の中心高(下から順) */
  railYs: readonly number[];
  /** ゲート開口の幅と門柱(前面のみ) */
  gateW: number;
  gatePostH: number;
  /** ゲート中心の前面上の位置(0〜1。間口比) */
  gateT: number;
}

/**
 * 柵(post-and-rail)を辺順(前面 → 右側面 → 背面 → 左側面)に生成する。
 * 各辺は始点コーナーの柱を含み終点コーナーを含まない(コーナー柱の重複
 * なし)。前面はゲート開口で横木を 2 分割し、開口の両端に門柱を立てる。
 * 部品順は辺ごとに 柱 → 門柱(前面のみ)→ 横木(契約の配列順)。
 */
function buildFenceParts(input: FarmlandShapeInput, spec: FenceSpec): Part[] {
  const parts: Part[] = [];
  const { frontage, depth } = input;
  const u1 = frontage / 2 - FENCE_INSET;
  const v0 = FENCE_INSET;
  const v1 = depth - FENCE_INSET;
  if (u1 <= 0 || v1 <= v0) return parts;

  const t = input.tangent;
  const d = input.depthDir;
  // 辺: [始点 u, 始点 v, 方向ベクトル, 長さ, 前面か]
  const sides: {
    su: number;
    sv: number;
    dir: Vec2;
    du: number;
    dv: number;
    len: number;
    front: boolean;
  }[] = [
    { su: -u1, sv: v0, dir: t, du: 1, dv: 0, len: u1 * 2, front: true },
    { su: u1, sv: v0, dir: d, du: 0, dv: 1, len: v1 - v0, front: false },
    {
      su: u1,
      sv: v1,
      dir: { x: -t.x, z: -t.z },
      du: -1,
      dv: 0,
      len: u1 * 2,
      front: false,
    },
    {
      su: -u1,
      sv: v1,
      dir: { x: -d.x, z: -d.z },
      du: 0,
      dv: -1,
      len: v1 - v0,
      front: false,
    },
  ];

  // ゲート区間(前面の弧長 s 上)。中心は間口比 gateT(門柱込みで辺内に収める)
  const gateHalf = spec.gateW / 2;
  const gateCenterRaw = (spec.gateT - 0.5) * frontage + u1; // 前面の s 座標系
  const gateCenter = Math.min(
    Math.max(gateCenterRaw, gateHalf + spec.postSize + 0.2),
    u1 * 2 - gateHalf - spec.postSize - 0.2,
  );
  const gateStart = gateCenter - gateHalf;
  const gateEnd = gateCenter + gateHalf;

  for (const side of sides) {
    const rot = rotationFor(side.dir.x, side.dir.z);
    const at = (s: number): Vec2 =>
      frameAt(input, side.su + side.du * s, side.sv + side.dv * s);
    const inGate = (s: number): boolean =>
      side.front && s > gateStart - spec.postSize && s < gateEnd + spec.postSize;

    // 柱(始点コーナー含む・終点コーナーは次辺の始点)
    const n = Math.max(2, Math.ceil(side.len / POST_SPACING) + 1);
    const step = side.len / (n - 1);
    for (let k = 0; k < n - 1; k++) {
      const s = k * step;
      if (inGate(s)) continue;
      parts.push(
        makePart(
          "beam",
          "wood",
          at(s),
          0,
          rot,
          spec.postSize,
          spec.postH,
          spec.postSize,
        ),
      );
    }
    // 門柱(前面のみ。開口の両端)
    if (side.front) {
      for (const s of [gateStart, gateEnd]) {
        parts.push(
          makePart(
            "beam",
            "wood",
            at(s),
            0,
            rot,
            GATE_POST_SIZE,
            spec.gatePostH,
            GATE_POST_SIZE,
          ),
        );
      }
    }
    // 横木(辺ごとに通し。前面はゲート開口で 2 分割)
    const segments: [number, number][] = side.front
      ? [
          [0, gateStart],
          [gateEnd, side.len],
        ]
      : [[0, side.len]];
    for (const railY of spec.railYs) {
      for (const [s0, s1] of segments) {
        const len = s1 - s0;
        if (len < MIN_RAIL_LEN) continue;
        parts.push(
          makePart(
            "beam",
            "wood",
            at((s0 + s1) / 2),
            railY - RAIL_H / 2,
            rot,
            len,
            RAIL_H,
            RAIL_T,
          ),
        );
      }
    }
  }
  return parts;
}

/**
 * 畑(field)の造形純関数(契約「field(畑)」)。
 * parts 配列順: 基盤パッチ 1 → 畝 N(−u → +u)→ 柵。
 * rng 消費(列挙順に固定): (1) 作物の有無 (2) 作物色 (3) 畝間隔
 * (4) 畝高さ揺らぎ (5) ゲート位置。
 */
export function buildFieldParts(input: FarmlandShapeInput): Part[] {
  const { rng, frontage, depth } = input;
  const hasCrop = rng.chance(CROP_CHANCE);
  const cropColor = rng.next() < 0.5 ? 1 : 2;
  const spacing = rng.range(RIDGE_SPACING_MIN, RIDGE_SPACING_MAX);
  const ridgeH = RIDGE_H + rng.range(-RIDGE_H_JITTER, RIDGE_H_JITTER);
  const gateT = rng.range(0.35, 0.65);
  const top = hasCrop ? cropColor : 0;

  const parts: Part[] = [];
  const baseW = frontage - FIELD_BASE_INSET * 2;
  const baseD = depth - FIELD_BASE_INSET * 2;
  const alongDepth = rotationFor(input.depthDir.x, input.depthDir.z);
  const alongFront = rotationFor(input.tangent.x, input.tangent.z);
  if (baseW > 0 && baseD > 0) {
    // 基盤パッチ(耕土。区画の内側 0.5)
    parts.push(
      makePart(
        "ground-patch",
        "tilled-soil",
        frameAt(input, 0, depth / 2),
        0,
        alongFront,
        baseW,
        FIELD_BASE_H,
        baseD,
      ),
    );
    // 畝(奥行き方向の平行列。中央揃え・上面のみ作物の緑)
    const ridgeLen = baseD - RIDGE_END_MARGIN * 2;
    const count = Math.max(
      1,
      Math.floor((baseW - RIDGE_SIDE_MARGIN_TOTAL) / spacing) + 1,
    );
    if (ridgeLen > 0.8) {
      for (let i = 0; i < count; i++) {
        const u = (i - (count - 1) / 2) * spacing;
        parts.push(
          makePart(
            "ground-patch",
            "tilled-soil",
            frameAt(input, u, depth / 2),
            FIELD_BASE_H,
            alongDepth,
            ridgeLen,
            ridgeH,
            RIDGE_W,
            { top },
          ),
        );
      }
    }
  }
  parts.push(
    ...buildFenceParts(input, {
      postH: FIELD_POST_H,
      postSize: POST_SIZE,
      railYs: [FIELD_RAIL_Y],
      gateW: FIELD_GATE_W,
      gatePostH: FIELD_GATE_POST_H,
      gateT,
    }),
  );
  return parts;
}

/**
 * 牧草地(pasture)の造形純関数(契約「pasture(牧草地)」)。
 * parts 配列順: 牧草パッチ 1 → 柵。
 * rng 消費(列挙順に固定): (1) 柵高さ揺らぎ ±10% (2) ゲート位置。
 */
export function buildPastureParts(input: FarmlandShapeInput): Part[] {
  const { rng, frontage, depth } = input;
  const hMul = rng.range(0.9, 1.1);
  const gateT = rng.range(0.35, 0.65);

  const parts: Part[] = [];
  const patchW = frontage - PASTURE_PATCH_INSET * 2;
  const patchD = depth - PASTURE_PATCH_INSET * 2;
  if (patchW > 0 && patchD > 0) {
    parts.push(
      makePart(
        "ground-patch",
        "meadow",
        frameAt(input, 0, depth / 2),
        0,
        rotationFor(input.tangent.x, input.tangent.z),
        patchW,
        PASTURE_PATCH_H,
        patchD,
      ),
    );
  }
  parts.push(
    ...buildFenceParts(input, {
      postH: PASTURE_POST_H * hMul,
      postSize: POST_SIZE,
      railYs: PASTURE_RAIL_YS.map((y) => y * hMul),
      gateW: PASTURE_GATE_W,
      gatePostH: PASTURE_GATE_POST_H * hMul,
      gateT,
    }),
  );
  return parts;
}

/** farmland 区画の矩形フレーム(frontEdge・polygon から決定論的に導出) */
function parcelShapeFrame(parcel: Parcel): Omit<FarmlandShapeInput, "rng"> {
  const [a, b] = parcel.frontEdge;
  const fx = b.x - a.x;
  const fz = b.z - a.z;
  const frontage = Math.hypot(fx, fz);
  const inv = frontage > 1e-9 ? 1 / frontage : 0;
  const tangent: Vec2 = { x: fx * inv, z: fz * inv };
  const origin: Vec2 = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  // 奥行き方向: 接線の法線のうち、区画ポリゴンが伸びている側
  let depthDir: Vec2 = { x: -tangent.z, z: tangent.x };
  let eMin = 0;
  let eMax = 0;
  for (const v of parcel.polygon) {
    const e = (v.x - origin.x) * depthDir.x + (v.z - origin.z) * depthDir.z;
    eMin = Math.min(eMin, e);
    eMax = Math.max(eMax, e);
  }
  let depth = eMax;
  if (-eMin > eMax) {
    depthDir = { x: -depthDir.x, z: -depthDir.z };
    depth = -eMin;
  }
  return { origin, tangent, depthDir, frontage, depth };
}

/**
 * farmland 区画 1 枚から施設(field / pasture)1 件を生成する
 * (段14 の本番ループとギャラリーが共用する唯一の生成関数。契約
 * 「造形の純関数分離」のギャラリー制約に対応)。
 *
 * kind は `facility/farmland/<parcelId>` ストリームの chance 1 回で決める。
 * `kindOverride` 非 null のときも**抽選の消費は通常どおり行った上で**
 * 値だけ置き換える(ギャラリーの role 強制と同じ「消費は保つが結果は
 * 捨てる」意味論。contracts/pipeline.md「role の強制」)。
 */
export function buildFarmlandFacility(
  seed: string,
  parcel: Parcel,
  kindOverride: "field" | "pasture" | null = null,
): Facility {
  const rng = makeRng(seed, `facility/farmland/${parcel.id}`);
  const rolled = rng.chance(FIELD_RATE) ? "field" : "pasture";
  const kind = kindOverride ?? rolled;
  const frame = parcelShapeFrame(parcel);
  const input: FarmlandShapeInput = { ...frame, rng };
  const parts =
    kind === "field" ? buildFieldParts(input) : buildPastureParts(input);
  return {
    id: `facility/${kind}/${parcel.id}`,
    kind,
    footprint: parcel.polygon.map((p) => ({ x: p.x, z: p.z })),
    facing: parcel.facing,
    parts,
    origin: { type: "parcel", parcelId: parcel.id },
  };
}

// --- well / stall の造形数値(すべて提案値。contracts/facilities.md
//     「kind ごとの造形の性質」D1b。調整時は契約を同一 commit で更新する) ---
/** 井戸: 石環(外形・厚み・高さと ±10% 揺らぎ) */
const WELL_RING_OUTER = 1.9;
const WELL_RING_T = 0.3;
const WELL_RING_H = 0.7;
/** 井戸: 内面の暗色板(1.3 角・高さ 0.02・y 0.35) */
const WELL_VOID_SIZE = 1.3;
const WELL_VOID_H = 0.02;
const WELL_VOID_Y = 0.35;
/** 井戸: 柱(0.16 角 × 高さ 2.10。石環の外側 0.1)と轆轤(0.14 角・y 1.55) */
const WELL_POST_SIZE = 0.16;
const WELL_POST_H = 2.1;
const WELL_POST_GAP = 0.1;
const WELL_BAR_SIZE = 0.14;
const WELL_BAR_Y = 1.55;
/** 井戸: 小屋根(棟長 2.5 × スパン 1.7・pitch 54・底面 y 1.95) */
const WELL_ROOF_RIDGE = 2.5;
const WELL_ROOF_SPAN = 1.7;
const WELL_ROOF_PITCH = 54;
const WELL_ROOF_Y = 1.95;
/** 井戸: footprint(石環外形 + 0.15 の正方形)・向き揺らぎ ±4° */
const WELL_FOOT_HALF = (WELL_RING_OUTER + 0.3) / 2;
const WELL_FACING_JITTER = (4 * Math.PI) / 180;

/** 屋台: 台(幅 × 奥行き × 高さ。高さは ±8% 揺らぎ) */
const STALL_TABLE_W = 2.6;
const STALL_TABLE_D = 1.4;
const STALL_TABLE_H = 0.85;
/** 屋台: 柱(0.12 角。台の四隅の外 0.1。前 1.85 / 後 2.30) */
const STALL_POST_SIZE = 0.12;
const STALL_POST_OFFSET = 0.1;
const STALL_FRONT_POST_H = 1.85;
const STALL_REAR_POST_H = 2.3;
/** 屋台: 天幕(間口 3.0 × 奥行き 2.0。高い縁 y 2.30・前へ 0.4 張り出し) */
const STALL_CANOPY_W = 3.0;
const STALL_CANOPY_D = 2.0;
const STALL_CANOPY_TOP_Y = 2.3;
const STALL_CANOPY_FRONT_OVERHANG = 0.4;
/** 屋台: footprint(台+柱の外形) */
const STALL_FOOT_W = 2.9;
const STALL_FOOT_D = 1.6;
/** 天幕色の重み(生成り 0.5 / 茜 0.3 / 青灰 0.2。art-direction 5.5節) */
const AWNING_IDS = ["canvas", "awning-madder", "awning-slate"] as const;
const AWNING_WEIGHTS = [0.5, 0.3, 0.2] as const;

// --- well / stall の配置数値(契約「kind 一覧・配置条件」「衝突・帯検証則」) ---
/** 広場の縁帯(縁からの距離)と中央円の半径比・通行帯セクターの半角 */
const PLAZA_EDGE_BAND = 1.0;
const PLAZA_EDGE_BAND_OUTER = PLAZA_EDGE_BAND * 2.5;
const PLAZA_CENTER_CIRCLE_RATIO = 0.45;
const TRAFFIC_SECTOR_HALF = (20 * Math.PI) / 180;
/** 屋台のスロットピッチ(間口 3.0 + 間隔 1.0)と既配置屋台との最小間隔 */
const STALL_SLOT_PITCH = 4.0;
const STALL_MIN_SPACING = 3.2;
/** 井戸(広場)の合格条件: 縁から 2.7 以上(縁帯 2.5 + マージン 0.2) */
const WELL_EDGE_MIN = PLAZA_EDGE_BAND_OUTER + 0.2;
/** 農村井戸の決定論走査(8 方位 × 距離 3 段)と汎用クリアランス */
const RURAL_WELL_DISTANCES = [3.2, 4.0, 4.8] as const;
const RURAL_WELL_DIRECTIONS = 8;
const CLEAR_PARCEL = 1.0;
const CLEAR_ROAD = 1.0;
const CLEAR_PLAZA = 1.0;
const CLEAR_FACILITY = 1.0;
const CLEAR_CENTER = 1.5;
const CLEAR_BOUNDARY = 2.0;
const CLEAR_WATER = 1.0;
const RING_BUFFER = 2.5;
/** 農村ゾーン判定(urbanity < 0.45。contracts/network-plaza.md) */
const RURAL_URBANITY = 0.45;

/** 井戸の造形純関数の入力(契約「造形の純関数分離」) */
export interface WellShapeInput {
  /** 井戸の中心 */
  center: Vec2;
  /** 正面方位(向き揺らぎ込み。facing に直交する対辺に柱が立つ) */
  facing: number;
  /** 当該施設の rng(採否・位置ジッターの続き) */
  rng: Rng;
}

/**
 * 井戸(well)の造形純関数(契約「well(井戸)」)。
 * parts 配列順: 石環 4(前 → 右 → 奥 → 左)→ 内面 1 → 柱 2(+s → −s)→
 * 轆轤 1 → 小屋根 1。
 * rng 消費(列挙順に固定): (1) 石環高さ ±10%(向き揺らぎは呼び出し側で
 * facing へ畳み込み済み — 契約 D3 実装補足)。
 */
export function buildWellParts(input: WellShapeInput): Part[] {
  const { center, facing, rng } = input;
  const ringH = WELL_RING_H * rng.range(0.9, 1.1);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const at = (u: number, v: number): Vec2 => ({
    x: center.x + s.x * u + f.x * v,
    z: center.z + s.z * u + f.z * v,
  });
  const rotS = Math.atan2(-s.z, s.x);
  const rotF = Math.atan2(-f.z, f.x);
  const half = WELL_RING_OUTER / 2;
  const mid = half - WELL_RING_T / 2;
  const innerLen = WELL_RING_OUTER - WELL_RING_T * 2;

  const parts: Part[] = [];
  // 石環(口の字。前(+f)→ 右(+s)→ 奥(−f)→ 左(−s))。前後 = 全長、
  // 左右 = 内側の残り(コーナーの重複なし)
  parts.push(
    makePart("fence", "stone", at(0, mid), 0, rotS, WELL_RING_OUTER, ringH, WELL_RING_T),
    makePart("fence", "stone", at(mid, 0), 0, rotF, innerLen, ringH, WELL_RING_T),
    makePart("fence", "stone", at(0, -mid), 0, rotS, WELL_RING_OUTER, ringH, WELL_RING_T),
    makePart("fence", "stone", at(-mid, 0), 0, rotF, innerLen, ringH, WELL_RING_T),
  );
  // 内面(井桁内の暗がり。水面・発光の表現はしない)
  parts.push(
    makePart(
      "ground-patch",
      "void",
      center,
      WELL_VOID_Y,
      rotS,
      WELL_VOID_SIZE,
      WELL_VOID_H,
      WELL_VOID_SIZE,
    ),
  );
  // 柱(facing に直交する対辺の外側中点。石環から 0.1)と轆轤
  const postU = half + WELL_POST_GAP + WELL_POST_SIZE / 2;
  parts.push(
    makePart("beam", "wood", at(postU, 0), 0, rotS, WELL_POST_SIZE, WELL_POST_H, WELL_POST_SIZE),
    makePart("beam", "wood", at(-postU, 0), 0, rotS, WELL_POST_SIZE, WELL_POST_H, WELL_POST_SIZE),
  );
  parts.push(
    makePart(
      "beam",
      "wood",
      center,
      WELL_BAR_Y - WELL_BAR_SIZE / 2,
      rotS,
      postU * 2,
      WELL_BAR_SIZE,
      WELL_BAR_SIZE,
    ),
  );
  // 小屋根(棟 = 柱を結ぶ軸 = s 方向)。棟高 = tan(pitch) × スパン / 2
  const ridgeH = Math.tan((WELL_ROOF_PITCH * Math.PI) / 180) * (WELL_ROOF_SPAN / 2);
  parts.push(
    makePart(
      "gable",
      "shingle",
      center,
      WELL_ROOF_Y,
      rotS,
      WELL_ROOF_RIDGE,
      ridgeH,
      WELL_ROOF_SPAN,
      { pitch: WELL_ROOF_PITCH },
    ),
  );
  return parts;
}

/** 屋台の造形純関数の入力 */
export interface StallShapeInput {
  /** 屋台の中心(台の中心) */
  center: Vec2;
  /** 正面方位(広場中心向き。前柱・台の正面がこちら) */
  facing: number;
  /** 広場の共有 rng(`facility/stall/<plazaId>`。屋台ごとに連番消費) */
  rng: Rng;
}

/**
 * 屋台(stall)の造形純関数(契約「stall(屋台)」)。
 * parts 配列順: 台 1 → 柱 4(前 2(−s → +s)→ 後 2(−s → +s))→ 天幕 1。
 * rng 消費(1 屋台あたり固定 3 ロール): (1) 天幕色(重み抽選)
 * (2) 天幕落差(0.35〜0.55) (3) 台高さ(±8%)。
 */
export function buildStallParts(input: StallShapeInput): Part[] {
  const { center, facing, rng } = input;
  const awning = rng.weighted(AWNING_IDS, AWNING_WEIGHTS);
  const drop = rng.range(0.35, 0.55);
  const tableH = STALL_TABLE_H * rng.range(0.92, 1.08);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const at = (u: number, v: number): Vec2 => ({
    x: center.x + s.x * u + f.x * v,
    z: center.z + s.z * u + f.z * v,
  });
  const rotS = Math.atan2(-s.z, s.x);
  const rotToFront = Math.atan2(f.x, f.z); // canopy: ローカル +z → f(低い側 = 前)

  const parts: Part[] = [];
  // 台(plinth を木の台として流用。広場の舗装に直接置く)
  parts.push(
    makePart("plinth", "wood", center, 0, rotS, STALL_TABLE_W, tableH, STALL_TABLE_D),
  );
  // 柱(台の四隅の外 0.1。前柱 = facing 側が低く、後柱が高い片流れ)
  const postU = STALL_TABLE_W / 2 + STALL_POST_OFFSET;
  const postV = STALL_TABLE_D / 2 + STALL_POST_OFFSET;
  for (const [u, v, h] of [
    [-postU, postV, STALL_FRONT_POST_H],
    [postU, postV, STALL_FRONT_POST_H],
    [-postU, -postV, STALL_REAR_POST_H],
    [postU, -postV, STALL_REAR_POST_H],
  ] as const) {
    parts.push(
      makePart("beam", "wood", at(u, v), 0, rotS, STALL_POST_SIZE, h, STALL_POST_SIZE),
    );
  }
  // 天幕(canopy)。position = 高い縁(後端)の下端中心、ローカル +z = 前
  const rearV = STALL_TABLE_D / 2 + STALL_CANOPY_FRONT_OVERHANG - STALL_CANOPY_D;
  parts.push(
    makePart(
      "canopy",
      awning,
      at(0, rearV),
      STALL_CANOPY_TOP_Y,
      rotToFront,
      STALL_CANOPY_W,
      drop,
      STALL_CANOPY_D,
    ),
  );
  return parts;
}

// --- 広場・農村ノードへの配置(契約「kind 一覧・配置条件」D3 実装補足) ---

/** 広場中心からのレイと polygon 縁の交点距離(見つからなければ radius) */
function rayDistanceToPolygon(center: Vec2, angle: number, polygon: Vec2[], fallback: number): number {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const denom = dx * ez - dz * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const wx = a.x - center.x;
    const wz = a.z - center.z;
    const t = (wx * ez - wz * ex) / denom; // レイのパラメータ
    const u = (dx * wz - dz * wx) / -denom; // 辺のパラメータ
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return Number.isFinite(best) ? best : fallback;
}

/** 通行帯セクターの流入方位の上限(契約 D3 実装補足。提案値) */
const MAX_TRAFFIC_AZIMUTHS = 4;
/** 近接する流入方位候補をまとめる角(同上) */
const AZIMUTH_MERGE = (10 * Math.PI) / 180;
/** 道路 class の格(main > connector > street。lane は対象外) */
const ROAD_CLASS_RANK: Record<string, number> = {
  main: 0,
  connector: 1,
  street: 2,
};

/**
 * 広場に接続する道路 edge の流入方位(契約 D3 実装補足)。
 * lane 以外の edge のうち path の端点が広場中心から radius + width 以内の
 * ものを候補とし、格の高い順(main > connector > street、同格は幅の
 * 広い順)に最大 4 本を返す(近接 10° はまとめる。決定論・乱数非消費)。
 */
export function plazaInflowAzimuths(model: WorldModel, plaza: Plaza): number[] {
  const candidates: { azimuth: number; rank: number; width: number }[] = [];
  const c = plaza.position;
  for (const edge of model.network.edges) {
    // lane(裏手の小道・岸沿い道)は市場の通行帯を作らない(契約 D3
    // 実装補足。市街中心では街路の端点が十数本収束するため上限も課す)
    const rank = ROAD_CLASS_RANK[edge.class];
    if (rank === undefined) continue;
    const path = edge.path;
    if (path.length < 2) continue;
    for (const fromStart of [true, false]) {
      const end = fromStart ? path[0] : path[path.length - 1];
      if (!end) continue;
      if (Math.hypot(end.x - c.x, end.z - c.z) > plaza.radius + edge.width) {
        continue;
      }
      // 端点から広場の外へ抜ける点を探す
      let probe: Vec2 | null = null;
      const idx = (k: number): Vec2 | undefined =>
        fromStart ? path[k] : path[path.length - 1 - k];
      for (let k = 1; k < path.length; k++) {
        const p = idx(k);
        if (!p) break;
        probe = p;
        if (Math.hypot(p.x - c.x, p.z - c.z) >= plaza.radius) break;
      }
      if (probe) {
        candidates.push({
          azimuth: Math.atan2(probe.z - c.z, probe.x - c.x),
          rank,
          width: edge.width,
        });
      }
    }
  }
  // 格の高い順 → 幅の広い順 → 方位の昇順(決定論の安定順)
  candidates.sort(
    (a, b) => a.rank - b.rank || b.width - a.width || a.azimuth - b.azimuth,
  );
  const azimuths: number[] = [];
  for (const cand of candidates) {
    if (azimuths.length >= MAX_TRAFFIC_AZIMUTHS) break;
    let merged = false;
    for (const az of azimuths) {
      let d = Math.abs(cand.azimuth - az) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d < AZIMUTH_MERGE) {
        merged = true;
        break;
      }
    }
    if (!merged) azimuths.push(cand.azimuth);
  }
  return azimuths;
}

/** 方位が通行帯セクター(流入方位 ±20°)に入るか */
function inTrafficSector(angle: number, azimuths: readonly number[]): boolean {
  for (const az of azimuths) {
    let d = Math.abs(angle - az) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d < TRAFFIC_SECTOR_HALF) return true;
  }
  return false;
}

/** 正方形 footprint(中心・半辺長・向き)を時計回りで作る */
function squareFootprint(center: Vec2, half: number, facing: number): Vec2[] {
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  return rectFootprint(center, f, s, half, half);
}

/** 矩形 footprint(中心・正面方向 f・接線方向 s・半幅 u/v)。時計回りは呼び出し側の座標系に依らず ensure 不要(判定にのみ使う) */
function rectFootprint(center: Vec2, f: Vec2, s: Vec2, halfU: number, halfV: number): Vec2[] {
  return [
    { x: center.x + s.x * halfU + f.x * halfV, z: center.z + s.z * halfU + f.z * halfV },
    { x: center.x - s.x * halfU + f.x * halfV, z: center.z - s.z * halfU + f.z * halfV },
    { x: center.x - s.x * halfU - f.x * halfV, z: center.z - s.z * halfU - f.z * halfV },
    { x: center.x + s.x * halfU - f.x * halfV, z: center.z + s.z * halfU - f.z * halfV },
  ];
}

/** footprint の全コーナーが広場 polygon の内側か(縁から margin 以上) */
function cornersInsidePlaza(footprint: Vec2[], plaza: Plaza, margin: number): boolean {
  for (const c of footprint) {
    if (polygonSignedDistance(c.x, c.z, plaza.polygon) > -margin) return false;
  }
  return true;
}

/**
 * 広場井戸 1 基の生成(段14 の本番ループとギャラリーが共用。契約
 * 「well(井戸)」D3 実装補足)。
 *
 * 消費列(固定): 採否 chance → 位置ジッター 2 ロール → 造形(D1b)。
 * `adoptOverride` 非 null のときも採否の消費は行い、値だけ置き換える
 * (ギャラリーの kind 強制と同じ意味論)。合格位置が無ければ null。
 */
export function buildPlazaWellFacility(
  seed: string,
  settle: number,
  plaza: Plaza,
  trafficAzimuths: readonly number[],
  adoptOverride: boolean | null = null,
): Facility | null {
  const rng = makeRng(seed, `facility/well/${plaza.id}`);
  const wellRate = Math.min(0.9, Math.max(0.3, 0.3 + 0.6 * settle));
  const rolled = rng.chance(wellRate);
  const jitterAngle = rng.range(0, Math.PI * 2);
  const jitterRadial = rng.range(0.52, 0.72);
  if (!(adoptOverride ?? rolled)) return null;

  // 決定論の再走査(乱数を追加消費しない): 角 16 分割 × 半径係数 3 段
  const centerR = plaza.radius * PLAZA_CENTER_CIRCLE_RATIO;
  let pos: Vec2 | null = null;
  outer: for (const radial of [jitterRadial, jitterRadial - 0.08, jitterRadial + 0.08]) {
    for (let k = 0; k < 16; k++) {
      const angle = jitterAngle + (k / 16) * Math.PI * 2;
      const p: Vec2 = {
        x: plaza.position.x + Math.cos(angle) * plaza.radius * radial,
        z: plaza.position.z + Math.sin(angle) * plaza.radius * radial,
      };
      // 中央円の外(位置の条件。契約 D3 実装補足)
      const distC = Math.hypot(p.x - plaza.position.x, p.z - plaza.position.z);
      if (distC < centerR) continue;
      // 縁帯(屋台の帯)より内側(広場縁から 2.7 以上)
      if (polygonSignedDistance(p.x, p.z, plaza.polygon) > -WELL_EDGE_MIN) {
        continue;
      }
      // 通行帯セクター外
      if (inTrafficSector(angle, trafficAzimuths)) continue;
      // footprint 全コーナーが polygon 内
      if (!cornersInsidePlaza(squareFootprint(p, WELL_FOOT_HALF, angle), plaza, 0.05)) {
        continue;
      }
      pos = p;
      break outer;
    }
  }
  if (!pos) return null;

  // facing = 井戸位置 → 広場中心(既定規約)± 揺らぎ(D1b。facing へ畳み込む)
  const baseFacing = Math.atan2(plaza.position.z - pos.z, plaza.position.x - pos.x);
  const facing = baseFacing + rng.range(-WELL_FACING_JITTER, WELL_FACING_JITTER);
  const parts = buildWellParts({ center: pos, facing, rng });
  return {
    id: `facility/well/${plaza.id}`,
    kind: "well",
    footprint: ensureClockwise(squareFootprint(pos, WELL_FOOT_HALF, facing)),
    facing,
    parts,
    origin: { type: "plaza", plazaId: plaza.id },
  };
}

/**
 * 広場の屋台列の生成(段14 の本番ループとギャラリーが共用。契約
 * 「stall(屋台)」D3 実装補足)。
 *
 * 配置スロットは決定論の等角走査(乱数非消費)。乱数は配置が確定した
 * 屋台の造形バリエーションのみに、`facility/stall/<plazaId>` から
 * 連番消費する(1 屋台 3 ロール固定)。
 */
export function buildPlazaStallFacilities(
  seed: string,
  prosper: number,
  plaza: Plaza,
  trafficAzimuths: readonly number[],
): Facility[] {
  const stallCount = Math.round(Math.min(12, Math.max(3, 3 + 9 * prosper)));
  const bandCenter = (PLAZA_EDGE_BAND + PLAZA_EDGE_BAND_OUTER) / 2;
  const bandRadius = Math.max(1, plaza.radius - bandCenter);
  const slots = Math.max(8, Math.floor((Math.PI * 2 * bandRadius) / STALL_SLOT_PITCH));
  const rng = makeRng(seed, `facility/stall/${plaza.id}`);

  const out: Facility[] = [];
  const placed: Vec2[] = [];
  for (let k = 0; k < slots && out.length < stallCount; k++) {
    const angle = (k / slots) * Math.PI * 2;
    if (inTrafficSector(angle, trafficAzimuths)) continue;
    const rim = rayDistanceToPolygon(plaza.position, angle, plaza.polygon, plaza.radius);
    const dist = rim - bandCenter;
    if (dist <= 0) continue;
    const pos: Vec2 = {
      x: plaza.position.x + Math.cos(angle) * dist,
      z: plaza.position.z + Math.sin(angle) * dist,
    };
    // 縁帯の実距離(polygon の非円形ぶんの検算)
    const edgeDist = -polygonSignedDistance(pos.x, pos.z, plaza.polygon);
    if (edgeDist < PLAZA_EDGE_BAND || edgeDist > PLAZA_EDGE_BAND_OUTER) continue;
    // 既配置の屋台との間隔
    let tooClose = false;
    for (const q of placed) {
      if (Math.hypot(q.x - pos.x, q.z - pos.z) < STALL_MIN_SPACING) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    // facing = 広場中心向き(既定規約)。footprint 全コーナーが polygon 内
    const facing = Math.atan2(plaza.position.z - pos.z, plaza.position.x - pos.x);
    const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
    const s: Vec2 = { x: -f.z, z: f.x };
    const footprint = rectFootprint(pos, f, s, STALL_FOOT_W / 2, STALL_FOOT_D / 2);
    if (!cornersInsidePlaza(footprint, plaza, 0.05)) continue;

    const parts = buildStallParts({ center: pos, facing, rng });
    out.push({
      id: `facility/stall/${plaza.id}/${out.length}`,
      kind: "stall",
      footprint: ensureClockwise(footprint),
      facing,
      parts,
      origin: { type: "plaza", plazaId: plaza.id },
    });
    placed.push(pos);
  }
  return out;
}

/** 農村井戸の汎用クリアランス検査に使う周辺環境 */
interface RuralWellContext {
  model: WorldModel;
  waterBodySdf: (x: number, z: number) => number;
  canalSdf: (x: number, z: number) => number;
  boundaryInside: (x: number, z: number) => number;
  nodeDegree: Map<string, number>;
}

function buildRuralWellContext(model: WorldModel): RuralWellContext {
  const site = createSiteContext(model);
  const nodeDegree = new Map<string, number>();
  for (const edge of model.network.edges) {
    nodeDegree.set(edge.from, (nodeDegree.get(edge.from) ?? 0) + 1);
    nodeDegree.set(edge.to, (nodeDegree.get(edge.to) ?? 0) + 1);
  }
  return {
    model,
    waterBodySdf: site.waterBodySdf,
    canalSdf: site.canalSdf,
    boundaryInside: site.boundaryInside,
    nodeDegree,
  };
}

/** 農村井戸の候補位置が汎用クリアランス(契約「衝突・帯検証則」)を満たすか */
function ruralWellSiteOk(
  ctx: RuralWellContext,
  center: Vec2,
  facilities: readonly Facility[],
): boolean {
  const { model } = ctx;
  const h = WELL_FOOT_HALF;
  // プローブ: 角 4 + 辺中点 4 + 中心 1(区画・建物の衝突検査と同じ流儀)
  const probes: Vec2[] = [center];
  for (const [du, dv] of [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
    [0, -h],
    [h, 0],
    [0, h],
    [-h, 0],
  ] as const) {
    probes.push({ x: center.x + du, z: center.z + dv });
  }
  const ring = model.wards.ringPath;
  for (const p of probes) {
    if (ctx.boundaryInside(p.x, p.z) < CLEAR_BOUNDARY) return false;
    if (ctx.waterBodySdf(p.x, p.z) < CLEAR_WATER) return false;
    if (ctx.canalSdf(p.x, p.z) < CLEAR_WATER) return false;
    for (const edge of model.network.edges) {
      if (distToPolyline(p.x, p.z, edge.path) < edge.width / 2 + CLEAR_ROAD) {
        return false;
      }
    }
    for (const parcel of model.parcels) {
      if (polygonSignedDistance(p.x, p.z, parcel.polygon) < CLEAR_PARCEL) {
        return false;
      }
    }
    for (const plaza of model.plazas) {
      if (polygonSignedDistance(p.x, p.z, plaza.polygon) < CLEAR_PLAZA) {
        return false;
      }
    }
    for (const facility of facilities) {
      if (polygonSignedDistance(p.x, p.z, facility.footprint) < CLEAR_FACILITY) {
        return false;
      }
    }
    if (model.wards.wardLevel >= 1 && ring.length >= 3) {
      if (Math.abs(polygonSignedDistance(p.x, p.z, ring)) < RING_BUFFER) {
        return false;
      }
    }
    const foot = model.centerPlan.footprint;
    if (foot.length >= 3) {
      if (polygonSignedDistance(p.x, p.z, foot) < CLEAR_CENTER) return false;
    }
  }
  return true;
}

/**
 * 農村井戸の生成(契約「well(井戸)」(b)・D3 実装補足)。
 * 消費列(固定): 採否 chance → 造形(D1b。位置は決定論走査で乱数非消費)。
 */
function buildRuralWellFacility(
  ctx: RuralWellContext,
  node: { id: string; position: Vec2 },
  settle: number,
  facilities: readonly Facility[],
): Facility | null {
  const { model } = ctx;
  const rng = makeRng(model.meta.seed, `facility/well/${node.id}`);
  const rate = Math.min(0.4, Math.max(0.05, 0.05 + 0.35 * settle));
  if (!rng.chance(rate)) return null;

  // 決定論走査: 8 方位 × 距離 3 段の最初の合格点(乱数非消費)
  let pos: Vec2 | null = null;
  outer: for (const d of RURAL_WELL_DISTANCES) {
    for (let k = 0; k < RURAL_WELL_DIRECTIONS; k++) {
      const angle = (k / RURAL_WELL_DIRECTIONS) * Math.PI * 2;
      const p: Vec2 = {
        x: node.position.x + Math.cos(angle) * d,
        z: node.position.z + Math.sin(angle) * d,
      };
      if (!ruralWellSiteOk(ctx, p, facilities)) continue;
      pos = p;
      break outer;
    }
  }
  if (!pos) return null;

  // facing = 井戸位置 → ノード(道路の方を向く)± 揺らぎ
  const baseFacing = Math.atan2(node.position.z - pos.z, node.position.x - pos.x);
  const facing = baseFacing + rng.range(-WELL_FACING_JITTER, WELL_FACING_JITTER);
  const parts = buildWellParts({ center: pos, facing, rng });
  return {
    id: `facility/well/${node.id}`,
    kind: "well",
    footprint: ensureClockwise(squareFootprint(pos, WELL_FOOT_HALF, facing)),
    facing,
    parts,
    origin: { type: "node", nodeId: node.id },
  };
}

/**
 * 施設 parts の footprint 帯検証(契約「衝突・帯検証則」: 全 parts は
 * footprint から 0.9 を超えてはみ出さない)。部品の回転込みの 4 隅で
 * 保守的に判定する。
 */
function partBandViolations(facility: Facility): number {
  let violations = 0;
  for (const part of facility.parts) {
    const [px, , pz] = part.transform.position;
    const [sx, , sz] = part.transform.scale;
    const cos = Math.cos(part.transform.rotation);
    const sin = Math.sin(part.transform.rotation);
    // canopy はローカル z が 0(高い縁 = position)〜 +1(低い縁)の
    // 非対称レンジ(契約「施設部品の語彙」の position 規約)
    const z0 = part.type === "canopy" ? 0 : -sz / 2;
    const z1 = part.type === "canopy" ? sz : sz / 2;
    for (const [lx, lz] of [
      [-sx / 2, z0],
      [sx / 2, z0],
      [sx / 2, z1],
      [-sx / 2, z1],
    ] as const) {
      const x = px + lx * cos + lz * sin;
      const z = pz - lx * sin + lz * cos;
      if (polygonSignedDistance(x, z, facility.footprint) > PART_BAND) {
        violations++;
      }
    }
  }
  return violations;
}

/**
 * パイプライン段の実体: facilities を埋める(他フィールドには触れない。
 * contracts/pipeline.md 段14)。配列順序は契約「Facility スキーマ」の
 * 走査順: field/pasture(farmland 区画の parcels 配列順)→ well
 * (広場 = plazas 配列順、続いて農村 = network.nodes 配列順)→ stall
 * (plazas 配列順)。
 */
export function runFacilities(model: WorldModel): void {
  const seed = model.meta.seed;
  const { settlement, prosperity } = model.meta.params;
  const settle = settlement / 100;
  const prosper = prosperity / 100;
  const facilities: Facility[] = [];

  // --- field / pasture(D2b) ---
  for (const parcel of model.parcels) {
    if (parcel.kind !== "farmland") continue;
    facilities.push(buildFarmlandFacility(seed, parcel));
  }

  // --- well: 市街の広場(center / crossing。plazas 配列順) ---
  const plazaAzimuths = new Map<string, number[]>();
  const marketPlazas = model.plazas.filter(
    (p) => p.kind === "center" || p.kind === "crossing",
  );
  for (const plaza of marketPlazas) {
    plazaAzimuths.set(plaza.id, plazaInflowAzimuths(model, plaza));
  }
  for (const plaza of marketPlazas) {
    const well = buildPlazaWellFacility(
      seed,
      settle,
      plaza,
      plazaAzimuths.get(plaza.id) ?? [],
    );
    if (well) facilities.push(well);
  }

  // --- well: 農村の道路ノード(network.nodes 配列順。採択総数に上限) ---
  const ruralCtx = buildRuralWellContext(model);
  const ruralWellCountMax = Math.ceil(2 + 4 * settle);
  let ruralWells = 0;
  for (const node of model.network.nodes) {
    if (ruralWells >= ruralWellCountMax) break;
    const degree = ruralCtx.nodeDegree.get(node.id) ?? 0;
    if (degree > 2) continue;
    const urbanity = model.zoning
      ? sampleFieldGrid(model.zoning, node.position.x, node.position.z)
      : 0;
    if (urbanity >= RURAL_URBANITY) continue;
    const well = buildRuralWellFacility(ruralCtx, node, settle, facilities);
    if (well) {
      facilities.push(well);
      ruralWells++;
    }
  }

  // --- stall: 市街の広場の縁帯(plazas 配列順) ---
  for (const plaza of marketPlazas) {
    facilities.push(
      ...buildPlazaStallFacilities(
        seed,
        prosper,
        plaza,
        plazaAzimuths.get(plaza.id) ?? [],
      ),
    );
  }

  model.facilities = facilities;

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  let violations = 0;
  const farmlandCount = model.parcels.filter(
    (p) => p.kind === "farmland",
  ).length;
  const farmFacilities = facilities.filter(
    (f) => f.kind === "field" || f.kind === "pasture",
  ).length;
  if (farmFacilities !== farmlandCount) violations++;
  if (facilities.filter((f) => f.kind === "well" && f.origin.type === "node").length > ruralWellCountMax) {
    violations++;
  }
  for (const facility of facilities) {
    if (facility.parts.length === 0) violations++;
    violations += partBandViolations(facility);
  }
  if (violations > 0) {
    console.warn(`facilities: パイプライン内アサーション違反 ${violations} 件`);
  }
}
