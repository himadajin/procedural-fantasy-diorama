/**
 * 段14「植生」: 樹木・低木・草むらをマスクベースで散布する
 * (PHASE 6 commit 20)。データの正は docs/internal/contracts/worldmodel.md
 * (Vegetation 節)、段の位置づけは contracts/pipeline.md の段契約表。
 *
 * - セル格子(一辺 VEG_CELL)ごとに候補 1 点。乱数はセルごとの独立
 *   サブストリーム "vegetation/<ix>_<iz>" のみを消費する
 * - 散布マスクの優先順位: 森リング(密)> 外縁草地(まばら)>
 *   水辺低木・湿地植生 > 道・広場周辺の控えめな緑 > 内地(微量)。
 *   結界内は × 0.12 に抑制し、最終密度場で市街地も抑制する
 *   (外へ向かって植生が増える勾配。implementation-spec 7章)
 * - World Scale が森リング厚(marginWidth)を、Water が岸辺植生
 *   (shoreVegetation)を駆動する(implementation-spec 1.6節)
 * - 建物・道路・広場・水面(河川・湖)・水路バッファとの衝突はハード除外
 * - 上限(性能配慮): 木 2000 / 低木 1200 / 草むら 320。超過時は
 *   間引きキー昇順の決定論的な間引き(乱数を追加消費しない)
 */
import { makeRng } from "../rng";
import type { Polygon, Vec2, WorldModel } from "../model/worldmodel";
import {
  createWaterField,
  distToPolyline,
  pointInPolygon,
  polygonSignedDistance,
} from "../model/waterfield";
import { sampleFieldGrid } from "../model/fieldgrid";
import { sampleZoneMask, ZONE_KINDS } from "../model/zonemask";
import { polygonBounds } from "../model/geometry";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 散布セルの一辺(実寸。contracts/worldmodel.md Vegetation 節) */
export const VEG_CELL = 5.0;
/** InstancedMesh 上限(性能配慮。同節) */
export const TREE_MAX = 2000;
export const SHRUB_MAX = 1200;
export const GRASS_MAX = 320;

// --- 散布マスク(カテゴリ確率。contracts の数値) ---
/** 森リング: 木の基準採択率と内縁の減衰幅 */
const FOREST_TREE_P = 0.62;
const FOREST_SHRUB_P = 0.05;
const FOREST_INNER_FADE = 6;
/** 森リングで conifer を選好する確率(他カテゴリは 0.35) */
const FOREST_CONIFER_P = 0.6;
const OTHER_CONIFER_P = 0.35;
/** 外縁草地の帯(marginWidth 比)と確率 */
const MEADOW_RATIO = 2.2;
const MEADOW_TREE_P = 0.1;
const MEADOW_SHRUB_P = 0.07;
const MEADOW_GRASS_P = 0.06;
/** 水辺の帯と確率(shoreVegetation 駆動の加算層。森リング外に働く) */
const SHORE_BAND = 7;
const SHORE_SHRUB_BASE = 0.6;
const SHORE_MARSH_BOOST = 0.35;
const SHORE_TREE_P = 0.1;
const SHORE_GRASS_P = 0.06;
/** 道・広場周辺の帯と確率(控えめな緑) */
const ROADSIDE_BAND = 6;
const ROADSIDE_TREE_P = 0.025;
const ROADSIDE_SHRUB_P = 0.05;
const ROADSIDE_GRASS_P = 0.04;
/** 内地(微量) */
const AMBIENT_TREE_P = 0.018;
const AMBIENT_SHRUB_P = 0.02;
const AMBIENT_GRASS_P = 0.03;
/** 結界内の抑制係数(僅少)と密度場の抑制強さ */
const WARD_INTERIOR_FACTOR = 0.12;
const DENSITY_SUPPRESS = 0.8;

// --- 衝突除外(ハード。contracts の一覧) ---
const EDGE_CLEAR = 2.2;
const WATER_CLEAR = 1.2;
const CANAL_CLEAR = 1.2;
const ROAD_CLEAR = 1.4;
const PLAZA_CLEAR = 1.0;
const BUILDING_CLEAR = 1.0;
const CENTER_CLEAR = 1.5;
const RING_CLEAR = 2.2;
const SHRINE_CLEAR = 3.5;
const TOWER_CLEAR = 4.0;

/** 個体差の範囲(contracts) */
const TREE_SCALE_MIN = 0.8;
const TREE_SCALE_MAX = 1.25;
const FOREST_SCALE_BOOST = 1.15;
const SHRUB_SCALE_MIN = 0.7;
const SHRUB_SCALE_MAX = 1.3;
const GRASS_RADIUS_MIN = 1.6;
const GRASS_RADIUS_MAX = 3.0;

const MARSH_CHANNEL = ZONE_KINDS.indexOf("marsh");

/** 道路セグメント(バウンディングボックスの粗い絞り込み付き) */
interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  half: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface VegContext {
  model: WorldModel;
  waterSdf: (x: number, z: number) => number;
  boundarySdf: (x: number, z: number) => number;
  segments: Segment[];
  segReach: number;
  buildingBounds: { minX: number; maxX: number; minZ: number; maxZ: number }[];
  ringBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

function buildContext(model: WorldModel): VegContext {
  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );
  const segments: Segment[] = [];
  let segReach = 0;
  for (const edge of model.network.edges) {
    const half = edge.width / 2;
    segReach = Math.max(segReach, half + ROADSIDE_BAND);
    for (let i = 0; i + 1 < edge.path.length; i++) {
      const a = edge.path[i];
      const b = edge.path[i + 1];
      if (!a || !b) continue;
      segments.push({
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        half,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z),
        maxZ: Math.max(a.z, b.z),
      });
    }
  }
  return {
    model,
    waterSdf: field.waterSdf,
    boundarySdf: field.boundarySdf,
    segments,
    segReach,
    buildingBounds: model.buildings.map((b) => polygonBounds(b.footprint)),
    ringBounds:
      model.wards.ringPath.length >= 3
        ? polygonBounds(model.wards.ringPath)
        : null,
  };
}

/** 道路の縁までの距離(距離 − width/2。近傍セグメントのみ精査) */
function roadEdgeDistance(ctx: VegContext, x: number, z: number): number {
  let best = Infinity;
  const reach = ctx.segReach;
  for (const s of ctx.segments) {
    if (
      x < s.minX - reach ||
      x > s.maxX + reach ||
      z < s.minZ - reach ||
      z > s.maxZ + reach
    ) {
      continue;
    }
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const lenSq = dx * dx + dz * dz;
    const t =
      lenSq > 0 ? clamp(((x - s.ax) * dx + (z - s.az) * dz) / lenSq, 0, 1) : 0;
    const d =
      Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) - s.half;
    if (d < best) best = d;
  }
  return best;
}

/** 広場の縁までの距離(近傍のみ精査) */
function plazaEdgeDistance(ctx: VegContext, x: number, z: number): number {
  let best = Infinity;
  for (const plaza of ctx.model.plazas) {
    const reach = plaza.radius + ROADSIDE_BAND + 2;
    if (
      Math.abs(x - plaza.position.x) > reach ||
      Math.abs(z - plaza.position.z) > reach
    ) {
      continue;
    }
    const d = polygonSignedDistance(x, z, plaza.polygon);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 候補点のハード除外(contracts の衝突一覧)。extra は grassPatch の
 * 多角形半径ぶんの上乗せ。roadDist / plazaDist は呼び出し側の算出値を
 * 受け取る(マスク判定と共有)。
 */
function isClear(
  ctx: VegContext,
  x: number,
  z: number,
  extra: number,
  roadDist: number,
  plazaDist: number,
): boolean {
  const { model } = ctx;
  if (ctx.boundarySdf(x, z) < EDGE_CLEAR + extra) return false;
  if (ctx.waterSdf(x, z) < WATER_CLEAR + extra) return false;
  if (roadDist < ROAD_CLEAR + extra) return false;
  if (plazaDist < PLAZA_CLEAR + extra) return false;
  for (const canal of model.water.canals) {
    if (
      distToPolyline(x, z, canal.points) - canal.width / 2 <
      CANAL_CLEAR + extra
    ) {
      return false;
    }
  }
  const reach = BUILDING_CLEAR + extra;
  for (let i = 0; i < model.buildings.length; i++) {
    const bb = ctx.buildingBounds[i];
    const b = model.buildings[i];
    if (!bb || !b) continue;
    if (
      x < bb.minX - reach ||
      x > bb.maxX + reach ||
      z < bb.minZ - reach ||
      z > bb.maxZ + reach
    ) {
      continue;
    }
    if (polygonSignedDistance(x, z, b.footprint) < reach) return false;
  }
  const foot = model.centerPlan.footprint;
  if (foot.length >= 3) {
    if (polygonSignedDistance(x, z, foot) < CENTER_CLEAR + extra) return false;
  }
  const ring = model.wards.ringPath;
  if (ctx.ringBounds && ring.length >= 3) {
    const rb = ctx.ringBounds;
    const rc = RING_CLEAR + extra;
    if (
      x > rb.minX - rc &&
      x < rb.maxX + rc &&
      z > rb.minZ - rc &&
      z < rb.maxZ + rc
    ) {
      if (Math.abs(polygonSignedDistance(x, z, ring)) < rc) return false;
    }
  }
  for (const shrine of model.wards.shrines) {
    if (
      Math.hypot(x - shrine.position.x, z - shrine.position.z) <
      SHRINE_CLEAR + extra
    ) {
      return false;
    }
  }
  for (const tower of model.wards.towers) {
    if (
      Math.hypot(x - tower.position.x, z - tower.position.z) <
      TOWER_CLEAR + extra
    ) {
      return false;
    }
  }
  return true;
}

/** カテゴリごとの採択確率(木・低木・草むら)と conifer 選好・森リングか */
interface MaskProbs {
  tree: number;
  shrub: number;
  grass: number;
  coniferP: number;
  forest: boolean;
}

/**
 * 散布マスク: 優先順位(森リング > 外縁草地 > 道・広場周辺 > 内地)で
 * 基準カテゴリを決め、水辺(shoreVegetation 駆動)を森リング外の帯へ
 * 加算し、結界内・市街地の抑制を乗じる(contracts/worldmodel.md
 * Vegetation 節の優先順位)。
 */
function maskAt(
  ctx: VegContext,
  x: number,
  z: number,
  roadDist: number,
  plazaDist: number,
): MaskProbs {
  const { model } = ctx;
  const { derived } = model.meta;
  const bSdf = ctx.boundarySdf(x, z);
  const wSdf = ctx.waterSdf(x, z);

  let probs: MaskProbs;
  if (bSdf < derived.marginWidth) {
    // 森リング(密)。内縁は草地へ滑らかに減衰
    const ramp = smoothstep(0, FOREST_INNER_FADE, derived.marginWidth - bSdf);
    probs = {
      tree: FOREST_TREE_P * ramp,
      shrub: FOREST_SHRUB_P,
      grass: 0,
      coniferP: FOREST_CONIFER_P,
      forest: true,
    };
  } else if (bSdf < derived.marginWidth * MEADOW_RATIO) {
    // 外縁草地(まばら)
    probs = {
      tree: MEADOW_TREE_P,
      shrub: MEADOW_SHRUB_P,
      grass: MEADOW_GRASS_P,
      coniferP: OTHER_CONIFER_P,
      forest: false,
    };
  } else if (roadDist < ROADSIDE_BAND || plazaDist < ROADSIDE_BAND) {
    // 道・広場周辺の控えめな緑
    probs = {
      tree: ROADSIDE_TREE_P,
      shrub: ROADSIDE_SHRUB_P,
      grass: ROADSIDE_GRASS_P,
      coniferP: OTHER_CONIFER_P,
      forest: false,
    };
  } else {
    // 内地(微量)
    probs = {
      tree: AMBIENT_TREE_P,
      shrub: AMBIENT_SHRUB_P,
      grass: AMBIENT_GRASS_P,
      coniferP: OTHER_CONIFER_P,
      forest: false,
    };
  }

  // 水辺低木・湿地植生(加算層。森リング外の帯で Water が駆動する)
  if (!probs.forest && wSdf < SHORE_BAND) {
    const marsh =
      sampleZoneMask(model.ground.zoneMask, x, z).weights[MARSH_CHANNEL] ?? 0;
    const near = 1 - clamp(wSdf / SHORE_BAND, 0, 1);
    probs.shrub +=
      (SHORE_SHRUB_BASE + SHORE_MARSH_BOOST * marsh) *
      derived.shoreVegetation *
      (0.35 + 0.65 * near);
    probs.tree += SHORE_TREE_P * derived.shoreVegetation;
    probs.grass += SHORE_GRASS_P * derived.shoreVegetation;
  }

  // 抑制: 結界内は僅少、市街地(最終密度場)は控えめに
  let factor = 1;
  const ring = model.wards.ringPath;
  if (ring.length >= 3 && pointInPolygon(x, z, ring)) {
    factor *= WARD_INTERIOR_FACTOR;
  }
  if (model.density.final) {
    factor *= 1 - DENSITY_SUPPRESS * sampleFieldGrid(model.density.final, x, z);
  }
  probs.tree *= factor;
  probs.shrub *= factor;
  probs.grass *= factor;
  return probs;
}

/** 上限超過時の決定論的な間引き(間引きキー昇順・同点 id 順。走査順を保つ) */
function thinToCap<T extends { id: string; thinKey: number }>(
  items: T[],
  cap: number,
): T[] {
  if (items.length <= cap) return items;
  const order = items
    .slice()
    .sort((a, b) => a.thinKey - b.thinKey || (a.id < b.id ? -1 : 1));
  const keep = new Set<string>();
  for (let i = 0; i < cap; i++) {
    const item = order[i];
    if (item) keep.add(item.id);
  }
  return items.filter((item) => keep.has(item.id));
}

/** パイプライン段の実体: vegetation を埋める(他フィールドには触れない) */
export function runVegetation(model: WorldModel): void {
  const ctx = buildContext(model);
  const size = model.ground.size;
  const seed = model.meta.seed;
  const cells = Math.max(1, Math.ceil(size / VEG_CELL));
  const half = (cells * VEG_CELL) / 2;

  type TreeItem = WorldModel["vegetation"]["trees"][number] & {
    thinKey: number;
  };
  type ShrubItem = WorldModel["vegetation"]["shrubs"][number] & {
    thinKey: number;
  };
  type GrassItem = WorldModel["vegetation"]["grassPatches"][number] & {
    thinKey: number;
  };
  const trees: TreeItem[] = [];
  const shrubs: ShrubItem[] = [];
  const grasses: GrassItem[] = [];

  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const rng = makeRng(seed, `vegetation/${ix}_${iz}`);
      const x = ix * VEG_CELL - half + rng.next() * VEG_CELL;
      const z = iz * VEG_CELL - half + rng.next() * VEG_CELL;
      const roll = rng.next();

      // 境界の遠い外は早期棄却(乱数消費はセル独立のため揃えなくてよい)
      const bSdf = ctx.boundarySdf(x, z);
      if (bSdf < EDGE_CLEAR) continue;

      const roadDist = roadEdgeDistance(ctx, x, z);
      const plazaDist = plazaEdgeDistance(ctx, x, z);
      const probs = maskAt(ctx, x, z, roadDist, plazaDist);

      if (roll < probs.tree) {
        if (!isClear(ctx, x, z, 0, roadDist, plazaDist)) continue;
        const form = rng.next() < probs.coniferP ? "conifer" : "broadleaf";
        const scale =
          rng.range(TREE_SCALE_MIN, TREE_SCALE_MAX) *
          (probs.forest ? FOREST_SCALE_BOOST : 1);
        const rotation = rng.range(0, Math.PI * 2);
        const colorVar = rng.next();
        trees.push({
          id: `tree/${ix}_${iz}`,
          position: { x, z },
          form,
          scale,
          rotation,
          colorVar,
          thinKey: rng.next(),
        });
      } else if (roll < probs.tree + probs.shrub) {
        if (!isClear(ctx, x, z, 0, roadDist, plazaDist)) continue;
        shrubs.push({
          id: `shrub/${ix}_${iz}`,
          position: { x, z },
          scale: rng.range(SHRUB_SCALE_MIN, SHRUB_SCALE_MAX),
          thinKey: rng.next(),
        });
      } else if (roll < probs.tree + probs.shrub + probs.grass) {
        const radius = rng.range(GRASS_RADIUS_MIN, GRASS_RADIUS_MAX);
        if (!isClear(ctx, x, z, radius, roadDist, plazaDist)) continue;
        // 不整形 6 角形(時計回り = 偏角降順。Polygon 規約)
        const polygon: Polygon = [];
        for (let k = 0; k < 6; k++) {
          const a = -(k / 6) * Math.PI * 2;
          const r = radius * rng.range(0.6, 1.0);
          polygon.push({ x: x + r * Math.cos(a), z: z + r * Math.sin(a) });
        }
        grasses.push({
          id: `grass/${ix}_${iz}`,
          polygon,
          thinKey: rng.next(),
        });
      }
    }
  }

  const keptTrees = thinToCap(trees, TREE_MAX);
  const keptShrubs = thinToCap(shrubs, SHRUB_MAX);
  const keptGrasses = thinToCap(grasses, GRASS_MAX);

  // thinKey は間引き専用の内部値のため WorldModel には残さない
  model.vegetation = {
    trees: keptTrees.map((t) => ({
      id: t.id,
      position: t.position,
      form: t.form,
      scale: t.scale,
      rotation: t.rotation,
      colorVar: t.colorVar,
    })),
    shrubs: keptShrubs.map((s) => ({
      id: s.id,
      position: s.position,
      scale: s.scale,
    })),
    grassPatches: keptGrasses.map((g) => ({ id: g.id, polygon: g.polygon })),
  };

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  let violations = 0;
  if (model.vegetation.trees.length > TREE_MAX) violations++;
  if (model.vegetation.shrubs.length > SHRUB_MAX) violations++;
  if (model.vegetation.grassPatches.length > GRASS_MAX) violations++;
  const points: Vec2[] = [
    ...model.vegetation.trees.map((t) => t.position),
    ...model.vegetation.shrubs.map((s) => s.position),
  ];
  for (const p of points) {
    // 水面・道路・建物との衝突(クリアランスなしの最終確認)
    if (ctx.waterSdf(p.x, p.z) < 0) violations++;
    if (roadEdgeDistance(ctx, p.x, p.z) < 0) violations++;
    for (let i = 0; i < model.buildings.length; i++) {
      const bb = ctx.buildingBounds[i];
      const b = model.buildings[i];
      if (!bb || !b) continue;
      if (p.x < bb.minX || p.x > bb.maxX || p.z < bb.minZ || p.z > bb.maxZ) {
        continue;
      }
      if (polygonSignedDistance(p.x, p.z, b.footprint) < 0) violations++;
    }
  }
  if (violations > 0) {
    console.warn(`vegetation: パイプライン内アサーション違反 ${violations} 件`);
  }
}
