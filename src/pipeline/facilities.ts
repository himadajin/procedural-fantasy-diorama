/**
 * 段14「施設」: 施設(Facility)の生成(Phase D。
 * `docs/internal/plans/2026-07-14-worldgen-rework-facilities.md`)。
 * 契約の正は docs/internal/contracts/facilities.md(kind 一覧・配置条件・
 * 衝突/帯検証則・RNG ラベル体系・造形の純関数分離・kind ごとの造形の性質)。
 *
 * D2b: field(畑)/ pasture(牧草地)— farmland 区画への生成。
 * D3: well(井戸)/ stall(市場屋台)— 市街広場・農村道路ノードへの生成。
 * D4: windmill(風車)/ watermill(水車)— 農村外縁・水路/湖岸への生成。
 * D5: pier(桟橋)— 汀線ループ沿い(waterfront claimed 検査へ読み取り参加)。
 *
 * 造形は「入力(寸法・向き・当該施設の rng サブストリーム)→ Part[]」の
 * 純関数(buildXxxParts)として配置ロジックから分離する(契約 3.8b。
 * ギャラリーは buildFarmlandFacility / buildPlazaWellFacility /
 * buildPlazaStallFacilities を経由してこの本番の造形関数のみを呼ぶ)。
 * 乱数は新設ストリーム `"facility/<...>"` のみを消費し、既存ストリームの
 * 消費列は変えない。
 */
import { makeRng, type Rng } from "../rng";
import {
  SHORE_SKIRT_BOTTOM_Y,
  type BridgeSite,
  type Facility,
  type Parcel,
  type Part,
  type Plaza,
  type Vec2,
  type WorldModel,
} from "../model/worldmodel";
import { distToPolyline, polygonSignedDistance } from "../model/waterfield";
import { sampleFieldGrid } from "../model/fieldgrid";
import { ensureClockwise, polygonsOverlap } from "../model/geometry";
import { createSiteContext } from "./parcels";
import { waterfrontClaimedRegions } from "./buildings";

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

/**
 * 汎用クリアランス(契約「衝突・帯検証則」)のプローブ検査。
 * waterClear = null は水域(湖・池・水路)の帯検査をスキップする
 * (watermill の水域例外 — 陸上判定は呼び出し側が別途行う)。
 */
function facilitySiteOk(
  ctx: RuralWellContext,
  probes: readonly Vec2[],
  facilities: readonly Facility[],
  waterClear: number | null,
): boolean {
  const { model } = ctx;
  const ring = model.wards.ringPath;
  for (const p of probes) {
    if (ctx.boundaryInside(p.x, p.z) < CLEAR_BOUNDARY) return false;
    if (waterClear !== null) {
      if (ctx.waterBodySdf(p.x, p.z) < waterClear) return false;
      if (ctx.canalSdf(p.x, p.z) < waterClear) return false;
    }
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

/** 矩形 footprint のプローブ(角 4 + 辺中点 4 + 中心 1) */
function rectProbes(footprint: readonly Vec2[], center: Vec2): Vec2[] {
  const probes: Vec2[] = [center];
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % footprint.length];
    if (!a || !b) continue;
    probes.push({ x: a.x, z: a.z });
    probes.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  }
  return probes;
}

/** 農村井戸の候補位置が汎用クリアランスを満たすか */
function ruralWellSiteOk(
  ctx: RuralWellContext,
  center: Vec2,
  facilities: readonly Facility[],
): boolean {
  const h = WELL_FOOT_HALF;
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
  return facilitySiteOk(ctx, probes, facilities, CLEAR_WATER);
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

// --- windmill / watermill の造形数値(すべて提案値。contracts/facilities.md
//     「kind ごとの造形の性質」D1b。調整時は契約を同一 commit で更新する) ---
/** 風車: 塔身(底辺・taper・高さと ±8% 揺らぎ) */
const WINDMILL_TOWER_BASE = 3.4;
const WINDMILL_TOWER_TAPER = 0.72;
const WINDMILL_TOWER_H = 7.5;
/** 風車: キャップ(棟長 × スパン・pitch 50。棟 = ロータ軸方向) */
const WINDMILL_CAP_RIDGE = 3.0;
const WINDMILL_CAP_SPAN = 2.8;
const WINDMILL_CAP_PITCH = 50;
/** 風車: ロータ(直径 9.0 ±8%。ハブ = 妻面から 0.6 前・y = 塔高 + 0.4) */
const WINDMILL_ROTOR_DIA = 9.0;
const WINDMILL_HUB_FORWARD = WINDMILL_CAP_RIDGE / 2 + 0.6;
const WINDMILL_HUB_RISE = 0.4;
const WINDMILL_HUB_DEPTH = 0.6;
/** 風車: footprint(長軸 = ロータ直径 + 0.6、短軸 4.6。塔中心基準) */
const WINDMILL_FOOT_LONG_PAD = 0.6;
const WINDMILL_FOOT_SHORT = 4.6;
/** 風車: 扉・窓(正面。塔の taper に沿って壁面へ寄せる) */
const WINDMILL_DOOR_W = 1.05;
const WINDMILL_DOOR_H = 2.15;
const WINDMILL_WINDOW_W = 0.7;
const WINDMILL_WINDOW_H = 0.9;
const WINDMILL_WINDOW_Y = 4.5;
/** 風車: 配置(外縁帯 = marginWidth × [0.3, 1.8)・格子 = marginWidth・水域 4.5) */
const WINDMILL_BAND_INNER = 0.3;
const WINDMILL_BAND_OUTER = 1.8;
const WINDMILL_WATER_CLEAR = 4.5;

/** 水車: 小屋(梁間 3.6 × 桁行 4.2〜5.0・基壇 0.2・壁高 3.0・pitch 52) */
const WATERMILL_HUT_D = 3.6;
const WATERMILL_HUT_LEN_MIN = 4.2;
const WATERMILL_HUT_LEN_MAX = 5.0;
const WATERMILL_PLINTH_H = 0.2;
const WATERMILL_WALL_H = 3.0;
const WATERMILL_ROOF_PITCH = 52;
/** 水車: 軒の張り出し(スパン側 0.65 / 妻側 0.4。建物の流儀) */
const WATERMILL_EAVE = 0.65;
const WATERMILL_GABLE_OVERHANG = 0.4;
/** 水車: 水輪(直径 3.0 ±8%・幅 0.7・軸 y 0.70・壁面から隙間 0.12) */
const WATERMILL_WHEEL_DIA = 3.0;
const WATERMILL_WHEEL_W = 0.7;
const WATERMILL_AXLE_Y = 0.7;
const WATERMILL_WHEEL_GAP = 0.12;
/** 水車: 軸(0.18 角・長さ 1.3) */
const WATERMILL_AXLE_SIZE = 0.18;
const WATERMILL_AXLE_LEN = 1.3;
/** 水車: 配置(水路の弧長刻み・小屋中心の水際からのオフセット・ジッター) */
const WATERMILL_CANAL_STEP = 8.0;
const WATERMILL_CANAL_OFFSET_PAD = 1.95;
const WATERMILL_SHORE_OFFSET = 2.0;
const WATERMILL_JITTER = 2.0;

/** 風車の造形純関数の入力(塔高・直径は配置側が消費済み。D4 実装補足) */
export interface WindmillShapeInput {
  center: Vec2;
  facing: number;
  towerH: number;
  rotorDia: number;
  /** 当該施設の rng(ジッター・塔高・直径の続き。初期回転角を消費する) */
  rng: Rng;
}

/**
 * 風車(windmill)の造形純関数(契約「windmill(風車)」)。
 * parts 配列順: 塔身 1 → キャップ 1 → ロータ 1 → 扉 1 → 窓 1。
 * rng 消費: (3) 初期回転角(0〜90°)のみ(塔高・直径は配置側)。
 */
export function buildWindmillParts(input: WindmillShapeInput): Part[] {
  const { center, facing, towerH, rotorDia, rng } = input;
  const phase = rng.range(0, Math.PI / 2);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const at = (u: number, v: number): Vec2 => ({
    x: center.x + s.x * u + f.x * v,
    z: center.z + s.z * u + f.z * v,
  });
  const rotAlongF = Math.atan2(-f.z, f.x); // ローカル +x → f
  const rotFaceF = Math.atan2(f.x, f.z); // ローカル +z → f(開口・ロータ)

  // 塔の taper に沿った半幅(y での壁面位置。扉・窓を壁へ寄せるため)
  const halfBase = WINDMILL_TOWER_BASE / 2;
  const halfAt = (y: number): number =>
    halfBase - halfBase * (1 - WINDMILL_TOWER_TAPER) * (y / towerH);

  const parts: Part[] = [];
  // 塔身(石。先細りの角柱)
  parts.push(
    makePart(
      "tower",
      "stone",
      center,
      0,
      rotAlongF,
      WINDMILL_TOWER_BASE,
      towerH,
      WINDMILL_TOWER_BASE,
      { taper: WINDMILL_TOWER_TAPER },
    ),
  );
  // キャップ(木羽の切妻。棟 = ロータ軸方向)
  const capRidgeH =
    Math.tan((WINDMILL_CAP_PITCH * Math.PI) / 180) * (WINDMILL_CAP_SPAN / 2);
  parts.push(
    makePart(
      "gable",
      "shingle",
      center,
      towerH,
      rotAlongF,
      WINDMILL_CAP_RIDGE,
      capRidgeH,
      WINDMILL_CAP_SPAN,
      { pitch: WINDMILL_CAP_PITCH },
    ),
  );
  // ロータ(帆布の羽根 4 枚。position = ハブ中心。回転は viewer の表示演出)
  parts.push(
    makePart(
      "windmill-rotor",
      "canvas",
      at(0, WINDMILL_HUB_FORWARD),
      towerH + WINDMILL_HUB_RISE,
      rotFaceF,
      rotorDia,
      rotorDia,
      WINDMILL_HUB_DEPTH,
      { blades: 4, phase },
    ),
  );
  // 扉・窓(正面。開口部品の変換規約 — 壁面上の開口下端中心・+z = 外向き)
  const doorPlane = halfAt(WINDMILL_DOOR_H / 2) - 0.03;
  parts.push(
    makePart(
      "door",
      "wood",
      at(0, doorPlane),
      0,
      rotFaceF,
      WINDMILL_DOOR_W,
      WINDMILL_DOOR_H,
      0.18,
    ),
  );
  const windowPlane = halfAt(WINDMILL_WINDOW_Y + WINDMILL_WINDOW_H / 2) - 0.03;
  parts.push(
    makePart(
      "window",
      "wood",
      at(0, windowPlane),
      WINDMILL_WINDOW_Y,
      rotFaceF,
      WINDMILL_WINDOW_W,
      WINDMILL_WINDOW_H,
      0.16,
    ),
  );
  return parts;
}

/** 水車の造形純関数の入力(桁行は配置側が消費済み。D4 実装補足) */
export interface WatermillShapeInput {
  center: Vec2;
  /** 正面方位(水面へ向く。水側の壁面と水輪がこちら) */
  facing: number;
  /** 桁行(岸線・水路方向の小屋の長さ) */
  hutLen: number;
  /** 当該施設の rng(ジッター・桁行の続き。水輪直径 → 初期回転角) */
  rng: Rng;
}

/**
 * 水車(watermill)の造形純関数(契約「watermill(水車)」)。
 * parts 配列順: 基壇 1 → 壁 1 → 屋根 1 → 扉 1 → 窓 1 → 軸 1 → 水輪 1。
 * rng 消費(列挙順): (2) 水輪直径 ±8% → (3) 初期回転角(0〜45°)。
 */
export function buildWatermillParts(input: WatermillShapeInput): Part[] {
  const { center, facing, hutLen, rng } = input;
  const wheelDia = WATERMILL_WHEEL_DIA * rng.range(0.92, 1.08);
  const phase = rng.range(0, Math.PI / 4);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const at = (u: number, v: number): Vec2 => ({
    x: center.x + s.x * u + f.x * v,
    z: center.z + s.z * u + f.z * v,
  });
  const rotAlongS = Math.atan2(-s.z, s.x); // ローカル +x → s(桁行方向)
  const rotAlongF = Math.atan2(-f.z, f.x); // ローカル +x → f(軸・水輪)
  const halfD = WATERMILL_HUT_D / 2;

  const parts: Part[] = [];
  // 基壇(石)→ 壁(粗い木の平屋)→ 屋根(木羽。棟 = 桁行方向)
  parts.push(
    makePart(
      "plinth",
      "stone",
      center,
      0,
      rotAlongS,
      hutLen,
      WATERMILL_PLINTH_H,
      WATERMILL_HUT_D,
    ),
  );
  parts.push(
    makePart(
      "wall",
      "rough-wood",
      center,
      WATERMILL_PLINTH_H,
      rotAlongS,
      hutLen,
      WATERMILL_WALL_H,
      WATERMILL_HUT_D,
      { floor: 0 },
    ),
  );
  const roofSpan = WATERMILL_HUT_D + WATERMILL_EAVE * 2;
  const roofRidgeH =
    Math.tan((WATERMILL_ROOF_PITCH * Math.PI) / 180) * (roofSpan / 2);
  parts.push(
    makePart(
      "gable",
      "shingle",
      center,
      WATERMILL_PLINTH_H + WATERMILL_WALL_H - 0.05,
      rotAlongS,
      hutLen + WATERMILL_GABLE_OVERHANG * 2,
      roofRidgeH,
      roofSpan,
      { pitch: WATERMILL_ROOF_PITCH },
    ),
  );
  // 扉(陸側の長辺)・窓(妻面)
  parts.push(
    makePart(
      "door",
      "wood",
      at(0, -halfD),
      WATERMILL_PLINTH_H,
      Math.atan2(-f.x, -f.z), // +z → −f(陸側)
      1.0,
      2.15,
      0.18,
    ),
  );
  parts.push(
    makePart(
      "window",
      "wood",
      at(hutLen / 2, 0),
      1.6,
      Math.atan2(s.x, s.z), // +z → +s(妻面)
      0.7,
      0.9,
      0.16,
    ),
  );
  // 軸(壁を貫いて水輪ハブへ)と水輪(濡れ木。position = 軸中点)
  const hubV = halfD + WATERMILL_WHEEL_GAP + WATERMILL_WHEEL_W / 2;
  parts.push(
    makePart(
      "beam",
      "wood",
      at(0, hubV - WATERMILL_AXLE_LEN / 2 + 0.25),
      WATERMILL_AXLE_Y - WATERMILL_AXLE_SIZE / 2,
      rotAlongF,
      WATERMILL_AXLE_LEN,
      WATERMILL_AXLE_SIZE,
      WATERMILL_AXLE_SIZE,
    ),
  );
  parts.push(
    makePart(
      "water-wheel",
      "wet-wood",
      at(0, hubV),
      WATERMILL_AXLE_Y,
      rotAlongF,
      WATERMILL_WHEEL_W,
      wheelDia,
      wheelDia,
      { paddles: 8, phase },
    ),
  );
  return parts;
}

/**
 * 風車 1 基の生成(段14 の本番ループとギャラリーが共用。契約「windmill」
 * D4 実装補足)。消費列(固定): 格子内ジッター 2 → 塔高 → ロータ直径 →
 * 造形(初期回転角)。位置はセル原点+ジッター、facing は呼び出し側が
 * 決める(本番 = centerPlan へ向く方位)。
 */
export function buildWindmillFacility(
  seed: string,
  ix: number,
  iz: number,
  cellOrigin: Vec2,
  cellSize: number,
  facingOf: (pos: Vec2) => number,
): Facility {
  const rng = makeRng(seed, `facility/windmill/${ix}_${iz}`);
  const pos: Vec2 = {
    x: cellOrigin.x + rng.next() * cellSize,
    z: cellOrigin.z + rng.next() * cellSize,
  };
  const towerH = WINDMILL_TOWER_H * rng.range(0.92, 1.08);
  const rotorDia = WINDMILL_ROTOR_DIA * rng.range(0.92, 1.08);
  const facing = facingOf(pos);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const footprint = rectFootprint(
    pos,
    f,
    s,
    (rotorDia + WINDMILL_FOOT_LONG_PAD) / 2,
    WINDMILL_FOOT_SHORT / 2,
  );
  const parts = buildWindmillParts({ center: pos, facing, towerH, rotorDia, rng });
  return {
    id: `facility/windmill/${ix}_${iz}`,
    kind: "windmill",
    footprint: ensureClockwise(footprint),
    facing,
    parts,
    origin: { type: "site", cellId: `${ix}_${iz}` },
  };
}

/**
 * 水車 1 基の生成(段14 の本番ループとギャラリーが共用。契約「watermill」
 * D4 実装補足)。消費列(固定): 位置ジッター(接線方向 ±2.0。revalidate が
 * 通らなければ基点へ戻す)→ 桁行 → 造形(水輪直径 → 初期回転角)。
 */
export function buildWatermillFacility(
  seed: string,
  rngLabel: string,
  facilityId: string,
  origin: Facility["origin"],
  base: Vec2,
  tangent: Vec2,
  facing: number,
  revalidate: ((center: Vec2) => boolean) | null,
): Facility {
  const rng = makeRng(seed, rngLabel);
  const jitter = rng.range(-WATERMILL_JITTER, WATERMILL_JITTER);
  let center: Vec2 = {
    x: base.x + tangent.x * jitter,
    z: base.z + tangent.z * jitter,
  };
  if (revalidate && !revalidate(center)) center = base;
  const hutLen = rng.range(WATERMILL_HUT_LEN_MIN, WATERMILL_HUT_LEN_MAX);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const footprint = rectFootprint(center, f, s, hutLen / 2, WATERMILL_HUT_D / 2);
  const parts = buildWatermillParts({ center, facing, hutLen, rng });
  return {
    id: facilityId,
    kind: "watermill",
    footprint: ensureClockwise(footprint),
    facing,
    parts,
    origin,
  };
}

// --- pier の造形数値(すべて提案値。contracts/facilities.md
//     「kind ごとの造形の性質」D1b。調整時は契約を同一 commit で更新する) ---
/** 桟橋: 板(幅 1.8 ±0.2 × 長さ 6〜10 × 床厚 0.22。天端 y 0.35) */
const PIER_DECK_W = 1.8;
const PIER_DECK_W_JITTER = 0.2;
const PIER_LEN_MIN = 6;
const PIER_LEN_MAX = 10;
const PIER_DECK_TOP_Y = 0.35;
const PIER_DECK_T = 0.22;
/** 桟橋: 杭(0.22 角・間隔 2.4 のペア。板端からの寄り) */
const PIER_PILE_SIZE = 0.22;
const PIER_PILE_SPACING = 2.4;
const PIER_PILE_END_INSET = 0.35;
/** 桟橋: 先端の係船柱(chance 0.7 で天端 y 0.90 = 板の上に 0.55) */
const PIER_BOLLARD_TOP_Y = 0.9;
const PIER_BOLLARD_CHANCE = 0.7;
/** 桟橋: 陸側端 = 汀線から 1.0 内陸 */
const PIER_LAND_OVERLAP = 1.0;

// --- pier の配置数値(契約「pier(桟橋)」D5 実装補足。すべて提案値) ---
/** 桟橋どうしのアンカー間隔(実寸) */
const PIER_SPACING = 8.0;
/** 位置ジッター(接線方向 ±2.0。watermill と同じ流儀) */
const PIER_JITTER = 2.0;
/** 適格条件 (a): waterside 建物 footprint からの距離 */
const PIER_NEAR_WATERSIDE = 14;
/** 保守的検証 (2): アンカーから水側のプローブ距離(全点が水面) */
const PIER_WATER_PROBES = [3.5, 6.0, 9.0] as const;
/** 橋(BridgeSite 矩形)・水路縁からのクリアランス */
const PIER_CLEAR_BRIDGE = 1.0;
const PIER_CLEAR_CANAL = 1.0;

/** 桟橋の造形純関数の入力(長さ・幅は配置側が消費済み。D5 実装補足) */
export interface PierShapeInput {
  /** 陸側端(板の陸側の縁の中点。汀線から 1.0 内陸) */
  landEnd: Vec2;
  /** 正面方位(陸 → 水域。板はこちらへ伸びる) */
  facing: number;
  /** 板の長さ(6〜10) */
  length: number;
  /** 板の幅(1.8 ±0.2) */
  width: number;
  /** 当該施設の rng(ジッター・長さ・幅の続き。係船柱の有無を消費する) */
  rng: Rng;
}

/**
 * 桟橋(pier)の造形純関数(契約「pier(桟橋)」)。
 * parts 配列順: 板 1 → 杭(陸側ペアから先端ペアへ。ペア内は −s → +s)。
 * rng 消費: (3) 係船柱の有無(chance 0.7)のみ(長さ・幅は配置側)。
 */
export function buildPierParts(input: PierShapeInput): Part[] {
  const { landEnd, facing, length, width, rng } = input;
  const bollard = rng.chance(PIER_BOLLARD_CHANCE);
  const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
  const s: Vec2 = { x: -f.z, z: f.x };
  const at = (u: number, v: number): Vec2 => ({
    x: landEnd.x + s.x * u + f.x * v,
    z: landEnd.z + s.z * u + f.z * v,
  });
  const rotF = Math.atan2(-f.z, f.x); // ローカル +x = 長手方向(契約の deck 規約)

  const parts: Part[] = [];
  // 板(deck。粗い木 — 風化した板の読み。天端 0.35 = 建物デッキより低い)
  const deckBottom = PIER_DECK_TOP_Y - PIER_DECK_T;
  parts.push(
    makePart(
      "deck",
      "rough-wood",
      at(0, length / 2),
      deckBottom,
      rotF,
      length,
      PIER_DECK_T,
      width,
    ),
  );
  // 杭(板の両縁に面一のペア。y = −1.6(岸スカート下端)から板下端まで。
  // 先端ペアのみ係船柱(chance 0.7)で天端 y 0.90 へ伸ばす)
  const pileU = width / 2 - PIER_PILE_SIZE / 2;
  const span = length - PIER_PILE_END_INSET * 2;
  const pairs = Math.max(2, Math.ceil(span / PIER_PILE_SPACING) + 1);
  for (let k = 0; k < pairs; k++) {
    const v = PIER_PILE_END_INSET + (span * k) / (pairs - 1);
    const isTip = k === pairs - 1;
    const topY = isTip && bollard ? PIER_BOLLARD_TOP_Y : deckBottom;
    for (const u of [-pileU, pileU]) {
      parts.push(
        makePart(
          "pile",
          "wood",
          at(u, v),
          SHORE_SKIRT_BOTTOM_Y,
          rotF,
          PIER_PILE_SIZE,
          topY - SHORE_SKIRT_BOTTOM_Y,
          PIER_PILE_SIZE,
        ),
      );
    }
  }
  return parts;
}

/**
 * 桟橋 1 基の生成(段14 の本番ループとギャラリーが共用。契約「pier」
 * D5 実装補足)。消費列(固定): 位置ジッター(接線方向 ±2.0。revalidate が
 * 通らなければ基点へ戻す)→ 長さ → 幅 → 造形(係船柱の有無)。
 * normal は汀線法線(水域 → 陸)。facing はその逆(陸 → 水域)。
 */
export function buildPierFacility(
  seed: string,
  loopId: string,
  index: number,
  point: Vec2,
  tangent: Vec2,
  normal: Vec2,
  revalidate: ((anchor: Vec2) => boolean) | null,
): Facility {
  const rng = makeRng(seed, `facility/pier/${loopId}/${index}`);
  const jitter = rng.range(-PIER_JITTER, PIER_JITTER);
  let anchor: Vec2 = {
    x: point.x + tangent.x * jitter,
    z: point.z + tangent.z * jitter,
  };
  if (revalidate && !revalidate(anchor)) anchor = point;
  const length = rng.range(PIER_LEN_MIN, PIER_LEN_MAX);
  const width =
    PIER_DECK_W + rng.range(-PIER_DECK_W_JITTER, PIER_DECK_W_JITTER);
  const facing = Math.atan2(-normal.z, -normal.x);
  const f: Vec2 = { x: -normal.x, z: -normal.z };
  const s: Vec2 = { x: -f.z, z: f.x };
  const landEnd: Vec2 = {
    x: anchor.x + normal.x * PIER_LAND_OVERLAP,
    z: anchor.z + normal.z * PIER_LAND_OVERLAP,
  };
  const center: Vec2 = {
    x: landEnd.x + (f.x * length) / 2,
    z: landEnd.z + (f.z * length) / 2,
  };
  // footprint = 板の矩形(杭は縁に面一のため「板+杭の外形」と一致)
  const footprint = rectFootprint(center, f, s, width / 2, length / 2);
  const parts = buildPierParts({ landEnd, facing, length, width, rng });
  return {
    id: `facility/pier/${loopId}/${index}`,
    kind: "pier",
    footprint: ensureClockwise(footprint),
    facing,
    parts,
    origin: { type: "shore", shoreLoopId: loopId, index },
  };
}

/** 橋(BridgeSite)の外形矩形(桟橋のクリアランス検査用) */
function bridgeRect(bridge: BridgeSite): Vec2[] {
  const f: Vec2 = { x: Math.cos(bridge.angle), z: Math.sin(bridge.angle) };
  const s: Vec2 = { x: -f.z, z: f.x };
  return rectFootprint(bridge.position, f, s, bridge.width / 2, bridge.length / 2);
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

/** ポリライン上の弧長 s の点と接線(watermill の水路候補走査) */
function pointAndTangentAlong(
  points: readonly Vec2[],
  s: number,
): { point: Vec2; tangent: Vec2 } | null {
  let remain = s;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-9) continue;
    if (remain <= len) {
      const t = remain / len;
      return {
        point: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t },
        tangent: { x: (b.x - a.x) / len, z: (b.z - a.z) / len },
      };
    }
    remain -= len;
  }
  return null;
}

/**
 * パイプライン段の実体: facilities を埋める(他フィールドには触れない。
 * contracts/pipeline.md 段14)。配列順序は契約「Facility スキーマ」の
 * 走査順: field/pasture(farmland 区画の parcels 配列順)→ well
 * (広場 = plazas 配列順、続いて農村 = network.nodes 配列順)→ stall
 * (plazas 配列順)→ windmill(格子順)→ watermill(水路 → 湖岸)。
 */
export function runFacilities(model: WorldModel): void {
  const seed = model.meta.seed;
  const { settlement, prosperity, worldScale, water } = model.meta.params;
  const settle = settlement / 100;
  const prosper = prosperity / 100;
  const scale = worldScale / 100;
  const waterP = water / 100;
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

  // --- windmill: 農村外縁の空白(格子走査。D4) ---
  const windmillCount = Math.round(
    Math.min(2, Math.max(0, (0.4 + 0.6 * prosper) * (0.5 + 0.5 * scale) * 2)),
  );
  if (windmillCount > 0) {
    const { marginWidth } = model.meta.derived;
    const size = model.ground.size;
    const cell = Math.max(1, marginWidth);
    const cells = Math.max(1, Math.ceil(size / cell));
    const half = (cells * cell) / 2;
    const facingOf = (pos: Vec2): number =>
      Math.atan2(
        model.centerPlan.position.z - pos.z,
        model.centerPlan.position.x - pos.x,
      );
    let placed = 0;
    for (let iz = 0; iz < cells && placed < windmillCount; iz++) {
      for (let ix = 0; ix < cells && placed < windmillCount; ix++) {
        const origin: Vec2 = { x: ix * cell - half, z: iz * cell - half };
        const windmill = buildWindmillFacility(
          seed,
          ix,
          iz,
          origin,
          cell,
          facingOf,
        );
        // footprint は pos 中心の矩形のため、平均がジッター後の位置になる
        const pos: Vec2 = { x: 0, z: 0 };
        for (const v of windmill.footprint) {
          pos.x += v.x / windmill.footprint.length;
          pos.z += v.z / windmill.footprint.length;
        }
        // 外縁帯(marginWidth × [0.3, 1.8))かつ農村ゾーン
        const bSdf = ruralCtx.boundaryInside(pos.x, pos.z);
        if (
          bSdf < marginWidth * WINDMILL_BAND_INNER ||
          bSdf >= marginWidth * WINDMILL_BAND_OUTER
        ) {
          continue;
        }
        const urbanity = model.zoning
          ? sampleFieldGrid(model.zoning, pos.x, pos.z)
          : 0;
        if (urbanity >= RURAL_URBANITY) continue;
        // 汎用クリアランス(水域は 4.5)
        if (
          !facilitySiteOk(
            ruralCtx,
            rectProbes(windmill.footprint, pos),
            facilities,
            WINDMILL_WATER_CLEAR,
          )
        ) {
          continue;
        }
        facilities.push(windmill);
        placed++;
      }
    }
  }

  // --- watermill: 水路 → 湖岸の候補列(D4) ---
  const watermillCount = Math.round(
    Math.min(2, Math.max(0, (0.3 + 0.7 * waterP) * 2)),
  );
  if (watermillCount > 0) {
    let placed = 0;
    // 保守的検証(桁行上限の footprint。陸上判定+汎用クリアランス)
    const watermillOk = (center: Vec2, f: Vec2, s: Vec2): boolean => {
      const fp = rectFootprint(
        center,
        f,
        s,
        WATERMILL_HUT_LEN_MAX / 2,
        WATERMILL_HUT_D / 2,
      );
      for (const c of fp) {
        if (ruralCtx.waterBodySdf(c.x, c.z) < 0) return false;
        if (ruralCtx.canalSdf(c.x, c.z) < 0) return false;
      }
      return facilitySiteOk(ruralCtx, rectProbes(fp, center), facilities, null);
    };
    // 水路沿い(canals 配列順。1 水路 1 基)
    for (const canal of model.water.canals) {
      if (placed >= watermillCount) break;
      let total = 0;
      for (let i = 0; i + 1 < canal.points.length; i++) {
        const a = canal.points[i];
        const b = canal.points[i + 1];
        if (a && b) total += Math.hypot(b.x - a.x, b.z - a.z);
      }
      let adopted = false;
      for (
        let arc = WATERMILL_CANAL_STEP / 2;
        arc < total && !adopted;
        arc += WATERMILL_CANAL_STEP
      ) {
        const at = pointAndTangentAlong(canal.points, arc);
        if (!at) break;
        const n: Vec2 = { x: -at.tangent.z, z: at.tangent.x };
        for (const side of [1, -1] as const) {
          const offset = canal.width / 2 + WATERMILL_CANAL_OFFSET_PAD;
          const center: Vec2 = {
            x: at.point.x + n.x * side * offset,
            z: at.point.z + n.z * side * offset,
          };
          // facing = 水面(水路)へ向く
          const facing = Math.atan2(-n.z * side, -n.x * side);
          const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
          const s: Vec2 = { x: -f.z, z: f.x };
          if (!watermillOk(center, f, s)) continue;
          facilities.push(
            buildWatermillFacility(
              seed,
              `facility/watermill/${canal.id}`,
              `facility/watermill/${canal.id}`,
              { type: "canal", canalId: canal.id },
              center,
              at.tangent,
              facing,
              (c) => watermillOk(c, f, s),
            ),
          );
          placed++;
          adopted = true;
          break;
        }
      }
    }
    // 湖岸沿い(shoreline.loops 配列順・points 点列順。1 ループ 1 基)
    for (const loop of model.water.shoreline.loops) {
      if (placed >= watermillCount) break;
      for (let i = 0; i < loop.points.length; i++) {
        const p = loop.points[i];
        const n = loop.normals[i];
        if (!p || !n) continue;
        const center: Vec2 = {
          x: p.x + n.x * WATERMILL_SHORE_OFFSET,
          z: p.z + n.z * WATERMILL_SHORE_OFFSET,
        };
        // facing = 法線の逆(陸 → 水域)
        const facing = Math.atan2(-n.z, -n.x);
        const f: Vec2 = { x: Math.cos(facing), z: Math.sin(facing) };
        const s: Vec2 = { x: -f.z, z: f.x };
        if (!watermillOk(center, f, s)) continue;
        facilities.push(
          buildWatermillFacility(
            seed,
            `facility/watermill/shore/${loop.id}/${i}`,
            `facility/watermill/shore/${loop.id}/${i}`,
            { type: "shore", shoreLoopId: loop.id, index: i },
            center,
            { x: -n.z, z: n.x },
            facing,
            (c) => watermillOk(c, f, s),
          ),
        );
        placed++;
        break;
      }
    }
  }

  // --- pier: 汀線ループ順(D5。契約「pier(桟橋)」実装補足) ---
  const pierCount = Math.round(Math.min(4, Math.max(0, 1 + 3 * waterP)));
  const shoreLoops = model.water.shoreline.loops;
  if (pierCount > 0 && shoreLoops.length > 0) {
    // waterfront claimed 領域への読み取り専用参加(段12 で確定済み。
    // 実体部品からの決定論的復元 — buildings.ts が復元関数を所有する)
    const claimed = waterfrontClaimedRegions(model);
    const bridgeRects = model.water.bridges.map(bridgeRect);
    const watersideFootprints = model.buildings
      .filter((b) => b.role === "waterside")
      .map((b) => b.footprint);
    // 適格条件 (b): 全汀線点の urbanity 平均(「相対的に高い側」の基準)
    let urbanitySum = 0;
    let urbanityN = 0;
    if (model.zoning) {
      for (const loop of shoreLoops) {
        for (const p of loop.points) {
          urbanitySum += sampleFieldGrid(model.zoning, p.x, p.z);
          urbanityN++;
        }
      }
    }
    const meanUrbanity = urbanityN > 0 ? urbanitySum / urbanityN : 0;

    /** 採択済みアンカー(ジッター解決後の汀線基準点) */
    const anchors: Vec2[] = [];
    const spacingOk = (p: Vec2, minDist: number): boolean => {
      for (const a of anchors) {
        if (Math.hypot(a.x - p.x, a.z - p.z) < minDist) return false;
      }
      return true;
    };
    /** 保守的検証(寸法上限の footprint。陸側端 = アンカー + 法線 × 1.0) */
    const pierOk = (anchor: Vec2, normal: Vec2): boolean => {
      const f: Vec2 = { x: -normal.x, z: -normal.z };
      const s: Vec2 = { x: -f.z, z: f.x };
      const landEnd: Vec2 = {
        x: anchor.x + normal.x * PIER_LAND_OVERLAP,
        z: anchor.z + normal.z * PIER_LAND_OVERLAP,
      };
      const halfW = (PIER_DECK_W + PIER_DECK_W_JITTER) / 2;
      // (1) 陸側端(中点と両隅)が陸上・(2) 水側プローブ(各距離で中点と
      //     両隅の 3 点 × 3 距離)が水面(全長の先端が板幅ごと水上になり、
      //     砂洲・対岸・湾曲した岸を跨がない)
      for (const u of [-halfW, 0, halfW]) {
        if (
          ruralCtx.waterBodySdf(landEnd.x + s.x * u, landEnd.z + s.z * u) < 0
        ) {
          return false;
        }
        for (const d of PIER_WATER_PROBES) {
          if (
            ruralCtx.waterBodySdf(
              anchor.x + f.x * d + s.x * u,
              anchor.z + f.z * d + s.z * u,
            ) >= 0
          ) {
            return false;
          }
        }
      }
      const center: Vec2 = {
        x: landEnd.x + (f.x * PIER_LEN_MAX) / 2,
        z: landEnd.z + (f.z * PIER_LEN_MAX) / 2,
      };
      const fp = rectFootprint(
        center,
        f,
        s,
        (PIER_DECK_W + PIER_DECK_W_JITTER) / 2,
        PIER_LEN_MAX / 2,
      );
      // (3) claimed 領域(建物のデッキ・張り出し部屋)と非重複
      for (const region of claimed) {
        if (polygonsOverlap(fp, region)) return false;
      }
      const probes = rectProbes(fp, center);
      for (const p of probes) {
        // (4) 橋・(5) 水路とのクリアランス
        for (const rect of bridgeRects) {
          if (polygonSignedDistance(p.x, p.z, rect) < PIER_CLEAR_BRIDGE) {
            return false;
          }
        }
        if (ruralCtx.canalSdf(p.x, p.z) < PIER_CLEAR_CANAL) return false;
      }
      // (6) 汎用クリアランス(水域は kind 例外で対象外)
      return facilitySiteOk(ruralCtx, probes, facilities, null);
    };

    let placed = 0;
    for (const loop of shoreLoops) {
      if (placed >= pierCount) break;
      for (let i = 0; i < loop.points.length && placed < pierCount; i++) {
        const p = loop.points[i];
        const n = loop.normals[i];
        if (!p || !n) continue;
        // 適格な岸点: (a) waterside 建物の近傍 or (b) 相対的に市街寄り
        let eligible = model.zoning
          ? sampleFieldGrid(model.zoning, p.x, p.z) >= meanUrbanity
          : true;
        if (!eligible) {
          for (const fp of watersideFootprints) {
            if (polygonSignedDistance(p.x, p.z, fp) <= PIER_NEAR_WATERSIDE) {
              eligible = true;
              break;
            }
          }
        }
        if (!eligible) continue;
        // 候補時点はジッター幅込みの間隔・保守的検証
        if (!spacingOk(p, PIER_SPACING + PIER_JITTER)) continue;
        if (!pierOk(p, n)) continue;
        // 接線 = 法線の 90° 回転(watermill の湖岸走査と同じ流儀)
        const tangent: Vec2 = { x: -n.z, z: n.x };
        const pier = buildPierFacility(
          seed,
          loop.id,
          i,
          p,
          tangent,
          n,
          (a) => spacingOk(a, PIER_SPACING) && pierOk(a, n),
        );
        facilities.push(pier);
        // アンカー(ジッター解決後)= footprint 重心 + 法線 × (長さ/2 − 1.0)
        const c: Vec2 = { x: 0, z: 0 };
        for (const v of pier.footprint) {
          c.x += v.x / pier.footprint.length;
          c.z += v.z / pier.footprint.length;
        }
        let vMin = Infinity;
        let vMax = -Infinity;
        for (const v of pier.footprint) {
          const e = (v.x - c.x) * -n.x + (v.z - c.z) * -n.z;
          vMin = Math.min(vMin, e);
          vMax = Math.max(vMax, e);
        }
        const halfLen = (vMax - vMin) / 2;
        anchors.push({
          x: c.x + n.x * (halfLen - PIER_LAND_OVERLAP),
          z: c.z + n.z * (halfLen - PIER_LAND_OVERLAP),
        });
        placed++;
      }
    }
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
