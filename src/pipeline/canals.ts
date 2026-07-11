/**
 * 段6「水路」: canalScore 発火で湖・池から分岐して中心域を通る水路を計画し、
 * 道路との交差区間を BridgeSite として仮追加する。
 * データの正は docs/internal/contracts/ground-water.md(Water 節)、
 * 設計は implementation-spec 1.3節(段6)・PHASE 3・9節(リスクと対策)。
 *
 * - 水路は waterfield・岸線・zoneMask に影響させない(護岸で縁取られた
 *   掘り込みチャネルとして扱う設計判断。contracts/ground-water.md)。
 *   立体化(水面+護岸+杭)と zoneMask 上書きは PHASE 3 commit 11 の担当
 * - 水路 1 本が生む BridgeSite は最大 3。超過時は経路と蛇行を縮めて交差が
 *   減る方向へ再サンプルし、25 回のリトライで収まらなければ棄却する
 *   (リトライ回数も乱数ストリーム "canals/canal/<i>" から消費して決定性を保つ。
 *   2026-07-12 タスク A7 で形状健全性検査を追加した際、3 回から 25 回へ
 *   引き上げた。contracts/ground-water.md「水路の性質」)
 * - 単一交差の渡り長は max(18, 幅×6) 以下。超える交差(道路との長距離の
 *   並走・重なり)を生む試行は交差超過と同様に棄却する(2026-07-12 追記)
 * - 形状健全性(2026-07-12 追記): 自己近接・既存水路との重なり・迂曲率
 *   (経路長÷始終点直線距離)を受理条件に加える。違反は交差超過と同様に
 *   棄却する。経由点は水路 index ごとに異なる主道間隙へ向けて束なりを
 *   緩和する(contracts/ground-water.md「水路の性質」形状健全性)
 * - 全水路が棄却された場合のフォールバック: 中心へ最も近い水域から伸びる
 *   短い堀留(始端のみ接続)を、交差が 3 以下になる長さへ切り詰めて 1 本置く
 * - 経由点は主道どうしの角度間隙へ向け、道路交差の発生を構造的に抑える
 * - 始端・終端の接続部を除き、中間点は既存水域(湖・池)の外へ押し出す
 *   (水域の中を走る水路は「街の水路」として現れないため。
 *   contracts/ground-water.md Water 節)
 */
import { makeRng } from "../rng";
import type { Canal, ShoreLoop, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  distToPolyline,
  fieldGradient,
  polygonSignedDistance,
  waterBodies,
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

/** 発火条件(implementation-spec 1.6節) */
const CANAL_FIRE_THRESHOLD = 0.35;
/** 本数の増分スコア幅(canalScore がこの幅を超えるごとに +1 本) */
const CANAL_COUNT_STEP = 0.18;
/** 本数の上限 */
const CANAL_COUNT_MAX = 3;
/** 水路 1 本が生む BridgeSite の上限(implementation-spec 9節) */
const CANAL_MAX_BRIDGES = 3;
/**
 * 再サンプルのリトライ回数(初回+25回=最大26試行)。2026-07-12 タスク A7 で
 * 形状健全性検査(自己近接・既存水路との重なり・迂曲率)を受理条件に
 * 追加した際、旧・3回のリトライでは(anchors の組み合わせが少ない
 * seed で)条件を満たす候補もフォールバック堀留の候補も見つからず
 * 水路が全滅する個体が実測で複数見つかったため、3 から 25 へ引き上げた
 * (contracts/ground-water.md「水路の性質」)
 */
const CANAL_RETRIES = 25;
/** 交差抽出の標本間隔(段5の橋抽出と同じ) */
const CANAL_SAMPLE_STEP = 2;
/** 点列の間隔(幅比)。契約の「隣接間隔 ≤ 幅×1.5」より狭く取る */
const CANAL_SPACING_RATIO = 1.2;
/** 蛇行の振幅(実寸)。worldSize 比ではなく実寸の控えめな値 */
const CANAL_MEANDER_AMP = 7;
/** 始端・終端アンカーの最小距離 */
const ANCHOR_MIN_SEPARATION = 30;
/**
 * アンカー候補の弧長間隔(岸線ループ沿い)。廃止済みの旧・水域沿い等間隔点の
 * 間隔(実寸 12.5〜40)の上限側と同程度に取る。
 * 間隔を狭くすると、蛇行(meander)が強い水路で近接しすぎたアンカー対が
 * 選ばれやすくなり、水路が鋭く折り返す形状(ヘアピン)を誘発して
 * 岸沿い道(towpath)の左右判定が局所的に破綻しうる(実装中に検証済み)ため、
 * この上限側を採用してアンカー間隔を広めに保つ
 */
const CANAL_ANCHOR_SPACING = 40;
/** 岸線点を法線の逆(水側)へ押し込む量。目安 1.5(contracts/ground-water.md) */
const CANAL_ANCHOR_PUSH = 1.5;
/** footprint からのクリアランス */
const FOOTPRINT_CLEARANCE = 3;
/** 境界内へのクリアランス */
const BOUNDARY_CLEARANCE = 3;
/**
 * 形状健全性(2026-07-12 追記。contracts/ground-water.md「水路の性質」)。
 * 受け入れ検収で発見した自己ヘアピン・水路間の重なり・とぐろ状の迂曲を
 * 受理条件で排除するための係数
 */
const CANAL_SELF_PROXIMITY_ARC_RATIO = 6;
const CANAL_SELF_PROXIMITY_DIST_RATIO = 2.5;
const CANAL_MIN_CANAL_SEPARATION_RATIO = 3;
const CANAL_MAX_SINUOSITY = 3.0;
/** 経由点の分散に用いる主道間隙の最大件数 */
const CANAL_GAP_CANDIDATES = 3;

/** 岸線ループの弧長配列(閉環は末尾→先頭の閉じ辺を含めて周回する) */
function loopArcLengths(loop: ShoreLoop): number[] {
  const pts = loop.points;
  const n = pts.length;
  const segCount = loop.closed ? n : n - 1;
  const arc: number[] = [0];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const d = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
    arc.push((arc[arc.length - 1] ?? 0) + d);
  }
  return arc;
}

/**
 * 岸線ループ(湖・池の shoreline.loops)沿いの等間隔点を分岐候補にする
 * (contracts/ground-water.md Water 節)。
 * 各岸線点を法線(水域→陸向き)の逆方向(水側)へ CANAL_ANCHOR_PUSH だけ
 * 押し込み、waterSdf < 0(既存水域内)を満たす点だけを採用する。
 * 決定論的な弧長走査のみで乱数は消費しない。
 */
function buildAnchors(model: WorldModel, field: WaterField): Vec2[] {
  const anchors: Vec2[] = [];
  for (const loop of model.water.shoreline.loops) {
    const pts = loop.points;
    const normals = loop.normals;
    if (pts.length < 2) continue;
    const arc = loopArcLengths(loop);
    const total = arc[arc.length - 1] ?? 0;
    if (total <= 0) continue;
    // 開いた岸線は境界と交わる両端を避ける。閉じた岸線(湖・池。通常はこちら)は全周を使う
    const start = loop.closed ? 0 : CANAL_ANCHOR_SPACING;
    const end = loop.closed ? total : total - CANAL_ANCHOR_SPACING;
    if (end <= start) continue;
    let vi = 0;
    for (let s = start; s < end; s += CANAL_ANCHOR_SPACING) {
      while (vi + 1 < arc.length && (arc[vi + 1] ?? 0) < s) vi++;
      const p = pts[vi];
      const normal = normals[vi];
      if (!p || !normal) continue;
      const candidate = {
        x: p.x - normal.x * CANAL_ANCHOR_PUSH,
        z: p.z - normal.z * CANAL_ANCHOR_PUSH,
      };
      if (field.waterSdf(candidate.x, candidate.z) < 0) anchors.push(candidate);
    }
  }
  return anchors;
}

/**
 * 中心ノードに接続する道路の方向を集め、角度間隙(中央と幅)を広い順に
 * 最大 CANAL_GAP_CANDIDATES 件返す。水路の経由点を間隙へ向けることで
 * 道路交差(=BridgeSite)を抑える。
 *
 * 2026-07-12 追記(A7): 単一の最大間隙だけを返すと全水路の経由点が
 * 同じ方向へ束なり、水路どうしが密集・交差しやすくなる(実測:
 * everdusk-102 / water=100 で水路間距離 0.0)。呼び出し元
 * (runCanals)は水路 index ごとに `gaps[index % gaps.length]` で
 * 異なる間隙を割り当て、経由点の分散を図る(間隙が1件しかない場合は
 * 従来どおり全水路が同一間隙を向く。この場合も自己近接・水路間間隔・
 * 迂曲率の形状検査が束なりを排除する)。
 */
function mainRoadGaps(model: WorldModel): { mid: number; width: number }[] {
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
  if (dirs.length === 0) return [{ mid: 0, width: Math.PI * 2 }];
  if (dirs.length === 1) {
    const d = dirs[0] ?? 0;
    return [{ mid: d + Math.PI, width: Math.PI * 2 }];
  }
  dirs.sort((a, b) => a - b);
  const gaps: { mid: number; width: number }[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const a = dirs[i] ?? 0;
    const b = i + 1 < dirs.length ? (dirs[i + 1] ?? 0) : (dirs[0] ?? 0) + Math.PI * 2;
    const gap = b - a;
    gaps.push({ mid: a + gap / 2, width: gap });
  }
  gaps.sort((x, y) => y.width - x.width);
  return gaps.slice(0, CANAL_GAP_CANDIDATES);
}

/**
 * 自己近接の禁止(contracts/ground-water.md「水路の性質」形状健全性(1))。
 * 弧長で width×6 以上離れた点対の実距離が width×2.5 未満ならヘアピン状の
 * 折り返しとみなし違反とする。決定論的・乱数非消費。点数は高々数百のため
 * O(n²) で十分(実装コメントの通り)。
 */
function selfProximityViolation(points: Vec2[], width: number): boolean {
  const n = points.length;
  if (n < 2) return false;
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) {
    const a = points[i - 1];
    const b = points[i];
    arc.push((arc[i - 1] ?? 0) + (a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0));
  }
  const minArc = width * CANAL_SELF_PROXIMITY_ARC_RATIO;
  const minDist = width * CANAL_SELF_PROXIMITY_DIST_RATIO;
  for (let i = 0; i < n; i++) {
    const pi = points[i];
    if (!pi) continue;
    for (let j = i + 1; j < n; j++) {
      const pj = points[j];
      if (!pj) continue;
      if ((arc[j] ?? 0) - (arc[i] ?? 0) < minArc) continue;
      if (Math.hypot(pj.x - pi.x, pj.z - pi.z) < minDist) return true;
    }
  }
  return false;
}

/**
 * 既存水路との最小間隔(contracts/ground-water.md「水路の性質」形状健全性(2))。
 * 候補点列の全点が、確定済み(accepted)の各水路の全点との距離
 * width×3 以上であることを要求する。フォールバック堀留にも適用する。
 * 決定論的・乱数非消費。
 */
function existingCanalProximityViolation(
  points: Vec2[],
  width: number,
  accepted: readonly Canal[],
): boolean {
  if (accepted.length === 0) return false;
  const minDist = width * CANAL_MIN_CANAL_SEPARATION_RATIO;
  for (const p of points) {
    for (const c of accepted) {
      for (const q of c.points) {
        if (Math.hypot(p.x - q.x, p.z - q.z) < minDist) return true;
      }
    }
  }
  return false;
}

/**
 * 迂曲率(経路長 ÷ 始終点直線距離)。contracts/ground-water.md「水路の性質」
 * 形状健全性(3)。0除算回避に chord の下限 1e-6 を用いる。
 */
function sinuosityRatio(points: Vec2[]): number {
  const head = points[0];
  const tail = points[points.length - 1];
  if (!head || !tail) return 1;
  const chord = Math.max(1e-6, Math.hypot(tail.x - head.x, tail.z - head.z));
  return pathLength(points) / chord;
}

/** 2つの角度(ラジアン)の最短角距離([0, π]) */
function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/**
 * 経由点の方向として使う間隙を選ぶ(形状健全性・実装中に発見した補正)。
 *
 * 経由点の分散(contracts/ground-water.md「水路の性質」形状健全性(4))は
 * 水路 index ごとに割り当てた間隙(`preferred`)へ経由点を向けるが、
 * 割り当てられた間隙の方向が始端・終端アンカー対の方位(中心から見た
 * アンカー対の中点方向)と大きく食い違う場合、経由点が水域の反対側へ
 * 強制され、経路が一旦大きく逆側へ回り込んでから戻る「とぐろ」状の
 * 迂曲(自己近接・迂曲率超過)を誘発する(2026-07-12 実装中に発見。
 * everdusk-101 / seed-b の default 付近で、割り当てられた最大間隙が
 * 池の位置と正反対の方位にあり、4回の全試行が自己近接・迂曲率超過で
 * 棄却され、フォールバック堀留も候補を持てず水路が全滅する実例を確認)。
 * 割り当てられた間隙とアンカー対方位の角距離が 90° を超える場合のみ、
 * 候補間隙(最大3件)からアンカー対方位に最も近いものへ差し替える
 * (経路の道路交差抑制という間隙選定の目的は保ちつつ、構造的に
 * 到達不能な方向への強制を避ける)。
 */
function pickViaGap(
  gaps: readonly { mid: number; width: number }[],
  preferred: { mid: number; width: number },
  pairAngle: number,
): { mid: number; width: number } {
  if (angularDiff(preferred.mid, pairAngle) <= Math.PI / 2) return preferred;
  let best = preferred;
  let bestDiff = angularDiff(preferred.mid, pairAngle);
  for (const g of gaps) {
    const d = angularDiff(g.mid, pairAngle);
    if (d < bestDiff) {
      bestDiff = d;
      best = g;
    }
  }
  return best;
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
 * 経路の中間点を既存水域(湖・池)の外へ押し出す
 * (contracts/ground-water.md Water 節。目安は「中心線の waterSdf ≥ 幅/2 + 1」)。
 *
 * - 始端・終端の接続窓(弧長 width×2+4)は水域接続のため押し出さない
 * - 接続窓を除く水中の点は、深さに関わらず**例外なく**岸へ押し出す
 *   (2026-07-11 導入の「深い横断部(waterSdf < −(幅/2+6))は対象外」の例外は
 *   タスク A4 で撤廃した。水域を横断する水路が堤防ごと湖を渡る破綻を防ぐため。
 *   contracts/ground-water.md「水路の性質」)
 * - 水中の連続区間ごとに平均勾配で「どちらの岸へ出すか」を1回だけ決め、
 *   区間内の全点を同じ側へ押す(点ごとの最近岸に任せると水域を挟んで
 *   互い違いの岸へ跳ねてジグザグになるため)。決定論的で乱数を消費しない
 */
function enforceLand(points: Vec2[], field: WaterField, width: number): void {
  const clear = width / 2 + 1;
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
    return d < clear;
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
 * 棄却する(2026-07-11 撤廃: 旧仕様にあった「陸上率最大の試行を受理する」
 * 救済は行わない。全水路棄却時はフォールバックの堀留へ縮退する。
 * contracts/ground-water.md「水路の性質」。閾値は旧仕様の 0.7 から
 * タスク A4 で 0.95 へ引き上げた)
 */
const CANAL_MIN_LAND_FRACTION = 0.95;

/** 水路コリドーの符号付き距離(負=水路内) */
function canalSdf(points: Vec2[], width: number) {
  return (x: number, z: number): number =>
    distToPolyline(x, z, points) - width / 2;
}

/**
 * 水路×道路の単一交差(BridgeSite)の渡り長の上限
 * (contracts/ground-water.md「水路の性質」。2026-07-12 追記の並走破綻対策:
 * 個数上限 3 だけでは、道路と水路が長距離で並走・重なりして 1 つの巨大な
 * 「橋」になる破綻(harbor-1 / water=100 で渡り長 134.6 を実測)を防げない)
 */
function crossingLengthLimit(width: number): number {
  return Math.max(18, width * 6);
}

/**
 * この水路が全道路 edge に生む交差(=BridgeSite)の数と最大渡り長。
 *
 * - 個数は候補水路単体のコリドーで数える(「水路 1 本あたり最大 3」の契約)
 * - 渡り長は確定済みの他の水路(siblings)とコリドーを合成した水域で測る。
 *   段8「結界計画」の再抽出は全水路を合成した水域で標本化するため、
 *   隣接する水路コリドーが連結して 1 つの長い渡りになる場合を含めないと
 *   最終的な BridgeSite の渡り長上限を保証できない(harbor-1 / water=100 で
 *   単体 29.7+10.7 の交差が連結して渡り長 37 になる例を実測。
 *   contracts/ground-water.md「水路の性質」)
 */
function roadCrossingStats(
  model: WorldModel,
  points: Vec2[],
  width: number,
  siblings: readonly Canal[],
): { count: number; maxLength: number } {
  const own = canalSdf(points, width);
  const merged =
    siblings.length === 0
      ? own
      : (x: number, z: number): number => {
          let d = own(x, z);
          for (const c of siblings) {
            d = Math.min(d, distToPolyline(x, z, c.points) - c.width / 2);
          }
          return d;
        };
  let count = 0;
  let maxLength = 0;
  for (const edge of model.network.edges) {
    count += waterCrossings(edge.path, own, CANAL_SAMPLE_STEP).length;
    for (const c of waterCrossings(edge.path, merged, CANAL_SAMPLE_STEP)) {
      maxLength = Math.max(maxLength, c.length);
    }
  }
  return { count, maxLength };
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
  gaps: readonly { mid: number; width: number }[],
  canalIndex: number,
  width: number,
  radius: (theta: number) => number,
  accepted: readonly Canal[],
): Canal | null {
  const { seed, derived } = model.meta;
  const center = model.centerPlan.position;
  const footHalf = derived.centerFootprint / 2;
  const rng = makeRng(seed, `canals/canal/${canalIndex}`);

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

    // 経由点が向かう間隙(形状健全性(4)。実装中に発見した補正: 割り当てられた
    // 間隙がアンカー対の方位と大きく食い違う場合は近い間隙へ差し替える。
    // pickViaGap のコメント参照)
    const pairAngle = Math.atan2(
      (a.z + b.z) / 2 - center.z,
      (a.x + b.x) / 2 - center.x,
    );
    const effectiveGap = pickViaGap(gaps, gap, pairAngle);

    // リトライほど蛇行と間隙内の振れを縮め、交差が減る方向へ寄せる
    const shrink = 1 - 0.28 * attempt;
    const viaAngle =
      effectiveGap.mid +
      (viaJitter - 0.5) * effectiveGap.width * 0.5 * Math.max(0.2, shrink);
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
    // 受理条件: 交差の個数上限・単一交差の渡り長上限(確定済み水路との
    // コリドー合成水域で判定)と、中間部が陸上に出ていること(沈んだ水路は
    // 「街の水路」として現れないため棄却してリトライ。
    // contracts/ground-water.md「水路の性質」)
    const stats = roadCrossingStats(model, points, width, accepted);
    if (stats.count > CANAL_MAX_BRIDGES) continue;
    if (stats.maxLength > crossingLengthLimit(width)) continue;
    // 形状健全性(2026-07-12 追記。自己近接・既存水路との重なり・迂曲率。
    // contracts/ground-water.md「水路の性質」)。乱数消費に影響しない
    // 決定論的な検査のみで、違反は交差超過と同様に棄却してリトライする
    if (selfProximityViolation(points, width)) continue;
    if (existingCanalProximityViolation(points, width, accepted)) continue;
    if (sinuosityRatio(points) > CANAL_MAX_SINUOSITY) continue;
    const canal: Canal = {
      points,
      width,
      id: `canal/${canalIndex}`,
      towpathSide: sidePick < 0.5 ? 1 : -1,
    };
    const landFraction = midLandFraction(points, field, width);
    if (landFraction >= CANAL_MIN_LAND_FRACTION) return canal;
    // 陸上率が閾値未満の試行は棄却してリトライする(2026-07-11 撤廃:
    // 「陸上率最大の試行を受理する」救済は行わない。contracts/ground-water.md)
  }
  // 全試行が陸上率(または交差上限)を満たさない場合は棄却する。
  // 呼び出し元(runCanals)は全水路棄却時にフォールバックの堀留へ縮退する
  return null;
}

/**
 * フォールバックの堀留: 水域のアンカーから中心域へ向かう短い水路。
 * 終端は陸上へ押し出して「街区内で止まる」を保証し(見えない水中の堀留を
 * 作らない。contracts/ground-water.md)、終端が中心へ最も近くなるアンカーを
 * 決定論的に選ぶ。交差が上限以下になる弧長へ切り詰める(始端のみ水域接続)。
 *
 * アンカー(岸)から中心へ向かう直線を等間隔(CANAL_SAMPLE_STEP)で走査し、
 * 「水中に留まる最後の地点」を探す(非凸な水域形状でも、途中の陸地に
 * 惑わされず判定できる)。この水中区間が接続窓(弧長 幅×2+4)を超える
 * アンカーは、水域(湖)を大きく突っ切ることになるため採用しない
 * (水域横断の禁止。contracts/ground-water.md「水路の性質」。2026-07-11
 * タスク A4 で発見・修正: 旧実装は終端を勾配で陸側へ押し出す方式で、
 * 巨大な湖では終端が直線から大きく逸れ、始端〜終端の直線が湖の内部を
 * 数百単位横断する経路を生んでいた)
 *
 * 形状健全性(2026-07-12 追記。contracts/ground-water.md「水路の性質」):
 * 堀留は始端から中心方向への直線に近い経路のため、自己近接(検査1)・
 * 迂曲率(検査3)は構造上自明に満たす。既存水路との最小間隔(検査2)は
 * `accepted`(呼び出し元 runCanals では他の水路が全滅した場合にのみ
 * 計画されるため現状は常に空配列だが、将来の呼び出し規約変更に備えた
 * 防御的な検査として)明示的に適用する。
 */
function planFallbackCanal(
  model: WorldModel,
  field: WaterField,
  anchors: Vec2[],
  width: number,
  radius: (theta: number) => number,
  accepted: readonly Canal[],
): Canal | null {
  const { derived } = model.meta;
  const center = model.centerPlan.position;
  const footHalf = derived.centerFootprint / 2;
  const clear = width / 2 + 1;
  const minLen = Math.max(width * 3, 26);
  const endWindow = width * 2 + 4;

  let best: { start: Vec2; end: Vec2; score: number } | null = null;
  for (const p of anchors) {
    const dx = center.x - p.x;
    const dz = center.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const stop = len - (footHalf * 1.4 + FOOTPRINT_CLEARANCE);
    if (stop < minLen) continue;
    // p → center 方向へ走査し、水中(waterSdf < clear)に留まる最後の弧長を探す
    let lastWetT = -1;
    for (let t = 0; t <= stop; t += CANAL_SAMPLE_STEP) {
      const x = p.x + (dx / len) * t;
      const z = p.z + (dz / len) * t;
      if (field.waterSdf(x, z) < clear) lastWetT = t;
    }
    if (lastWetT >= 0 && lastWetT + CANAL_SAMPLE_STEP > endWindow) continue;
    const end = { x: p.x + (dx / len) * stop, z: p.z + (dz / len) * stop };
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

  // 4 つ目以降の交差、または渡り長上限を超える交差の手前へ切り詰める
  // (フォールバック堀留にも単一交差の渡り長上限を適用する。
  // contracts/ground-water.md「水路の性質」。切り詰めで解消しなければ棄却)
  const lenLimit = crossingLengthLimit(width);
  for (let guard = 0; guard < 6; guard++) {
    const stats = roadCrossingStats(model, pts, width, []);
    if (stats.count <= CANAL_MAX_BRIDGES && stats.maxLength <= lenLimit) break;
    // 交差位置を水路弧長に射影し、上限を超える最初の交差の手前で切る
    const sdf = canalSdf(pts, width);
    const sList: number[] = [];
    // 渡り長上限を超える交差のうち最初(弧長最小)のもの
    let overLongS = Infinity;
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
        if (c.length > lenLimit) overLongS = Math.min(overLongS, bestS);
      }
    }
    sList.sort((u, v) => u - v);
    const countCut = sList[CANAL_MAX_BRIDGES];
    const cutAt = Math.min(countCut ?? Infinity, overLongS);
    if (!Number.isFinite(cutAt)) break;
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
  const finalStats = roadCrossingStats(model, pts, width, []);
  if (finalStats.count > CANAL_MAX_BRIDGES) return null;
  if (finalStats.maxLength > lenLimit) return null;
  if (pathLength(pts) < width * 3) return null;
  // 形状健全性・検査2(既存水路との最小間隔。contracts/ground-water.md)
  if (existingCanalProximityViolation(pts, width, accepted)) return null;
  return { points: pts, width, id: "canal/fallback", towpathSide: 1 };
}

/** パイプライン段の実体: water.canals と water.bridges(仮追加)を埋める */
export function runCanals(model: WorldModel): void {
  const { derived } = model.meta;
  model.water.canals = [];

  const fired = derived.canalScore >= CANAL_FIRE_THRESHOLD;
  const hasWater =
    model.water.lakes.length > 0 || model.water.ponds.length > 0;
  if (!fired || !hasWater) {
    model.summary.waterOverview.canals = 0;
    return;
  }

  const field = createWaterField(model.ground.boundary, waterBodies(model.water));
  const radius = createBoundaryRadius(model.ground.boundary);
  const anchors = buildAnchors(model, field);
  if (anchors.length === 0) {
    model.summary.waterOverview.canals = 0;
    return;
  }

  // 幅は derived.canalWidth(worldmodel-core.md Meta 節。既に 2.2〜5 へクランプ済み)
  const width = derived.canalWidth;

  // 経由点の分散(形状健全性(4)。contracts/ground-water.md「水路の性質」):
  // 主道間隙を広い順に最大3件求め、水路 index ごとに異なる間隙へ向ける
  const gaps = mainRoadGaps(model);
  const planned = Math.min(
    CANAL_COUNT_MAX,
    1 + Math.floor((derived.canalScore - CANAL_FIRE_THRESHOLD) / CANAL_COUNT_STEP),
  );

  const canals: Canal[] = [];
  for (let i = 0; i < planned; i++) {
    const gap = gaps[i % gaps.length] ?? gaps[0];
    if (!gap) continue;
    const canal = planCanal(model, field, anchors, gap, gaps, i, width, radius, canals);
    if (canal) canals.push(canal);
  }
  // 全滅時のフォールバック(堀留)。デフォルト全50の「必ず1本以上」を守る
  if (canals.length === 0) {
    const fallback = planFallbackCanal(model, field, anchors, width, radius, canals);
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
        // 単一交差の渡り長上限(contracts/ground-water.md「水路の性質」)
        if (c.length > crossingLengthLimit(canal.width)) assertionViolations++;
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
    // 境界内・間隔
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
    // 形状健全性(2026-07-12 追記。contracts/ground-water.md「水路の性質」):
    // 自己近接・迂曲率は最終的な canals 全体に対して再検査する
    // (受理条件は候補試行の時点で検査済みだが、最終状態への回帰検知として
    // ここでも確認する)
    if (selfProximityViolation(canal.points, canal.width)) assertionViolations++;
    if (sinuosityRatio(canal.points) > CANAL_MAX_SINUOSITY) assertionViolations++;
  }
  // 形状健全性: 水路どうしの最小間隔(全ペア)
  for (let i = 0; i < canals.length; i++) {
    for (let j = i + 1; j < canals.length; j++) {
      const a = canals[i];
      const b = canals[j];
      if (!a || !b) continue;
      if (existingCanalProximityViolation(a.points, a.width, [b])) {
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
