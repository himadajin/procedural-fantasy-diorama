/**
 * 段6「水路」: canalScore 発火で川・湖から分岐して中心域を通る水路を計画し、
 * 道路との交差区間を BridgeSite として仮追加する。
 * データの正は docs/internal/contracts/ground-water.md(Water 節)、
 * 設計は implementation-spec 1.3節(段6)・PHASE 3・9節(リスクと対策)。
 *
 * - 水路は waterfield・岸線・zoneMask に影響させない(護岸で縁取られた
 *   掘り込みチャネルとして扱う設計判断。contracts/ground-water.md)。
 *   立体化(水面+護岸+杭)と zoneMask 上書きは PHASE 3 commit 11 の担当
 * - 水路 1 本が生む BridgeSite は最大 3。超過時は経路と蛇行を縮めて交差が
 *   減る方向へ再サンプルし、3 回のリトライで収まらなければ棄却する
 *   (リトライ回数も乱数ストリーム "canals/canal/<i>" から消費して決定性を保つ)
 * - 全水路が棄却された場合のフォールバック: 中心へ最も近い水域から伸びる
 *   短い堀留(始端のみ接続)を、交差が 3 以下になる長さへ切り詰めて 1 本置く
 * - 経由点は主道どうしの角度間隙へ向け、道路交差の発生を構造的に抑える
 * - 始端・終端の接続部を除き、中間点は既存水域(川・湖)の外へ押し出す
 *   (川筋の中を走る水路は「街の水路」として現れないため。
 *   contracts/ground-water.md Water 節)
 */
import { makeRng } from "../rng";
import type { Canal, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  distToPolyline,
  fieldGradient,
  polygonSignedDistance,
  type WaterField,
} from "../model/waterfield";
import { fbm2D, noiseSeed } from "./noise";
import {
  bridgeBaseId,
  chaikin,
  claimId,
  pathLength,
  pointAlong,
  resamplePath,
  waterCrossings,
} from "../model/geometry";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 発火条件(implementation-spec 1.6節) */
const CANAL_FIRE_THRESHOLD = 0.35;
/** 本数の増分スコア幅(canalScore がこの幅を超えるごとに +1 本) */
const CANAL_COUNT_STEP = 0.18;
/** 本数の上限 */
const CANAL_COUNT_MAX = 3;
/** 水路 1 本が生む BridgeSite の上限(implementation-spec 9節) */
const CANAL_MAX_BRIDGES = 3;
/** 再サンプルのリトライ回数(初回+3回=最大4試行) */
const CANAL_RETRIES = 3;
/** 交差抽出の標本間隔(段5の橋抽出と同じ) */
const CANAL_SAMPLE_STEP = 2;
/** 点列の間隔(幅比)。契約の「隣接間隔 ≤ 幅×1.5」より狭く取る */
const CANAL_SPACING_RATIO = 1.2;
/** 幅: 川幅に対する比率と実寸クランプ(川より細い) */
const CANAL_WIDTH_RATIO = 0.35;
const CANAL_WIDTH_MIN = 2.2;
const CANAL_WIDTH_MAX = 5;
/** 蛇行の振幅(実寸)。川(worldSize 比)より控えめ */
const CANAL_MEANDER_AMP = 7;
/** 始端・終端アンカーの最小距離 */
const ANCHOR_MIN_SEPARATION = 30;
/** footprint からのクリアランス */
const FOOTPRINT_CLEARANCE = 3;
/** 境界内へのクリアランス */
const BOUNDARY_CLEARANCE = 3;

/** 既存水域(川・湖)上の分岐候補点を決定論的に列挙する */
function buildAnchors(model: WorldModel, field: WaterField): Vec2[] {
  const anchors: Vec2[] = [];
  for (const river of model.water.rivers) {
    const total = pathLength(river.points);
    const step = Math.max(12, river.width * 2.5);
    for (let s = step; s < total - step; s += step) {
      const { p } = pointAlong(river.points, s);
      if (field.boundarySdf(p.x, p.z) > river.width) anchors.push(p);
    }
  }
  for (const lake of model.water.lakes) {
    // 湖は縁の頂点を重心側へ寄せた内側点(確実に水中)
    let cx = 0;
    let cz = 0;
    for (const v of lake) {
      cx += v.x;
      cz += v.z;
    }
    const n = Math.max(1, lake.length);
    cx /= n;
    cz /= n;
    for (let i = 0; i < lake.length; i += 3) {
      const v = lake[i];
      if (!v) continue;
      const p = { x: v.x * 0.75 + cx * 0.25, z: v.z * 0.75 + cz * 0.25 };
      if (field.boundarySdf(p.x, p.z) > 4 && field.waterSdf(p.x, p.z) < 0) {
        anchors.push(p);
      }
    }
  }
  return anchors;
}

/**
 * 中心ノードに接続する道路の方向を集め、最大の角度間隙(中央と幅)を返す。
 * 水路の経由点をこの間隙へ向けることで道路交差(=BridgeSite)を抑える。
 */
function mainRoadGap(model: WorldModel): { mid: number; width: number } {
  const c = model.centerPlan.position;
  const dirs: number[] = [];
  for (const edge of model.network.edges) {
    const path = edge.path;
    if (path.length < 2) continue;
    const head = path[0];
    const tail = path[path.length - 1];
    if (!head || !tail) continue;
    if (Math.hypot(head.x - c.x, head.z - c.z) < 1e-6) {
      const q = path[1];
      if (q) dirs.push(Math.atan2(q.z - c.z, q.x - c.x));
    } else if (Math.hypot(tail.x - c.x, tail.z - c.z) < 1e-6) {
      const q = path[path.length - 2];
      if (q) dirs.push(Math.atan2(q.z - c.z, q.x - c.x));
    }
  }
  if (dirs.length === 0) return { mid: 0, width: Math.PI * 2 };
  if (dirs.length === 1) {
    const d = dirs[0] ?? 0;
    return { mid: d + Math.PI, width: Math.PI * 2 };
  }
  dirs.sort((a, b) => a - b);
  let bestGap = -Infinity;
  let bestMid = 0;
  for (let i = 0; i < dirs.length; i++) {
    const a = dirs[i] ?? 0;
    const b = i + 1 < dirs.length ? (dirs[i + 1] ?? 0) : (dirs[0] ?? 0) + Math.PI * 2;
    const gap = b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = a + gap / 2;
    }
  }
  return { mid: bestMid, width: bestGap };
}

/** 経路を境界内へクランプし、centerPlan.footprint から遠ざける(決定論的) */
function enforceCorridor(
  points: Vec2[],
  model: WorldModel,
  radius: (theta: number) => number,
  clearance: number,
): void {
  const foot = model.centerPlan.footprint;
  const center = model.centerPlan.position;
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    // 境界クランプ(径方向)
    const r = Math.hypot(p.x, p.z);
    if (r > 1e-9) {
      const maxR = radius(Math.atan2(p.z, p.x)) - BOUNDARY_CLEARANCE;
      if (r > maxR && maxR > 0) {
        p.x *= maxR / r;
        p.z *= maxR / r;
      }
    }
    // footprint 回避(中心から離す)
    if (foot.length >= 3) {
      for (let k = 0; k < 8; k++) {
        if (polygonSignedDistance(p.x, p.z, foot) >= clearance) break;
        const dx = p.x - center.x;
        const dz = p.z - center.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) {
          p.x += 2;
        } else {
          p.x += (dx / len) * 2;
          p.z += (dz / len) * 2;
        }
      }
    }
  }
}

/**
 * 経路の中間点を既存水域(川・湖)の外へ押し出す
 * (contracts/ground-water.md Water 節。目安は「中心線の waterSdf ≥ 幅/2 + 1」)。
 *
 * - 始端・終端の接続窓(弧長 width×2+4)は水域接続のため押し出さない
 * - 深い点(waterSdf < −(幅/2+6))は水域横断・湖内の接続部とみなし保持する
 * - 水中の連続区間ごとに平均勾配で「どちらの岸へ出すか」を1回だけ決め、
 *   区間内の全点を同じ側へ押す(点ごとの最近岸に任せると川筋を挟んで
 *   互い違いの岸へ跳ねてジグザグになるため)。決定論的で乱数を消費しない
 */
function enforceLand(points: Vec2[], field: WaterField, width: number): void {
  const clear = width / 2 + 1;
  const escapeDepth = -(width / 2 + 6);
  const endWindow = width * 2 + 4;
  const total = pathLength(points);
  if (total <= endWindow * 2) return;

  // 各点の弧長位置
  const arc: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    arc.push(
      (arc[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0),
    );
  }

  const movable = (i: number): boolean => {
    if (i <= 0 || i + 1 >= points.length) return false;
    const s = arc[i] ?? 0;
    if (s < endWindow || s > total - endWindow) return false;
    const p = points[i];
    if (!p) return false;
    const d = field.waterSdf(p.x, p.z);
    return d < clear && d > escapeDepth;
  };

  let i = 0;
  while (i < points.length) {
    if (!movable(i)) {
      i++;
      continue;
    }
    // 水中の連続区間 [i, j)
    let j = i;
    while (j < points.length && movable(j)) j++;
    // 区間の平均勾配から押し出す側を1回だけ決める
    let gx = 0;
    let gz = 0;
    for (let k = i; k < j; k++) {
      const p = points[k];
      if (!p) continue;
      const g = fieldGradient(field.waterSdf, p.x, p.z);
      gx += g.x;
      gz += g.z;
    }
    const glen = Math.hypot(gx, gz);
    const dir = glen > 1e-6 ? { x: gx / glen, z: gz / glen } : { x: 1, z: 0 };
    for (let k = i; k < j; k++) {
      const p = points[k];
      if (!p) continue;
      for (let it = 0; it < 20; it++) {
        const d = field.waterSdf(p.x, p.z);
        if (d >= clear) break;
        const step = Math.min(2.5, clear - d + 0.3);
        p.x += dir.x * step;
        p.z += dir.z * step;
      }
    }
    i = j;
  }
}

/** 間隔が maxSpacing を超える辺に中点を挿入して契約の連続性を満たす */
function subdivideToSpacing(points: Vec2[], maxSpacing: number): Vec2[] {
  let pts = points;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      if (!a) continue;
      out.push(a);
      const b = pts[i + 1];
      if (!b) continue;
      if (Math.hypot(b.x - a.x, b.z - a.z) > maxSpacing) {
        out.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
        changed = true;
      }
    }
    pts = out;
    if (!changed) break;
  }
  return pts;
}

/** 水路の点列を制御点+蛇行ノイズから組み立てる(純関数) */
function buildCanalPath(
  seed: string,
  canalIndex: number,
  attempt: number,
  a: Vec2,
  via: Vec2,
  b: Vec2,
  width: number,
  meander: number,
  model: WorldModel,
  field: WaterField,
  radius: (theta: number) => number,
): Vec2[] {
  const m1 = { x: (a.x + via.x) / 2, z: (a.z + via.z) / 2 };
  const m2 = { x: (via.x + b.x) / 2, z: (via.z + b.z) / 2 };
  let pts: Vec2[] = [a, m1, via, m2, b];
  pts = chaikin(chaikin(chaikin(pts)));
  pts = resamplePath(pts, width * CANAL_SPACING_RATIO);

  // 蛇行(格子ノイズ。点数の増減が乱数消費に波及しない)。端は水域内に固定
  const nSeed = noiseSeed(seed, `canals/meander/${canalIndex}/${attempt}`);
  const total = pathLength(pts);
  if (total > 1e-6) {
    let acc = 0;
    for (let i = 1; i + 1 < pts.length; i++) {
      const prev = pts[i - 1];
      const p = pts[i];
      const next = pts[i + 1];
      if (!prev || !p || !next) continue;
      acc += Math.hypot(p.x - prev.x, p.z - prev.z);
      const t = acc / total;
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-9) continue;
      const envelope = Math.sin(Math.PI * t);
      const noise = fbm2D(nSeed, t * 4, 0, 2) * 2 - 1;
      const off = noise * CANAL_MEANDER_AMP * meander * envelope;
      p.x += (-dz / len) * off;
      p.z += (dx / len) * off;
    }
  }

  // 中間点を水域外へ → 境界・footprint 回避 → リサンプル後にもう一巡
  // (押し出しどうしの相互作用を弧長の均しごと収束させる)。
  // 最後の Chaikin は押し出しの継ぎ目に残る折れを均す
  enforceLand(pts, field, width);
  enforceCorridor(pts, model, radius, FOOTPRINT_CLEARANCE);
  pts = resamplePath(pts, width * CANAL_SPACING_RATIO);
  enforceLand(pts, field, width);
  enforceCorridor(pts, model, radius, FOOTPRINT_CLEARANCE * 0.5);
  pts = chaikin(pts);
  return subdivideToSpacing(pts, width * 1.45);
}

/**
 * 経路の中間部(接続窓を除く)の陸上率。押し出し後もこの値が低い経路は
 * 水中に沈んだままで「街の水路」として現れない(contracts/ground-water.md)
 */
function midLandFraction(
  points: Vec2[],
  field: WaterField,
  width: number,
): number {
  const endWindow = width * 2 + 4;
  const total = pathLength(points);
  if (total <= endWindow * 2) return 0;
  let land = 0;
  let count = 0;
  for (let s = endWindow; s <= total - endWindow; s += 2) {
    const { p } = pointAlong(points, s);
    if (field.waterSdf(p.x, p.z) >= 0) land++;
    count++;
  }
  return count > 0 ? land / count : 0;
}

/**
 * 中間部の陸上率の下限(これ未満はリトライ)。全試行が満たさない場合は
 * 交差上限を満たす試行のうち陸上率最大のものを受理する(水域が広い設定で
 * 良路の全滅により本数の単調性を壊さないため。contracts/ground-water.md)
 */
const CANAL_MIN_LAND_FRACTION = 0.7;

/** 水路コリドーの符号付き距離(負=水路内) */
function canalSdf(points: Vec2[], width: number) {
  return (x: number, z: number): number =>
    distToPolyline(x, z, points) - width / 2;
}

/** この水路が全道路 edge に生む交差(=BridgeSite)数を数える */
function countRoadCrossings(
  model: WorldModel,
  points: Vec2[],
  width: number,
): number {
  const sdf = canalSdf(points, width);
  let count = 0;
  for (const edge of model.network.edges) {
    count += waterCrossings(edge.path, sdf, CANAL_SAMPLE_STEP).length;
  }
  return count;
}

/**
 * 水路 1 本を計画する。交差が上限を超えたら経路と蛇行を縮めて再サンプルし、
 * CANAL_RETRIES 回のリトライで収まらなければ null(棄却)。
 * 乱数はストリーム "canals/canal/<i>" から試行ごとに固定数を消費する
 * (リトライ回数もストリームに含まれる)。
 */
function planCanal(
  model: WorldModel,
  field: WaterField,
  anchors: Vec2[],
  gap: { mid: number; width: number },
  canalIndex: number,
  width: number,
  radius: (theta: number) => number,
): Canal | null {
  const { seed, derived } = model.meta;
  const center = model.centerPlan.position;
  const footHalf = derived.centerFootprint / 2;
  const rng = makeRng(seed, `canals/canal/${canalIndex}`);
  // 陸上率の下限を満たさないが交差上限は満たす試行のうちの最良(縮退受理用)
  let bestFallback: { canal: Canal; landFraction: number } | null = null;

  for (let attempt = 0; attempt <= CANAL_RETRIES; attempt++) {
    // 消費数は試行ごとに固定(6値)
    const startPick = rng.next();
    const endPick = rng.next();
    const viaJitter = rng.next();
    const viaRadiusPick = rng.next();
    const meanderPick = rng.range(0.5, 1);
    const sidePick = rng.next();

    const n = anchors.length;
    const si = Math.min(n - 1, Math.floor(startPick * n));
    const a = anchors[si];
    if (!a) continue;
    // 終端: 始端から一定距離以上のアンカーを決定論的に探す
    let ei = Math.min(n - 1, Math.floor(endPick * n));
    let b: Vec2 | null = null;
    for (let k = 0; k < n; k++) {
      const cand = anchors[(ei + k) % n];
      if (!cand) continue;
      if (Math.hypot(cand.x - a.x, cand.z - a.z) >= ANCHOR_MIN_SEPARATION) {
        ei = (ei + k) % n;
        b = cand;
        break;
      }
    }
    if (!b) b = anchors[(si + Math.max(1, Math.floor(n / 2))) % n] ?? a;

    // リトライほど蛇行と間隙内の振れを縮め、交差が減る方向へ寄せる
    const shrink = 1 - 0.28 * attempt;
    const viaAngle =
      gap.mid + (viaJitter - 0.5) * gap.width * 0.5 * Math.max(0.2, shrink);
    const viaDist =
      footHalf * 1.35 + viaRadiusPick * Math.max(4, derived.centerPlazaRadius);
    const via = {
      x: center.x + Math.cos(viaAngle) * viaDist,
      z: center.z + Math.sin(viaAngle) * viaDist,
    };
    // 経由点が水中なら陸側へ押し出す(contracts/ground-water.md Water 節)
    for (let k = 0; k < 20; k++) {
      const d = field.waterSdf(via.x, via.z);
      if (d >= width / 2 + 1) break;
      const g = fieldGradient(field.waterSdf, via.x, via.z);
      const len = Math.hypot(g.x, g.z);
      const step = Math.min(2.5, width / 2 + 1 - d + 0.3);
      if (len < 1e-6) via.x += step;
      else {
        via.x += (g.x / len) * step;
        via.z += (g.z / len) * step;
      }
    }

    const points = buildCanalPath(
      seed,
      canalIndex,
      attempt,
      a,
      via,
      b,
      width,
      meanderPick * Math.max(0.15, shrink),
      model,
      field,
      radius,
    );
    if (points.length < 2) continue;
    // 受理条件: 交差上限と、中間部が陸上に出ていること(沈んだ水路は
    // 「街の水路」として現れないため棄却してリトライ。contracts)
    if (countRoadCrossings(model, points, width) > CANAL_MAX_BRIDGES) continue;
    const canal: Canal = {
      points,
      width,
      id: `canal/${canalIndex}`,
      towpathSide: sidePick < 0.5 ? 1 : -1,
    };
    const landFraction = midLandFraction(points, field, width);
    if (landFraction >= CANAL_MIN_LAND_FRACTION) return canal;
    if (!bestFallback || landFraction > bestFallback.landFraction) {
      bestFallback = { canal, landFraction };
    }
  }
  // 全試行が陸上率を満たさない場合の縮退受理(本数の単調性を優先)
  return bestFallback ? bestFallback.canal : null;
}

/**
 * フォールバックの堀留: 水域のアンカーから中心域へ向かう短い水路。
 * 終端は陸上へ押し出して「街区内で止まる」を保証し(見えない水中の堀留を
 * 作らない。contracts/ground-water.md)、終端が中心へ最も近くなるアンカーを
 * 決定論的に選ぶ。交差が上限以下になる弧長へ切り詰める(始端のみ水域接続)。
 */
function planFallbackCanal(
  model: WorldModel,
  field: WaterField,
  anchors: Vec2[],
  width: number,
  radius: (theta: number) => number,
): Canal | null {
  const { derived } = model.meta;
  const center = model.centerPlan.position;
  const footHalf = derived.centerFootprint / 2;
  const clear = width / 2 + 1;
  const minLen = Math.max(width * 3, 26);

  let best: { start: Vec2; end: Vec2; score: number } | null = null;
  for (const p of anchors) {
    const dx = center.x - p.x;
    const dz = center.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const stop = len - (footHalf * 1.4 + FOOTPRINT_CLEARANCE);
    if (stop < minLen) continue;
    const end = { x: p.x + (dx / len) * stop, z: p.z + (dz / len) * stop };
    // 終端が水中なら陸側へ押し出す
    for (let k = 0; k < 20; k++) {
      const d = field.waterSdf(end.x, end.z);
      if (d >= clear) break;
      const g = fieldGradient(field.waterSdf, end.x, end.z);
      const glen = Math.hypot(g.x, g.z);
      const step = Math.min(2.5, clear - d + 0.3);
      if (glen < 1e-6) end.x += step;
      else {
        end.x += (g.x / glen) * step;
        end.z += (g.z / glen) * step;
      }
    }
    if (field.waterSdf(end.x, end.z) < clear) continue;
    if (field.boundarySdf(end.x, end.z) < BOUNDARY_CLEARANCE) continue;
    const score = Math.hypot(end.x - center.x, end.z - center.z);
    if (!best || score < best.score) best = { start: p, end, score };
  }
  if (!best) return null;

  let pts = resamplePath([best.start, best.end], width * CANAL_SPACING_RATIO);
  enforceLand(pts, field, width);
  enforceCorridor(pts, model, radius, FOOTPRINT_CLEARANCE);
  pts = subdivideToSpacing(pts, width * 1.45);

  // 4 つ目以降の交差の手前へ切り詰める
  for (let guard = 0; guard < 6; guard++) {
    const crossings = countRoadCrossings(model, pts, width);
    if (crossings <= CANAL_MAX_BRIDGES) break;
    // 交差位置を水路弧長に射影し、上限を超える最初の交差の手前で切る
    const sdf = canalSdf(pts, width);
    const sList: number[] = [];
    for (const edge of model.network.edges) {
      for (const c of waterCrossings(edge.path, sdf, CANAL_SAMPLE_STEP)) {
        // 交差中点に最も近い水路上の弧長
        let acc = 0;
        let bestS = 0;
        let bestDist = Infinity;
        for (let i = 0; i + 1 < pts.length; i++) {
          const p = pts[i];
          const q = pts[i + 1];
          if (!p || !q) continue;
          const seg = Math.hypot(q.x - p.x, q.z - p.z);
          const d = Math.hypot(c.position.x - p.x, c.position.z - p.z);
          if (d < bestDist) {
            bestDist = d;
            bestS = acc;
          }
          acc += seg;
        }
        sList.push(bestS);
      }
    }
    sList.sort((u, v) => u - v);
    const cutAt = sList[CANAL_MAX_BRIDGES];
    if (cutAt === undefined) break;
    const cutLen = Math.max(width * 3, cutAt - width - 2);
    const total = pathLength(pts);
    if (cutLen >= total) break;
    const keep = Math.max(2, Math.ceil(cutLen / (width * CANAL_SPACING_RATIO)));
    const shortened: Vec2[] = [];
    for (let i = 0; i <= keep; i++) {
      shortened.push(pointAlong(pts, (i / keep) * cutLen).p);
    }
    pts = shortened;
  }
  if (countRoadCrossings(model, pts, width) > CANAL_MAX_BRIDGES) return null;
  if (pathLength(pts) < width * 3) return null;
  return { points: pts, width, id: "canal/fallback", towpathSide: 1 };
}

/** パイプライン段の実体: water.canals と water.bridges(仮追加)を埋める */
export function runCanals(model: WorldModel): void {
  const { derived } = model.meta;
  model.water.canals = [];

  const fired = derived.canalScore >= CANAL_FIRE_THRESHOLD;
  const hasWater =
    model.water.rivers.length > 0 || model.water.lakes.length > 0;
  if (!fired || !hasWater) {
    model.summary.waterOverview.canals = 0;
    return;
  }

  const field = createWaterField(
    model.ground.boundary,
    model.water.rivers,
    model.water.lakes,
  );
  const radius = createBoundaryRadius(model.ground.boundary);
  const anchors = buildAnchors(model, field);
  if (anchors.length === 0) {
    model.summary.waterOverview.canals = 0;
    return;
  }

  // 幅は川より細い(契約: 最終河川幅×0.35 基準、最小河川幅×0.8 上限)
  let minRiverWidth = Infinity;
  for (const river of model.water.rivers) {
    minRiverWidth = Math.min(minRiverWidth, river.width);
  }
  let width = clamp(
    CANAL_WIDTH_RATIO *
      (Number.isFinite(minRiverWidth) ? minRiverWidth : derived.riverWidth),
    CANAL_WIDTH_MIN,
    CANAL_WIDTH_MAX,
  );
  if (Number.isFinite(minRiverWidth)) {
    width = Math.min(width, minRiverWidth * 0.8);
  }

  const gap = mainRoadGap(model);
  const planned = Math.min(
    CANAL_COUNT_MAX,
    1 + Math.floor((derived.canalScore - CANAL_FIRE_THRESHOLD) / CANAL_COUNT_STEP),
  );

  const canals: Canal[] = [];
  for (let i = 0; i < planned; i++) {
    const canal = planCanal(model, field, anchors, gap, i, width, radius);
    if (canal) canals.push(canal);
  }
  // 全滅時のフォールバック(堀留)。デフォルト全50の「必ず1本以上」を守る
  if (canals.length === 0) {
    const fallback = planFallbackCanal(model, field, anchors, width, radius);
    if (fallback) canals.push(fallback);
  }
  model.water.canals = canals;

  // BridgeSite の仮追加(id 体系は段5と共通。段8が全道路で再抽出して置き換える)
  const idCounts = new Map<string, number>();
  for (const bridge of model.water.bridges) {
    const parts = bridge.id.split("/");
    const base = parts.slice(0, 2).join("/");
    idCounts.set(base, (idCounts.get(base) ?? 0) + 1);
  }
  let assertionViolations = 0;
  for (const canal of canals) {
    const sdf = canalSdf(canal.points, canal.width);
    let perCanal = 0;
    for (const edge of model.network.edges) {
      for (const c of waterCrossings(edge.path, sdf, CANAL_SAMPLE_STEP)) {
        perCanal++;
        model.water.bridges.push({
          id: claimId(idCounts, bridgeBaseId(c.position)),
          position: c.position,
          angle: c.angle,
          width: edge.width,
          length: c.length,
          over: "canal",
          roadClass: edge.class,
        });
      }
    }
    if (perCanal > CANAL_MAX_BRIDGES) assertionViolations++;
  }
  model.summary.waterOverview.canals = canals.length;
  model.summary.waterOverview.bridges = model.water.bridges.length;

  // パイプライン内アサーション: 違反は throw せず件数を console に出す
  // (implementation-spec 1.10節)
  for (const canal of canals) {
    const head = canal.points[0];
    const tail = canal.points[canal.points.length - 1];
    if (!head) {
      assertionViolations++;
      continue;
    }
    // 始端は必ず既存水域(フォールバック堀留も同様)
    if (field.waterSdf(head.x, head.z) >= 0) assertionViolations++;
    // 終端は既存水域(堀留のみ例外)
    if (
      canal.id !== "canal/fallback" &&
      tail &&
      field.waterSdf(tail.x, tail.z) >= 0
    ) {
      assertionViolations++;
    }
    // 境界内・間隔・幅
    if (canal.width >= (Number.isFinite(minRiverWidth) ? minRiverWidth : Infinity)) {
      assertionViolations++;
    }
    for (let i = 1; i + 1 < canal.points.length; i++) {
      const p = canal.points[i];
      if (!p) continue;
      if (field.boundarySdf(p.x, p.z) < 0) assertionViolations++;
    }
    for (let i = 0; i + 1 < canal.points.length; i++) {
      const p = canal.points[i];
      const q = canal.points[i + 1];
      if (!p || !q) continue;
      if (Math.hypot(q.x - p.x, q.z - p.z) > canal.width * 1.5) {
        assertionViolations++;
      }
    }
  }
  if (assertionViolations > 0) {
    console.warn(
      `canals: パイプライン内アサーション違反 ${assertionViolations} 件`,
    );
  }
}
