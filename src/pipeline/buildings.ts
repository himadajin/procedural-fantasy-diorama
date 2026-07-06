/**
 * 段12「建物」: 役割・footprint・向き・階数・屋根・接地(基壇・杭)の骨格データ。
 * データの正は docs/internal/contracts/worldmodel.md(Parcel / Building 節)、
 * 設計は implementation-spec 1.3節(段11「建物」相当)・PHASE 4a。
 *
 * PHASE 4a 内の分担(契約): 本段のうち id / parcelId / role / footprint /
 * facing / floors / roof / foundation は commit 12(本実装)が埋める。
 * materials / parts の展開と zoneMask の建物 footprint 上書きは
 * commit 13 の担当(それまで materials は空文字列、parts は空配列)。
 *
 * - 役割は UI 選択なし・文脈から決定(広場面 / 橋詰め / 水辺 / 密度の裾 /
 *   低密度×低Prosperity / 基本住居)
 * - 向きは接道正面を初期値に、広場に面する場合は footprint の 4 軸のうち
 *   広場方向に最も近い軸へスナップ(広場 > 道路 > 水面の優先)。最後に
 *   ±数度の揺らぎ(tidiness 高で減。乱数は "building/<id>" サブストリーム)
 * - 水辺建築は背面の水面(河川・湖)へ張り出し、杭または石基礎で
 *   水面下 y=-1.6(岸スカート下端)まで到達する(機械判定可能な契約)
 */
import { makeRng, type Rng } from "../rng";
import {
  SHORE_SKIRT_BOTTOM_Y,
  type Building,
  type BuildingRole,
  type Foundation,
  type Parcel,
  type Polygon,
  type Vec2,
  type WorldModel,
} from "../model/worldmodel";
import { polygonArea, polygonSignedDistance } from "../model/waterfield";
import { sampleFieldGrid } from "../model/fieldgrid";
import {
  ensureClockwise,
  polygonBounds,
  polygonsOverlap,
} from "../model/geometry";
import {
  createSiteContext,
  polylineTouchesPolygon,
  type SiteContext,
} from "./parcels";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// --- セットバック(契約: 前面 0.5 / 側面 0.7 / 背面 0.7) ---
const FRONT_SETBACK = 0.5;
const SIDE_SETBACK = 0.7;
const BACK_SETBACK = 0.7;

// --- 役割決定の閾値(契約) ---
/** 広場に面する判定(区画と広場ポリゴンの距離) */
const PLAZA_ADJ_DIST = 3;
/** 橋詰め判定(橋中心からの距離への加算) */
const BRIDGE_NEAR_EXTRA = 10;
/** 密度の裾(外縁の小建築) */
const OUTSKIRT_DENSITY = 0.14;
/** 倉庫・作業小屋の低密度閾値 */
const WAREHOUSE_DENSITY = 0.24;

// --- 向きの揺らぎ ---
/** 最大揺らぎ(度)。tidiness と建物半径でさらに縮む */
const MAX_JITTER_DEG = 3;
/** 揺らぎによる頂点変位の上限(実寸。セットバックを食い潰さない) */
const MAX_JITTER_SHIFT = 0.5;

// --- 水上張り出し(waterside) ---
/** 水面探索の最大距離(背面・左右の各辺の中点から) */
const OVERHANG_SEARCH = 6.0;
/** 水際からの張り出し長 */
const OVERHANG_INTO_WATER = 1.6;
/** 張り出し延長の上限 */
const OVERHANG_MAX = 7.0;
/** 張り出し延長の衝突クリアランス(道路は width/2 + これ) */
const OVERHANG_ROAD_CLEAR = 0.3;

// --- 屋根(art-direction 6節: 勾配 50〜58度) ---
const ROOF_PITCH_MIN = 50;
const ROOF_PITCH_MAX = 58;

interface LocalPoint {
  u: number;
  v: number;
}

/** 役割ごとの階数補正 */
const FLOORS_ROLE_ADJUST: Record<BuildingRole, number> = {
  house: 0,
  waterside: 0.1,
  bridgehead: 0.2,
  hall: 0.7,
  warehouse: -0.4,
  outskirt: -0.6,
  center: 0,
};

/** 役割ごとの基壇高さ補正 */
const PLINTH_ROLE_ADJUST: Record<BuildingRole, number> = {
  house: 0,
  waterside: 0.1,
  bridgehead: 0.05,
  hall: 0.25,
  warehouse: -0.05,
  outskirt: -0.05,
  center: 0,
};

/** 敷地に接する広場(距離 < PLAZA_ADJ_DIST)。無ければ null */
function adjacentPlaza(
  model: WorldModel,
  parcel: Parcel,
): { position: Vec2 } | null {
  const b = polygonBounds(parcel.polygon);
  for (const plaza of model.plazas) {
    const reach = plaza.radius + PLAZA_ADJ_DIST;
    if (
      plaza.position.x < b.minX - reach ||
      plaza.position.x > b.maxX + reach ||
      plaza.position.z < b.minZ - reach ||
      plaza.position.z > b.maxZ + reach
    ) {
      continue;
    }
    for (const p of parcel.polygon) {
      if (polygonSignedDistance(p.x, p.z, plaza.polygon) < PLAZA_ADJ_DIST) {
        return { position: plaza.position };
      }
    }
  }
  return null;
}

/** BridgeSite 近傍か(渡り長/2 + 10 以内) */
function nearBridge(model: WorldModel, center: Vec2): boolean {
  for (const bridge of model.water.bridges) {
    const d = Math.hypot(
      center.x - bridge.position.x,
      center.z - bridge.position.z,
    );
    if (d < bridge.length / 2 + BRIDGE_NEAR_EXTRA) return true;
  }
  return false;
}

/** 役割決定(契約の優先順: hall > bridgehead > waterside > outskirt > warehouse > house) */
function decideRole(
  rng: Rng,
  model: WorldModel,
  parcel: Parcel,
  center: Vec2,
  density: number,
): BuildingRole {
  const { derived } = model.meta;
  const plaza = adjacentPlaza(model, parcel);
  if (plaza && rng.chance(0.3 + 0.6 * derived.detailAmount)) return "hall";
  if (nearBridge(model, center) && rng.chance(0.35 + 0.55 * derived.watersideRate)) {
    return "bridgehead";
  }
  if (
    (parcel.waterside || parcel.canalside) &&
    rng.chance(0.5 + 0.5 * derived.watersideRate)
  ) {
    return "waterside";
  }
  if (density < OUTSKIRT_DENSITY) return "outskirt";
  if (
    density < WAREHOUSE_DENSITY &&
    derived.detailAmount < 0.55 &&
    rng.chance(0.6)
  ) {
    return "warehouse";
  }
  return "house";
}

/** 形状(ローカル座標。u=間口方向、v=前面からの奥行き) */
function shapeVertices(
  rng: Rng,
  role: BuildingRole,
  bw: number,
  bd: number,
): { verts: LocalPoint[]; compound: boolean } {
  const w2 = bw / 2;
  if (role === "hall" && bw >= 8 && bd >= 8) {
    // T字: 前面棟+背面へ伸びる中央翼
    const fd = bd * 0.62;
    const ww = bw * 0.28;
    return {
      verts: [
        { u: -w2, v: 0 },
        { u: w2, v: 0 },
        { u: w2, v: fd },
        { u: ww, v: fd },
        { u: ww, v: bd },
        { u: -ww, v: bd },
        { u: -ww, v: fd },
        { u: -w2, v: fd },
      ],
      compound: true,
    };
  }
  if (role === "house" && bw >= 7.5 && bd >= 7.5 && rng.chance(0.35)) {
    // L字: 背面の一角を欠き取る
    const right = rng.chance(0.5);
    const nw = bw * 0.4;
    const nd = bd * 0.4;
    const verts: LocalPoint[] = right
      ? [
          { u: -w2, v: 0 },
          { u: w2, v: 0 },
          { u: w2, v: bd - nd },
          { u: w2 - nw, v: bd - nd },
          { u: w2 - nw, v: bd },
          { u: -w2, v: bd },
        ]
      : [
          { u: -w2, v: 0 },
          { u: w2, v: 0 },
          { u: w2, v: bd },
          { u: -w2 + nw, v: bd },
          { u: -w2 + nw, v: bd - nd },
          { u: -w2, v: bd - nd },
        ];
    return { verts, compound: true };
  }
  return {
    verts: [
      { u: -w2, v: 0 },
      { u: w2, v: 0 },
      { u: w2, v: bd },
      { u: -w2, v: bd },
    ],
    compound: false,
  };
}

/** 張り出し延長の衝突検査(契約: 他区画・道路・水路・広場・結界環・境界) */
function overhangBlocked(
  model: WorldModel,
  ctx: SiteContext,
  region: Polygon,
  ownParcelId: string,
): boolean {
  const probes: Vec2[] = [...region];
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    const b = region[(i + 1) % region.length];
    if (!a || !b) continue;
    probes.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  }
  for (const p of probes) {
    if (ctx.boundaryInside(p.x, p.z) < 1) return true;
    if (ctx.canalSdf(p.x, p.z) < OVERHANG_ROAD_CLEAR) return true;
  }
  for (const parcel of model.parcels) {
    if (parcel.id === ownParcelId) continue;
    if (polygonsOverlap(region, parcel.polygon)) return true;
  }
  for (const edge of model.network.edges) {
    if (
      polylineTouchesPolygon(
        edge.path,
        region,
        edge.width / 2 + OVERHANG_ROAD_CLEAR,
      )
    ) {
      return true;
    }
  }
  for (const plaza of model.plazas) {
    if (polygonsOverlap(region, plaza.polygon)) return true;
  }
  const ring = model.wards.ringPath;
  if (ring.length >= 3) {
    const closedRing = [...ring, ring[0] as Vec2];
    if (polylineTouchesPolygon(closedRing, region, 2.5)) return true;
  }
  return false;
}

/** パイプライン段の実体: buildings(骨格)を埋める */
export function runBuildings(model: WorldModel): void {
  const { seed, derived } = model.meta;
  const final = model.density.final;
  const ctx = createSiteContext(model);
  const buildings: Building[] = [];
  let violations = 0;

  for (const parcel of model.parcels) {
    const id = `building/${parcel.id.slice("parcel/".length)}`;
    const rng = makeRng(seed, id);

    // --- 幾何の下ごしらえ(接道フレーム) ---
    const [fa, fb] = parcel.frontEdge;
    const frontage = Math.hypot(fb.x - fa.x, fb.z - fa.z);
    const depth = frontage > 1e-6 ? polygonArea(parcel.polygon) / frontage : 0;
    const tx = (fb.x - fa.x) / Math.max(frontage, 1e-6);
    const tz = (fb.z - fa.z) / Math.max(frontage, 1e-6);
    let backX = -Math.cos(parcel.facing);
    let backZ = -Math.sin(parcel.facing);
    const frontMid = { x: (fa.x + fb.x) / 2, z: (fa.z + fb.z) / 2 };
    const origin = {
      x: frontMid.x + backX * FRONT_SETBACK,
      z: frontMid.z + backZ * FRONT_SETBACK,
    };
    const usableW = Math.max(2.2, frontage - 2 * SIDE_SETBACK);
    const usableD = Math.max(2.2, depth - FRONT_SETBACK - BACK_SETBACK);
    const center = {
      x: origin.x + backX * (usableD / 2),
      z: origin.z + backZ * (usableD / 2),
    };
    const density = final ? sampleFieldGrid(final, center.x, center.z) : 0;

    // --- 役割 ---
    const role = decideRole(rng, model, parcel, center, density);

    // --- 寸法と形状 ---
    const widthT = rng.next();
    const depthT = rng.next();
    let bw = usableW * (0.82 + 0.18 * widthT);
    let bd = usableD * (0.72 + 0.23 * depthT);
    if (role === "warehouse") {
      bw = usableW * 0.9;
      bd = usableD * 0.9;
    } else if (role === "outskirt") {
      bw *= 0.65;
      bd *= 0.65;
    } else if (role === "waterside") {
      // 水辺建築は敷地の奥行きを使い切り、水面へ寄る
      bd = usableD * (0.88 + 0.07 * depthT);
    }
    bw = clamp(bw, 2.2, usableW);
    bd = clamp(bd, 2.2, usableD);
    // waterside は shapeVertices が矩形を返す(張り出しの合成を単純に保つ。契約)
    const { verts: localVerts, compound } = shapeVertices(rng, role, bw, bd);

    // ローカル → ワールド
    let verts: Vec2[] = localVerts.map((lp) => ({
      x: origin.x + tx * lp.u + backX * lp.v,
      z: origin.z + tz * lp.u + backZ * lp.v,
    }));

    // --- 向き: 広場 > 道路 > 水面 の優先 ---
    let facing = parcel.facing;
    const plaza = adjacentPlaza(model, parcel);
    if (plaza) {
      const toPlaza = Math.atan2(
        plaza.position.z - center.z,
        plaza.position.x - center.x,
      );
      let best = facing;
      let bestDot = -Infinity;
      for (let k = 0; k < 4; k++) {
        const a = parcel.facing + (k * Math.PI) / 2;
        const dot = Math.cos(a - toPlaza);
        if (dot > bestDot) {
          bestDot = dot;
          best = a;
        }
      }
      facing = best;
    }

    // --- 揺らぎ(tidiness 高で減。頂点変位 0.5 以下にクランプ) ---
    let cx = 0;
    let cz = 0;
    for (const v of verts) {
      cx += v.x;
      cz += v.z;
    }
    cx /= verts.length;
    cz /= verts.length;
    let radius = 0;
    for (const v of verts) {
      radius = Math.max(radius, Math.hypot(v.x - cx, v.z - cz));
    }
    const jitterMax = Math.min(
      (MAX_JITTER_DEG * Math.PI) / 180,
      MAX_JITTER_SHIFT / Math.max(radius, 1e-6),
    );
    const jitter = rng.range(-1, 1) * (1 - derived.tidiness) * jitterMax;
    const cosJ = Math.cos(jitter);
    const sinJ = Math.sin(jitter);
    const rotate = (p: Vec2): Vec2 => ({
      x: cx + (p.x - cx) * cosJ - (p.z - cz) * sinJ,
      z: cz + (p.x - cx) * sinJ + (p.z - cz) * cosJ,
    });
    verts = verts.map(rotate);
    facing += jitter;
    const backRot = {
      x: backX * cosJ - backZ * sinJ,
      z: backX * sinJ + backZ * cosJ,
    };
    backX = backRot.x;
    backZ = backRot.z;

    // --- 水上張り出し(waterside × 河川・湖) ---
    // 背面・左右の3辺の中点から水面を探索し、最も近い水面へ向けて
    // その辺を延長する(正面=接道側は張り出さない)。
    let overWater = false;
    if (role === "waterside" && verts.length === 4) {
      const tRot = {
        x: tx * cosJ - tz * sinJ,
        z: tx * sinJ + tz * cosJ,
      };
      // 矩形の頂点順は [fl, fr, br, bl]
      const sides: { d: Vec2; a: number; b: number }[] = [
        { d: { x: backX, z: backZ }, a: 2, b: 3 }, // 背面(br, bl)
        { d: tRot, a: 1, b: 2 }, // 右側面(fr, br)
        { d: { x: -tRot.x, z: -tRot.z }, a: 3, b: 0 }, // 左側面(bl, fl)
      ];
      let best: { d: Vec2; a: number; b: number; gap: number } | null = null;
      for (const side of sides) {
        const va = verts[side.a];
        const vb = verts[side.b];
        if (!va || !vb) continue;
        // 辺の中点と両端(コーナーの斜め先の水面も拾う)から探索する
        const starts: Vec2[] = [
          { x: (va.x + vb.x) / 2, z: (va.z + vb.z) / 2 },
          va,
          vb,
        ];
        for (const s of starts) {
          for (let g = 0.5; g <= OVERHANG_SEARCH + 1e-9; g += 0.5) {
            if (ctx.riverLakeSdf(s.x + side.d.x * g, s.z + side.d.z * g) < 0) {
              if (!best || g < best.gap) best = { ...side, gap: g };
              break;
            }
          }
        }
      }
      if (best) {
        const va = verts[best.a];
        const vb = verts[best.b];
        if (va && vb) {
          const ext = Math.min(best.gap + OVERHANG_INTO_WATER, OVERHANG_MAX);
          const region: Polygon = ensureClockwise([
            { x: va.x, z: va.z },
            { x: va.x + best.d.x * ext, z: va.z + best.d.z * ext },
            { x: vb.x + best.d.x * ext, z: vb.z + best.d.z * ext },
            { x: vb.x, z: vb.z },
          ]);
          if (!overhangBlocked(model, ctx, region, parcel.id)) {
            verts[best.a] = {
              x: va.x + best.d.x * ext,
              z: va.z + best.d.z * ext,
            };
            verts[best.b] = {
              x: vb.x + best.d.x * ext,
              z: vb.z + best.d.z * ext,
            };
          }
        }
      }
    }
    const footprint = ensureClockwise(verts);
    for (const v of footprint) {
      if (ctx.riverLakeSdf(v.x, v.z) < 0) overWater = true;
    }

    // --- 階数(Settlement / Prosperity / 役割) ---
    const floorsBase =
      1.05 +
      derived.floorsBias +
      0.4 * derived.detailAmount +
      FLOORS_ROLE_ADJUST[role] +
      rng.range(-0.3, 0.5);
    const floors = clamp(Math.round(floorsBase), 1, 3);

    // --- 屋根(50〜58度。L/T は複合屋根) ---
    let roofType: Building["roof"]["type"] = "gable";
    if (compound) roofType = "compound";
    else if (role === "hall" && rng.chance(0.6)) roofType = "hip";
    else if (floors >= 2 && rng.chance(0.2)) roofType = "hip";
    const pitch =
      ROOF_PITCH_MIN + (ROOF_PITCH_MAX - ROOF_PITCH_MIN) * rng.next();

    // --- 接地(基壇・杭・石基礎。契約の機械判定表現) ---
    const plinthHeight = clamp(
      0.15 + 0.55 * derived.detailAmount + PLINTH_ROLE_ADJUST[role],
      0.1,
      1.0,
    );
    const foundation: Foundation = overWater
      ? {
          kind: derived.detailAmount > 0.55 ? "stonebase" : "piles",
          plinthHeight,
          overWater: true,
          bottomY: SHORE_SKIRT_BOTTOM_Y,
        }
      : { kind: "plinth", plinthHeight, overWater: false, bottomY: 0 };

    buildings.push({
      id,
      parcelId: parcel.id,
      role,
      footprint,
      facing,
      floors,
      roof: { type: roofType, pitch },
      foundation,
      materials: { wall: "", roof: "", trim: "" },
      parts: [],
    });
  }

  model.buildings = buildings;

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
  const edgeById = new Map(model.network.edges.map((e) => [e.id, e]));
  const boundsList = buildings.map((b) => polygonBounds(b.footprint));
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b) continue;

    // (1) 接道正面: 親区画の frontEdge が接道 edge の近傍にある
    const parcel = b.parcelId ? parcelById.get(b.parcelId) : undefined;
    const edge = parcel ? edgeById.get(parcel.roadEdgeId) : undefined;
    if (!parcel || !edge) {
      violations++;
    } else {
      const [a, c] = parcel.frontEdge;
      const mid = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 };
      let minD = Infinity;
      for (let k = 0; k + 1 < edge.path.length; k++) {
        const p = edge.path[k];
        const q = edge.path[k + 1];
        if (!p || !q) continue;
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const lenSq = dx * dx + dz * dz;
        const t =
          lenSq > 0
            ? clamp(((mid.x - p.x) * dx + (mid.z - p.z) * dz) / lenSq, 0, 1)
            : 0;
        minD = Math.min(
          minD,
          Math.hypot(mid.x - (p.x + dx * t), mid.z - (p.z + dz * t)),
        );
      }
      if (minD > edge.width / 2 + 2.0) violations++;
    }

    // (2) 接地契約: overWater ⇔ 頂点の水上、杭・基礎の水面下到達
    let vertOverWater = false;
    for (const v of b.footprint) {
      if (ctx.riverLakeSdf(v.x, v.z) < 0) vertOverWater = true;
      if (ctx.canalSdf(v.x, v.z) < 0) violations++; // 水路上は常に禁止
    }
    if (vertOverWater !== b.foundation.overWater) violations++;
    if (b.foundation.overWater) {
      if (b.foundation.kind === "plinth") violations++;
      if (b.foundation.bottomY > SHORE_SKIRT_BOTTOM_Y + 1e-9) violations++;
    }

    // (3) 建物どうし・道路・広場との重なりゼロ
    const bb = boundsList[i];
    if (!bb) continue;
    for (let j = i + 1; j < buildings.length; j++) {
      const other = buildings[j];
      const ob = boundsList[j];
      if (!other || !ob) continue;
      if (
        ob.minX > bb.maxX ||
        ob.maxX < bb.minX ||
        ob.minZ > bb.maxZ ||
        ob.maxZ < bb.minZ
      ) {
        continue;
      }
      if (polygonsOverlap(b.footprint, other.footprint)) violations++;
    }
    for (const e of model.network.edges) {
      if (polylineTouchesPolygon(e.path, b.footprint, e.width / 2)) {
        violations++;
      }
    }
    for (const plaza of model.plazas) {
      if (polygonsOverlap(b.footprint, plaza.polygon)) violations++;
    }
  }
  if (violations > 0) {
    console.warn(`buildings: パイプライン内アサーション違反 ${violations} 件`);
  }
}
