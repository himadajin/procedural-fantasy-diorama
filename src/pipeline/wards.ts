/**
 * 段8「結界計画」: 結界環(ringPath / ringSegments)・結界門・魔導塔・聖域・
 * 魔法灯・浮遊要素の位置計画と、結界門スナップ後の BridgeSite 再抽出。
 * データの正は docs/internal/contracts/wards.md(Wards 節)・ground-water.md(Water 節)、
 * 設計は implementation-spec 1.3節(段8)・1.6節・PHASE 3・9節。
 * 立体化は PHASE 5b、デバッグ描画は PHASE 3 commit 11 の担当。
 *
 * ringPath の生成手順(contracts/wards.md):
 *   一次密度場の等値線(marchPositiveRegion)を初期形状
 *   → 中心まわりの偏角リサンプル+循環平滑化(平滑性)
 *   → 星形化(自己交差の除去)
 *   → footprint / 境界マージンへの半径クランプ
 *   → 水域(河川・湖・水路)の径方向回避。回避不能な区間は "overwater"
 *   失敗時は等値線レベルを引き上げ(=囲い半径を縮小して)リトライする。
 *   リトライ回数も乱数ストリーム "wards/ring" から消費して決定性を保つ。
 *   全リトライ失敗時は境界と footprint に収まる円環へフォールバックする。
 */
import { makeRng } from "../rng";
import type { BridgeSite, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  distToPolyline,
  marchPositiveRegion,
  pointInPolygon,
  polygonArea,
  polygonSignedDistance,
} from "../model/waterfield";
import { sampleFieldGrid } from "../model/fieldgrid";
import {
  bridgeBaseId,
  claimId,
  pointAlong,
  segmentIntersection,
  waterCrossings,
} from "../model/geometry";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 結界環の偏角サンプル数(ringPath の点数) */
const RING_SAMPLES = 128;
/** 等値線レベルの基準(densityPeak 比)とリトライごとの引き上げ幅 */
const RING_ISO_BASE = 0.6;
const RING_ISO_STEP = 0.22;
/** 等値線抽出の試行回数(初回+リトライ4回) */
const RING_ATTEMPTS = 5;
/** 等値線抽出のグリッド一辺セル数 */
const RING_MARCH_CELLS = 72;
/** footprint 対角半径への追加マージン(結界環の最小半径) */
const RING_FOOT_MARGIN = 4;
/** 水域回避のクリアランスと径方向探索の刻み */
const RING_WATER_CLEARANCE = 1;
const RING_AVOID_STEP = 1.5;
/** 径方向回避の最大変位(元半径比) */
const RING_AVOID_RATIO = 0.35;
/** 境界マージンのクランプが破綻とみなされる割合 */
const RING_CONFLICT_RATIO = 0.25;
/** 結界門の開口半幅(実寸) = 基準 + gateScale 連動 */
const GATE_OPEN_BASE = 3;
const GATE_OPEN_SCALE = 3;
/** 魔法灯の主道沿い間隔 */
const LAMP_SPACING = 13;
/** BridgeSite 再抽出の標本間隔(段5・段6と同じ) */
const BRIDGE_SAMPLE_STEP = 2;

/** 河川・湖・水路を合成した水域 sdf(正=陸側) */
function combinedWaterSdf(model: WorldModel): (x: number, z: number) => number {
  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );
  const canals = model.water.canals;
  if (canals.length === 0) return field.waterSdf;
  return (x, z) => {
    let d = field.waterSdf(x, z);
    for (const canal of canals) {
      d = Math.min(d, distToPolyline(x, z, canal.points) - canal.width / 2);
    }
    return d;
  };
}

interface RingPlan {
  path: Vec2[];
  /** 点ごとの水中フラグ(overwater 区間の元) */
  inWater: boolean[];
  /** フォールバック円環へ落ちたか(アサーション用) */
  fallback: boolean;
}

/** 中心からのレイと閉多角形の交差半径(最遠)。交差なしは null */
function rayRadius(center: Vec2, dirX: number, dirZ: number, poly: Vec2[]): number | null {
  let best: number | null = null;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (!a || !b) continue;
    // center + r*dir = a + u*(b-a)
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const denom = dirX * ez - dirZ * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const wx = a.x - center.x;
    const wz = a.z - center.z;
    const r = (wx * ez - wz * ex) / denom;
    const u = (wx * dirZ - wz * dirX) / denom;
    if (r >= 0 && u >= -1e-9 && u <= 1 + 1e-9) {
      if (best === null || r > best) best = r;
    }
  }
  return best;
}

/** 循環移動平均による半径列の平滑化 */
function smoothCircular(radii: number[], passes: number, kernel: number[]): void {
  const n = radii.length;
  const half = (kernel.length - 1) / 2;
  let total = 0;
  for (const k of kernel) total += k;
  for (let p = 0; p < passes; p++) {
    const src = radii.slice();
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        sum += (kernel[k] ?? 0) * (src[(i + k - half + n) % n] ?? 0);
      }
      radii[i] = sum / total;
    }
  }
}

/** 結界環を計画する(生成手順はファイル冒頭コメント) */
function planRing(
  model: WorldModel,
  waterSdf: (x: number, z: number) => number,
): RingPlan {
  const { seed, derived } = model.meta;
  const size = model.ground.size;
  const center = model.centerPlan.position;
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const rng = makeRng(seed, "wards/ring");
  const grid = model.density.primary;

  const rMin = (derived.centerFootprint / 2) * Math.SQRT2 + RING_FOOT_MARGIN;
  const margin = Math.max(6, derived.marginWidth * 0.5);
  const dirs: { x: number; z: number }[] = [];
  for (let j = 0; j < RING_SAMPLES; j++) {
    // 偏角を減少方向に回す(Polygon と同じ時計回りの慣例)
    const theta = -(j / RING_SAMPLES) * Math.PI * 2;
    dirs.push({ x: Math.cos(theta), z: Math.sin(theta) });
  }
  const pointAt = (j: number, r: number): Vec2 => {
    const d = dirs[j] ?? { x: 1, z: 0 };
    return { x: center.x + d.x * r, z: center.z + d.z * r };
  };
  /** 境界の内側距離(星形半径による近似。正=境界内) */
  const boundaryInside = (p: Vec2): number =>
    boundaryRadius(Math.atan2(p.z, p.x)) - Math.hypot(p.x, p.z);
  /** 境界マージンを満たす最大半径へ切り詰める */
  const clampToBoundary = (j: number, r: number): number => {
    let rr = r;
    while (rr > rMin && boundaryInside(pointAt(j, rr)) < margin) {
      rr -= 2;
    }
    return Math.max(rMin, rr);
  };

  const finishRadii = (radii: number[], fallback: boolean): RingPlan => {
    // 水域回避(径方向)。回避できない点は水中のまま残し overwater にする
    for (let j = 0; j < RING_SAMPLES; j++) {
      const r = radii[j] ?? rMin;
      const p = pointAt(j, r);
      if (waterSdf(p.x, p.z) >= RING_WATER_CLEARANCE) continue;
      const maxShift = Math.max(4, r * RING_AVOID_RATIO);
      let found = false;
      for (let k = 1; k * RING_AVOID_STEP <= maxShift && !found; k++) {
        for (const sign of [1, -1]) {
          const cand = r + sign * k * RING_AVOID_STEP;
          if (cand < rMin) continue;
          const q = pointAt(j, cand);
          if (boundaryInside(q) < margin) continue;
          if (waterSdf(q.x, q.z) >= RING_WATER_CLEARANCE) {
            radii[j] = cand;
            found = true;
            break;
          }
        }
      }
    }
    // 仕上げの弱い平滑化(星形は保たれ、自己交差は構造的に生じない)
    smoothCircular(radii, 1, [1, 4, 1]);
    for (let j = 0; j < RING_SAMPLES; j++) {
      radii[j] = clampToBoundary(j, Math.max(rMin, radii[j] ?? rMin));
    }
    const path: Vec2[] = [];
    const inWater: boolean[] = [];
    for (let j = 0; j < RING_SAMPLES; j++) {
      const p = pointAt(j, radii[j] ?? rMin);
      path.push(p);
      inWater.push(waterSdf(p.x, p.z) < 0);
    }
    return { path, inWater, fallback };
  };

  if (grid) {
    const dens = (x: number, z: number): number => sampleFieldGrid(grid, x, z);
    for (let attempt = 0; attempt < RING_ATTEMPTS; attempt++) {
      // リトライ回数も同一ストリームから消費する(試行ごとに1値)
      const jitter = rng.range(-0.03, 0.03);
      const iso =
        derived.densityPeak * (RING_ISO_BASE + RING_ISO_STEP * attempt) + jitter;
      const march = marchPositiveRegion(
        (x, z) => dens(x, z) - iso,
        size,
        RING_MARCH_CELLS,
      );
      let contour: Vec2[] | null = null;
      let contourArea = -Infinity;
      for (const c of march.contours) {
        if (!c.closed || c.points.length < 8) continue;
        if (!pointInPolygon(center.x, center.z, c.points)) continue;
        const area = polygonArea(c.points);
        if (area > contourArea) {
          contourArea = area;
          contour = c.points;
        }
      }
      if (!contour) continue;

      // 星形化: 偏角リサンプル(自己交差の除去)
      const radii: number[] = [];
      let rayFailed = false;
      for (let j = 0; j < RING_SAMPLES; j++) {
        const d = dirs[j] ?? { x: 1, z: 0 };
        const r = rayRadius(center, d.x, d.z, contour);
        if (r === null || r <= 0) {
          rayFailed = true;
          break;
        }
        radii.push(r);
      }
      if (rayFailed) continue;

      // 循環平滑化(平滑性)
      smoothCircular(radii, 2, [1, 2, 3, 2, 1]);

      // footprint / 境界マージンへのクランプ
      let conflicts = 0;
      for (let j = 0; j < RING_SAMPLES; j++) {
        const clamped = clampToBoundary(j, Math.max(rMin, radii[j] ?? rMin));
        if (
          clamped <= rMin &&
          boundaryInside(pointAt(j, clamped)) < margin
        ) {
          conflicts++;
        }
        radii[j] = clamped;
      }
      if (conflicts > RING_SAMPLES * RING_CONFLICT_RATIO) continue;

      return finishRadii(radii, false);
    }
  }

  // フォールバック: 境界と footprint に収まる円環
  const base = clamp(derived.densityFalloff * size * 0.7, rMin, size * 0.35);
  const radii: number[] = [];
  for (let j = 0; j < RING_SAMPLES; j++) {
    radii.push(clampToBoundary(j, base));
  }
  return finishRadii(radii, true);
}

interface GateInfo {
  id: string;
  position: Vec2;
  angle: number;
  roadEdgeId: string;
  /** ringPath 上の実数インデックス(門開口の切り出しに使う) */
  ringPos: number;
}

/**
 * 結界環×道路 edge の全交点に結界門を置き、交点を edge.path へ挿入する
 * (局所スナップ。道路の大規模な引き直しはしない)。
 */
function planGates(model: WorldModel, ring: Vec2[]): GateInfo[] {
  const gates: GateInfo[] = [];
  const counts = new Map<string, number>();
  const n = ring.length;
  for (const edge of model.network.edges) {
    const crossings: {
      pi: number;
      t: number;
      ringPos: number;
      point: Vec2;
      angle: number;
    }[] = [];
    for (let i = 0; i + 1 < edge.path.length; i++) {
      const a = edge.path[i];
      const b = edge.path[i + 1];
      if (!a || !b) continue;
      for (let j = 0; j < n; j++) {
        const c = ring[j];
        const d = ring[(j + 1) % n];
        if (!c || !d) continue;
        const hit = segmentIntersection(a, b, c, d);
        if (!hit) continue;
        crossings.push({
          pi: i,
          t: hit.t,
          ringPos: j + hit.u,
          point: hit.point,
          angle: Math.atan2(b.z - a.z, b.x - a.x),
        });
      }
    }
    if (crossings.length === 0) continue;
    crossings.sort((p, q) => p.pi - q.pi || p.t - q.t);
    // 交点を path へ挿入(降順 splice でインデックスを保つ)
    const newPath = edge.path.slice();
    for (let k = crossings.length - 1; k >= 0; k--) {
      const cr = crossings[k];
      if (!cr) continue;
      newPath.splice(cr.pi + 1, 0, cr.point);
    }
    edge.path = newPath;
    for (const cr of crossings) {
      gates.push({
        id: claimId(counts, `gate/${edge.id}`),
        position: cr.point,
        angle: cr.angle,
        roadEdgeId: edge.id,
        ringPos: cr.ringPos,
      });
    }
  }
  return gates;
}

/**
 * ringSegments を確定する。overwater(水中の辺)→ 門開口(gap)→
 * 閉じ率 wallClosure で残りの弧に wall / gap を割り付ける。
 */
function planSegments(
  model: WorldModel,
  ring: Vec2[],
  inWater: boolean[],
  gates: GateInfo[],
): { start: number; end: number; kind: "wall" | "overwater" | "gap" }[] {
  const { seed, derived } = model.meta;
  const n = ring.length;
  if (n === 0) return [];

  // 辺の弧長と累積位置
  const edgeLen: number[] = [];
  const sPoint: number[] = [];
  let perimeter = 0;
  for (let k = 0; k < n; k++) {
    sPoint.push(perimeter);
    const a = ring[k];
    const b = ring[(k + 1) % n];
    const len = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
    edgeLen.push(len);
    perimeter += len;
  }
  const circDist = (a: number, b: number): number => {
    const d = Math.abs(a - b) % perimeter;
    return Math.min(d, perimeter - d);
  };

  // 1) 水中の辺は overwater
  const kinds: ("wall" | "overwater" | "gap" | null)[] = [];
  for (let k = 0; k < n; k++) {
    const wet = (inWater[k] ?? false) || (inWater[(k + 1) % n] ?? false);
    kinds.push(wet ? "overwater" : null);
  }

  // 2) 門開口(gap)
  const openHalf = GATE_OPEN_BASE + GATE_OPEN_SCALE * derived.gateScale;
  for (const gate of gates) {
    const j = Math.floor(gate.ringPos) % n;
    const frac = gate.ringPos - Math.floor(gate.ringPos);
    const gateS = (sPoint[j] ?? 0) + (edgeLen[j] ?? 0) * frac;
    for (let k = 0; k < n; k++) {
      if (kinds[k] === "overwater") continue;
      const midS = (sPoint[k] ?? 0) + (edgeLen[k] ?? 0) / 2;
      if (circDist(midS, gateS) <= openHalf) kinds[k] = "gap";
    }
  }

  // 3) 残りの弧へ閉じ率 wallClosure で wall / gap を割り付ける
  const closure = clamp(derived.wallClosure, 0, 1);
  const unassigned: number[] = [];
  for (let k = 0; k < n; k++) if (kinds[k] === null) unassigned.push(k);
  const allFree = unassigned.length === n;
  if (allFree) {
    // 予約辺なし(門・水域なし): 開始位相を乱数で決めた単一の wall 弧
    const rng = makeRng(seed, "wards/segments");
    const startIdx = rng.int(0, n - 1);
    const wallCount = Math.round(n * closure);
    for (let k = 0; k < n; k++) {
      kinds[k] = (k - startIdx + n) % n < wallCount ? "wall" : "gap";
    }
  } else if (unassigned.length > 0) {
    // 予約辺(門・水域)で区切られた弧ごとに、中央 closure 割合を wall にする
    // 弧の起点: 予約辺の直後から始まる連続 run を円環順に列挙する
    const isFree = (k: number): boolean => kinds[k] === null;
    let cursor = 0;
    while (!isFree(cursor) || isFree((cursor - 1 + n) % n)) {
      cursor++;
      if (cursor >= n) break; // 全周 free は上で処理済みのため到達しない
    }
    let k = cursor % n;
    let steps = 0;
    while (steps < n) {
      if (!isFree(k)) {
        k = (k + 1) % n;
        steps++;
        continue;
      }
      const run: number[] = [];
      while (isFree(k) && run.length < n) {
        run.push(k);
        k = (k + 1) % n;
        steps++;
      }
      const wallCount = Math.round(run.length * closure);
      const head = Math.floor((run.length - wallCount) / 2);
      for (let i = 0; i < run.length; i++) {
        const idx = run[i];
        if (idx === undefined) continue;
        kinds[idx] = i >= head && i < head + wallCount ? "wall" : "gap";
      }
    }
  }

  // 4) 連長圧縮して区間 [start, end) に符号化(start 昇順・全周被覆)
  const segments: { start: number; end: number; kind: "wall" | "overwater" | "gap" }[] = [];
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || kinds[i] !== kinds[runStart]) {
      segments.push({
        start: runStart,
        end: i,
        kind: kinds[runStart] ?? "gap",
      });
      runStart = i;
    }
  }
  return segments;
}

/** 魔導塔の位置計画(屈曲点・間隔規則・水辺/門・橋詰め近傍) */
function planTowers(
  model: WorldModel,
  ring: Vec2[],
  inWater: boolean[],
  gates: GateInfo[],
  waterSdf: (x: number, z: number) => number,
): WorldModel["wards"]["towers"] {
  const { seed, derived } = model.meta;
  if (derived.wardLevel < 2 || ring.length === 0) return [];
  const n = ring.length;

  const sPoint: number[] = [];
  let perimeter = 0;
  for (let k = 0; k < n; k++) {
    sPoint.push(perimeter);
    const a = ring[k];
    const b = ring[(k + 1) % n];
    perimeter += a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
  }
  const circDist = (a: number, b: number): number => {
    const d = Math.abs(a - b) % perimeter;
    return Math.min(d, perimeter - d);
  };

  // 採点: 屈曲点 + 水辺近接 + 門・橋詰め近傍(=広場が置かれる位置の代替)
  const scores: { j: number; score: number }[] = [];
  for (let j = 0; j < n; j++) {
    if (inWater[j]) continue;
    const p = ring[j];
    const prev = ring[(j - 1 + n) % n];
    const next = ring[(j + 1) % n];
    if (!p || !prev || !next) continue;
    if (waterSdf(p.x, p.z) < 0.5) continue;
    let nearGate = Infinity;
    for (const g of gates) {
      nearGate = Math.min(
        nearGate,
        Math.hypot(g.position.x - p.x, g.position.z - p.z),
      );
    }
    if (nearGate < 5) continue; // 門の開口部そのものには置かない
    const a1 = Math.atan2(p.z - prev.z, p.x - prev.x);
    const a2 = Math.atan2(next.z - p.z, next.x - p.x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = Math.PI * 2 - turn;
    let nearBridge = Infinity;
    for (const br of model.water.bridges) {
      nearBridge = Math.min(
        nearBridge,
        Math.hypot(br.position.x - p.x, br.position.z - p.z),
      );
    }
    const waterProx = Math.exp(-Math.max(0, waterSdf(p.x, p.z)) / 25);
    const siteProx = Math.exp(-Math.min(nearGate, nearBridge) / 30);
    scores.push({ j, score: 1.5 * turn + 0.8 * waterProx + 0.7 * siteProx });
  }

  const target = clamp(
    Math.round(
      (3 + 7 * derived.towerScale) * (derived.wardLevel === 3 ? 1 : 0.6),
    ),
    2,
    12,
  );
  const minArc = (perimeter / target) * 0.55;
  scores.sort((a, b) => b.score - a.score || a.j - b.j);
  const chosen: number[] = [];
  for (const cand of scores) {
    if (chosen.length >= target) break;
    let ok = true;
    for (const c of chosen) {
      if (circDist(sPoint[cand.j] ?? 0, sPoint[c] ?? 0) < minArc) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(cand.j);
  }
  chosen.sort((a, b) => a - b);

  const towers: WorldModel["wards"]["towers"] = [];
  for (const j of chosen) {
    const p = ring[j];
    if (!p) continue;
    const rng = makeRng(seed, `wards/tower/ring/${j}`);
    towers.push({
      id: `tower/ring/${j}`,
      position: { x: p.x, z: p.z },
      height: (9 + 9 * derived.towerScale) * (0.92 + 0.16 * rng.next()),
      onRing: true,
    });
  }

  // 結界環外・水辺の独立塔(towerScale 高・wardLevel 3)
  if (derived.wardLevel === 3 && derived.towerScale > 0.5) {
    const grid = model.density.primary;
    const wanted = derived.towerScale > 0.8 ? 2 : 1;
    const candidates: { p: Vec2; density: number; id: string }[] = [];
    for (let li = 0; li < model.water.shoreline.loops.length; li++) {
      const loop = model.water.shoreline.loops[li];
      if (!loop) continue;
      for (let pi = 0; pi < loop.points.length; pi += 6) {
        const sp = loop.points[pi];
        const nm = loop.normals[pi];
        if (!sp || !nm) continue;
        const p = { x: sp.x + nm.x * 3, z: sp.z + nm.z * 3 };
        if (!pointInPolygon(p.x, p.z, ring)) continue;
        if (waterSdf(p.x, p.z) < 1) continue;
        const density = grid ? sampleFieldGrid(grid, p.x, p.z) : 0;
        if (density < 0.3) continue;
        candidates.push({ p, density, id: `tower/water/${li}_${pi}` });
      }
    }
    candidates.sort((a, b) => b.density - a.density || (a.id < b.id ? -1 : 1));
    const placed: Vec2[] = towers.map((t) => t.position);
    for (const cand of candidates) {
      if (towers.length >= chosen.length + wanted) break;
      let ok = true;
      for (const q of placed) {
        if (Math.hypot(q.x - cand.p.x, q.z - cand.p.z) < 18) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const rng = makeRng(seed, `wards/${cand.id}`);
      towers.push({
        id: cand.id,
        position: cand.p,
        height: (10 + 10 * derived.towerScale) * (0.92 + 0.16 * rng.next()),
        onRing: false,
      });
      placed.push(cand.p);
    }
  }
  return towers;
}

/** 聖域・祠: 道路・水域から離れた静かな場所へ 1〜2 箇所(shrineRate 駆動) */
function planShrines(
  model: WorldModel,
  ring: Vec2[],
  waterSdf: (x: number, z: number) => number,
): WorldModel["wards"]["shrines"] {
  const { seed, params, derived } = model.meta;
  if (derived.wardLevel < 1) return [];
  const center = model.centerPlan.position;
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const arcana01 = params.arcana / 100;

  // 消費順・消費数固定: roll(1) + 2 候補 × 3 値 = 7 値
  const rng = makeRng(seed, "wards/shrine");
  const secondRoll = rng.next();
  const draws: { angle: number; radPick: number; kindRoll: number }[] = [];
  for (let k = 0; k < 2; k++) {
    draws.push({
      angle: rng.range(0, Math.PI * 2),
      radPick: rng.next(),
      kindRoll: rng.next(),
    });
  }
  const count = 1 + (secondRoll < derived.shrineRate * 0.6 ? 1 : 0);

  // 結界環の平均半径(位置の基準)
  let ringR = model.ground.size * 0.25;
  if (ring.length > 0) {
    let sum = 0;
    for (const p of ring) sum += Math.hypot(p.x - center.x, p.z - center.z);
    ringR = sum / ring.length;
  }

  const distToRoads = (p: Vec2): number => {
    let best = Infinity;
    for (const edge of model.network.edges) {
      best = Math.min(best, distToPolyline(p.x, p.z, edge.path));
    }
    return best;
  };
  const foot = model.centerPlan.footprint;
  const isQuiet = (p: Vec2): boolean => {
    const bIn = boundaryRadius(Math.atan2(p.z, p.x)) - Math.hypot(p.x, p.z);
    if (bIn < 4) return false;
    if (waterSdf(p.x, p.z) < 3) return false;
    if (distToRoads(p) < 5) return false;
    if (foot.length >= 3 && polygonSignedDistance(p.x, p.z, foot) < 2) {
      return false;
    }
    return true;
  };

  const shrines: WorldModel["wards"]["shrines"] = [];
  for (let k = 0; k < count; k++) {
    const draw = draws[k];
    if (!draw) continue;
    // 1 箇所目は中心付近、2 箇所目は外縁の静かな場所(implementation-spec)
    const r =
      k === 0 ? (0.35 + 0.25 * draw.radPick) * ringR : (0.7 + 0.2 * draw.radPick) * ringR;
    const p0 = {
      x: center.x + Math.cos(draw.angle) * r,
      z: center.z + Math.sin(draw.angle) * r,
    };
    // 決定論的な局所探索(近い候補から遠くへ)
    let placed: Vec2 | null = null;
    outer: for (let ringStep = 0; ringStep <= 6; ringStep++) {
      const rr = ringStep * 4;
      const dirCount = ringStep === 0 ? 1 : 8;
      for (let d = 0; d < dirCount; d++) {
        const a = (d / dirCount) * Math.PI * 2;
        const q = { x: p0.x + Math.cos(a) * rr, z: p0.z + Math.sin(a) * rr };
        if (isQuiet(q)) {
          placed = q;
          break outer;
        }
      }
    }
    if (!placed) continue;
    // kind: Arcana が高いほど crystals 寄りの重み
    const wStones = Math.max(0.05, 1 - arcana01 * 0.7);
    const wShrine = 1;
    const wCrystals = 0.3 + arcana01;
    const total = wStones + wShrine + wCrystals;
    const roll = draw.kindRoll * total;
    const kind: "shrine" | "stones" | "crystals" =
      roll < wStones ? "stones" : roll < wStones + wShrine ? "shrine" : "crystals";
    shrines.push({ id: `shrine/${k}`, position: placed, kind });
  }
  return shrines;
}

/** 魔法灯: 主道・橋詰め・門前・中心 footprint 前の候補から lampDensity で採択 */
function planLamps(
  model: WorldModel,
  gates: GateInfo[],
  waterSdf: (x: number, z: number) => number,
): WorldModel["wards"]["lamps"] {
  const { seed, derived } = model.meta;
  const lampDensity = derived.lampDensity;
  if (lampDensity <= 0) return [];
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const landOk = (p: Vec2): boolean =>
    waterSdf(p.x, p.z) > 0.6 &&
    boundaryRadius(Math.atan2(p.z, p.x)) - Math.hypot(p.x, p.z) > 1;

  const lamps: WorldModel["wards"]["lamps"] = [];
  // 主道沿い(等間隔候補。候補ごとの独立サブストリームで lampDensity に単調)
  for (const edge of model.network.edges) {
    if (edge.class !== "main") continue;
    const total = (() => {
      let len = 0;
      for (let i = 0; i + 1 < edge.path.length; i++) {
        const a = edge.path[i];
        const b = edge.path[i + 1];
        if (!a || !b) continue;
        len += Math.hypot(b.x - a.x, b.z - a.z);
      }
      return len;
    })();
    let k = 0;
    for (let s = LAMP_SPACING / 2; s < total; s += LAMP_SPACING, k++) {
      const rng = makeRng(seed, `wards/lamp/${edge.id}/${k}`);
      if (!rng.chance(lampDensity)) continue;
      const { p, angle } = pointAlong(edge.path, s);
      const side = k % 2 === 0 ? 1 : -1;
      const off = edge.width / 2 + 1.0;
      const q = {
        x: p.x + Math.cos(angle + Math.PI / 2) * off * side,
        z: p.z + Math.sin(angle + Math.PI / 2) * off * side,
      };
      if (!landOk(q)) continue;
      lamps.push({ id: `lamp/${edge.id}/${k}`, position: q });
    }
  }
  // 橋詰め(両袂)
  for (const bridge of model.water.bridges) {
    for (const [si, sign] of [1, -1].entries()) {
      const rng = makeRng(seed, `wards/lamp/bridge/${bridge.id}/${si}`);
      if (!rng.chance(Math.min(1, lampDensity * 1.6))) continue;
      const q = {
        x: bridge.position.x + Math.cos(bridge.angle) * (bridge.length / 2 + 1.6) * sign,
        z: bridge.position.z + Math.sin(bridge.angle) * (bridge.length / 2 + 1.6) * sign,
      };
      if (!landOk(q)) continue;
      lamps.push({ id: `lamp/bridge/${bridge.id}/${si}`, position: q });
    }
  }
  // 結界門前(両脇)
  for (const gate of gates) {
    for (const [si, sign] of [1, -1].entries()) {
      const rng = makeRng(seed, `wards/lamp/gate/${gate.id}/${si}`);
      if (!rng.chance(Math.min(1, lampDensity * 1.5))) continue;
      const q = {
        x: gate.position.x + Math.cos(gate.angle + Math.PI / 2) * 2.6 * sign,
        z: gate.position.z + Math.sin(gate.angle + Math.PI / 2) * 2.6 * sign,
      };
      if (!landOk(q)) continue;
      lamps.push({ id: `lamp/gate/${gate.id}/${si}`, position: q });
    }
  }
  // 中心 footprint 前(=中心前広場の位置。広場は段9確定のための代替候補)
  const foot = model.centerPlan.footprint;
  for (let ci = 0; ci < foot.length; ci++) {
    const v = foot[ci];
    if (!v) continue;
    const rng = makeRng(seed, `wards/lamp/center/${ci}`);
    if (!rng.chance(lampDensity)) continue;
    const c = model.centerPlan.position;
    const dx = v.x - c.x;
    const dz = v.z - c.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const q = { x: v.x + (dx / len) * 1.5, z: v.z + (dz / len) * 1.5 };
    if (!landOk(q)) continue;
    lamps.push({ id: `lamp/center/${ci}`, position: q });
  }
  return lamps;
}

/** 浮遊要素: 塔・門・聖域の近傍クラスタ(floaterAmount 駆動) */
function planFloaters(
  model: WorldModel,
  gates: GateInfo[],
): WorldModel["wards"]["floaters"] {
  const { seed, derived } = model.meta;
  const amount = derived.floaterAmount;
  if (amount <= 0) return [];
  const anchors: { id: string; x: number; z: number; baseY: number }[] = [];
  for (const t of model.wards.towers) {
    anchors.push({ id: t.id, x: t.position.x, z: t.position.z, baseY: t.height * 0.75 });
  }
  for (const g of gates) {
    anchors.push({ id: g.id, x: g.position.x, z: g.position.z, baseY: 6 });
  }
  for (const s of model.wards.shrines) {
    anchors.push({ id: s.id, x: s.position.x, z: s.position.z, baseY: 3.5 });
  }
  const floaters: WorldModel["wards"]["floaters"] = [];
  for (const anchor of anchors) {
    const rng = makeRng(seed, `wards/floater/${anchor.id}`);
    const count = Math.round(amount * rng.range(1.2, 3.4));
    for (let j = 0; j < count; j++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(1.5, 5.5);
      const dy = rng.range(0, 4);
      const size = rng.range(0.35, 1.0);
      floaters.push({
        id: `floater/${anchor.id}/${j}`,
        anchorId: anchor.id,
        basePosition: {
          x: anchor.x + Math.cos(a) * d,
          y: anchor.baseY + dy,
          z: anchor.z + Math.sin(a) * d,
        },
        size,
      });
    }
  }
  return floaters;
}

/**
 * BridgeSite を全道路 edge について再抽出する(結界門スナップ後の正)。
 * 河川・湖・水路を合成した水域で標本化し、over は中点で最も深い水域要素。
 */
function reextractBridges(
  model: WorldModel,
  waterSdf: (x: number, z: number) => number,
): void {
  const counts = new Map<string, number>();
  const bridges: BridgeSite[] = [];
  for (const edge of model.network.edges) {
    for (const crossing of waterCrossings(edge.path, waterSdf, BRIDGE_SAMPLE_STEP)) {
      const p = crossing.position;
      let over: BridgeSite["over"] = "river";
      let best = Infinity;
      for (const river of model.water.rivers) {
        const d = distToPolyline(p.x, p.z, river.points) - river.width / 2;
        if (d < best) {
          best = d;
          over = "river";
        }
      }
      for (const lake of model.water.lakes) {
        const d = polygonSignedDistance(p.x, p.z, lake);
        if (d < best) {
          best = d;
          over = "lake";
        }
      }
      for (const canal of model.water.canals) {
        const d = distToPolyline(p.x, p.z, canal.points) - canal.width / 2;
        if (d < best) {
          best = d;
          over = "canal";
        }
      }
      bridges.push({
        id: claimId(counts, bridgeBaseId(p)),
        position: p,
        angle: crossing.angle,
        width: edge.width,
        length: crossing.length,
        over,
        roadClass: edge.class,
      });
    }
  }
  model.water.bridges = bridges;
  model.summary.waterOverview.bridges = bridges.length;
}

/** パイプライン段の実体: wards 一式と bridges 再抽出、wardOverview 部分埋め */
export function runWards(model: WorldModel): void {
  const { derived } = model.meta;
  const waterSdf = combinedWaterSdf(model);
  const wards = model.wards;
  wards.wardLevel = derived.wardLevel;
  wards.ringPath = [];
  wards.ringSegments = [];
  wards.towers = [];
  wards.gates = [];
  wards.shrines = [];
  wards.lamps = [];
  wards.floaters = [];

  let assertionViolations = 0;
  let ringLength = 0;

  if (derived.wardLevel >= 1) {
    const ring = planRing(model, waterSdf);
    wards.ringPath = ring.path;
    if (ring.fallback) assertionViolations++;

    // 結界門(wardLevel ≥ 2)。交点を edge.path へ局所スナップする
    const gates = derived.wardLevel >= 2 ? planGates(model, ring.path) : [];

    // 結界門スナップ後に BridgeSite を全道路について再抽出する(契約)
    reextractBridges(model, waterSdf);

    wards.ringSegments = planSegments(model, ring.path, ring.inWater, gates);
    wards.towers = planTowers(model, ring.path, ring.inWater, gates, waterSdf);
    wards.gates = gates.map((g) => ({
      id: g.id,
      position: g.position,
      angle: g.angle,
      roadEdgeId: g.roadEdgeId,
    }));
    wards.shrines = planShrines(model, ring.path, waterSdf);
    wards.lamps = planLamps(model, gates, waterSdf);
    wards.floaters = planFloaters(model, gates);

    // --- パイプライン内アサーション(throw せず件数を console に出す) ---
    const n = ring.path.length;
    for (let k = 0; k < n; k++) {
      const a = ring.path[k];
      const b = ring.path[(k + 1) % n];
      if (a && b) ringLength += Math.hypot(b.x - a.x, b.z - a.z);
    }
    // 1) 閉ループが中心を囲む
    if (!pointInPolygon(model.centerPlan.position.x, model.centerPlan.position.z, ring.path)) {
      assertionViolations++;
    }
    // 2) 非自己交差(全ペア検査。隣接辺は共有点のため除外)
    for (let i = 0; i < n; i++) {
      const a = ring.path[i];
      const b = ring.path[(i + 1) % n];
      if (!a || !b) continue;
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = ring.path[j];
        const d = ring.path[(j + 1) % n];
        if (!c || !d) continue;
        if (segmentIntersection(a, b, c, d)) assertionViolations++;
      }
    }
    // 3) 結界横断道路はすべて門位置を通る(wardLevel ≥ 2)
    if (derived.wardLevel >= 2) {
      for (const edge of model.network.edges) {
        for (let i = 0; i + 1 < edge.path.length; i++) {
          const a = edge.path[i];
          const b = edge.path[i + 1];
          if (!a || !b) continue;
          for (let j = 0; j < n; j++) {
            const c = ring.path[j];
            const d = ring.path[(j + 1) % n];
            if (!c || !d) continue;
            const hit = segmentIntersection(a, b, c, d);
            if (!hit) continue;
            let near = Infinity;
            for (const g of gates) {
              near = Math.min(
                near,
                Math.hypot(g.position.x - hit.point.x, g.position.z - hit.point.z),
              );
            }
            if (near > 1) assertionViolations++;
          }
        }
      }
      for (const g of gates) {
        const edge = model.network.edges.find((e) => e.id === g.roadEdgeId);
        if (!edge || distToPolyline(g.position.x, g.position.z, edge.path) > 0.5) {
          assertionViolations++;
        }
      }
    }
    // 4) wall 区間は接地(水中でない)。overwater は検証から除外
    for (const seg of wards.ringSegments) {
      if (seg.kind !== "wall") continue;
      for (let k = seg.start; k < seg.end; k++) {
        const p = ring.path[k % n];
        if (p && waterSdf(p.x, p.z) < 0) assertionViolations++;
      }
    }
  } else {
    // wardLevel 0 でも bridges の最終状態は段8の再抽出を正とする(契約)
    reextractBridges(model, waterSdf);
  }

  // 5) 水域を渡る道路区間はすべて BridgeSite を持つ(抽出と同じ標本化で再検証)
  let recheckTotal = 0;
  for (const edge of model.network.edges) {
    recheckTotal += waterCrossings(edge.path, waterSdf, BRIDGE_SAMPLE_STEP).length;
  }
  if (recheckTotal !== model.water.bridges.length) assertionViolations++;

  if (assertionViolations > 0) {
    console.warn(`wards: パイプライン内アサーション違反 ${assertionViolations} 件`);
  }

  // サマリー(段13 の担当だが、中間PHASEでは部分的に埋める)
  model.summary.wardOverview = {
    level: wards.wardLevel,
    ringLength,
    towers: wards.towers.length,
    gates: wards.gates.length,
    shrines: wards.shrines.length,
    floaters: wards.floaters.length,
  };
}
