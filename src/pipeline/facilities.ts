/**
 * 段14「施設」: 施設(Facility)の生成(Phase D。
 * `docs/internal/plans/2026-07-14-worldgen-rework-facilities.md`)。
 * 契約の正は docs/internal/contracts/facilities.md(kind 一覧・配置条件・
 * 衝突/帯検証則・RNG ラベル体系・造形の純関数分離・kind ごとの造形の性質)。
 *
 * D2b の範囲: field(畑)/ pasture(牧草地)— farmland 区画への生成。
 * well / stall / windmill / watermill / pier は D3〜D5 で追う。
 *
 * 造形は「入力(寸法・向き・当該施設の rng サブストリーム)→ Part[]」の
 * 純関数(buildFieldParts / buildPastureParts)として配置ロジックから
 * 分離する(契約 3.8b。ギャラリーは buildFarmlandFacility を経由して
 * この本番の造形関数のみを呼ぶ)。乱数は新設ストリーム
 * `"facility/farmland/<parcelId>"` のみを消費し、既存ストリームの消費列は
 * 変えない。
 */
import { makeRng, type Rng } from "../rng";
import type {
  Facility,
  Parcel,
  Part,
  Vec2,
  WorldModel,
} from "../model/worldmodel";
import { polygonSignedDistance } from "../model/waterfield";

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
    for (const [lx, lz] of [
      [-sx / 2, -sz / 2],
      [sx / 2, -sz / 2],
      [sx / 2, sz / 2],
      [-sx / 2, sz / 2],
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
 * contracts/pipeline.md 段14)。走査順は farmland 区画の parcels 配列内
 * 出現順(契約「順序非依存の走査順」)。
 */
export function runFacilities(model: WorldModel): void {
  const seed = model.meta.seed;
  const facilities: Facility[] = [];
  for (const parcel of model.parcels) {
    if (parcel.kind !== "farmland") continue;
    facilities.push(buildFarmlandFacility(seed, parcel));
  }
  model.facilities = facilities;

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  let violations = 0;
  const farmlandCount = model.parcels.filter(
    (p) => p.kind === "farmland",
  ).length;
  if (facilities.length !== farmlandCount) violations++;
  for (const facility of facilities) {
    if (facility.parts.length === 0) violations++;
    violations += partBandViolations(facility);
  }
  if (violations > 0) {
    console.warn(`facilities: パイプライン内アサーション違反 ${violations} 件`);
  }
}
