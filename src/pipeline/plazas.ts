/**
 * 段9「広場」: 中心前・結界門前・橋詰め・主道交差点の空地ポリゴンを確定し、
 * centerPlan.facing / heightHint を埋める。
 * データの正は docs/internal/contracts/network-plaza.md(Plaza / CenterPlan 節)、
 * 設計は implementation-spec 1.3節(段9)。舗装の描画と zoneMask
 * 上書きは段10「舗装」の担当。
 *
 * - 衝突回避: 採択順(center → gate → bridgehead → crossing)で、既採択
 *   広場・水域(水路を含む)・centerPlan.footprint・境界との衝突を検査し、
 *   回避できない候補は縮小し、それでも収まらなければ棄却する
 * - facing は主道の収束方向を初期値に、中心前広場の採択方位で確定する
 * - heightHint は derived.centerHeight × 支配軸係数(契約)
 */
import { makeRng } from "../rng";
import type { Plaza, Polygon, Vec2, WorldModel } from "../model/worldmodel";
import {
  createBoundaryRadius,
  createWaterField,
  distToPolyline,
  pointInPolygon,
  polygonSignedDistance,
  waterBodies,
} from "../model/waterfield";
import { chaikin, resamplePath } from "../model/geometry";
import { STREET_GRADE_DROP, STREET_WIDTH } from "./streets";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** ポリゴンの頂点数(不整形 n 角形) */
const PLAZA_VERTICES = 12;
/** 半径揺らぎの範囲(radius 比。契約: 頂点は radius の円内) */
const PLAZA_WOBBLE_MIN = 0.88;
/** 既採択広場との最小マージン(半径和への加算) */
const PLAZA_GAP = 1.5;
/** 中心前広場の方位候補(facing からの相対角。近い方位から遠くへ) */
const CENTER_ANGLE_OFFSETS = [
  0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, 1.57, -1.57, 1.9, -1.9, 2.2,
  -2.2, 2.6, -2.6, 2.9, -2.9, Math.PI,
];
/** 縮小候補(radius 比) */
const SHRINK_STEPS = [1, 0.85, 0.7, 0.55];
/** 交差点広場の採択確率 */
const CROSSING_CHANCE = 0.35;
/** 支配軸ごとの heightHint 係数(契約。ギャラリーの中心建築対象が
 *  段9 と同一式で heightHint を合成するため export) */
export const AXIS_HEIGHT_FACTOR = {
  arcane: 1.15,
  authority: 1.0,
  waterside: 0.85,
  rustic: 0.7,
} as const;

/**
 * 中心前広場の接続路(契約: network-plaza.md Plaza 節
 * 「中心前広場の接続路」)。
 *
 * - 流入方位の許容差: 契約は「facing と一致させる」とだけ定め、幾何的な
 *   厳密一致が不可能な場合(水域・footprint による回避)の許容量を定めて
 *   いない。本実装では ±30°(提案値)を許容し、facing の
 *   延長線に最も近い候補から順に試す
 */
const CONNECTOR_ANGLE_OFFSETS = [
  0,
  (10 * Math.PI) / 180,
  -(10 * Math.PI) / 180,
  (20 * Math.PI) / 180,
  -(20 * Math.PI) / 180,
  (30 * Math.PI) / 180,
  -(30 * Math.PI) / 180,
];
/** 流入方位と facing の許容差(提案値。上記オフセット候補の最大値と一致させる) */
export const CONNECTOR_FACING_TOLERANCE = (30 * Math.PI) / 180;
/** 接続路が水域を避ける最小クリアランス(契約: waterSdf < 幅/2+1) */
const CONNECTOR_WATER_CLEAR = STREET_WIDTH / 2 + 1;
/** 接続路が centerPlan.footprint を避ける最小クリアランス(lanes.ts 等の桁感に合わせた提案値) */
const CONNECTOR_FOOT_CLEAR = 1;
/** 迂回の via 点に加える横ずれ候補(近い順。提案値) */
const CONNECTOR_DETOUR_OFFSETS = [6, -6, 12, -12, 18, -18, 24, -24];
/** 「広場ポリゴンに接するか内部を通る」判定の標本間隔・許容差 */
const ROAD_TOUCH_SAMPLE_STEP = 3;
const ROAD_TOUCH_TOLERANCE = 0.5;

/** 線分 ab が水域・footprint を侵さないか(標本 8 点) */
function segmentClear(
  a: Vec2,
  b: Vec2,
  waterSdf: (x: number, z: number) => number,
  footprint: Polygon,
): boolean {
  const SAMPLES = 8;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (waterSdf(x, z) < CONNECTOR_WATER_CLEAR) return false;
    if (footprint.length >= 3 && polygonSignedDistance(x, z, footprint) < CONNECTOR_FOOT_CLEAR) {
      return false;
    }
  }
  return true;
}

/** 折れ線の全区間が水域・footprint を侵さないか */
function polylineClear(
  points: Vec2[],
  waterSdf: (x: number, z: number) => number,
  footprint: Polygon,
): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    if (!segmentClear(a, b, waterSdf, footprint)) return false;
  }
  return true;
}

/**
 * from → to の経路を探す。直線基調(まず直線を試す)で、水域・footprint に
 * よりやむを得ない場合のみ 1〜2 個の via 点で軽く迂回し、Chaikin 1回で
 * 平滑化する(端点は Chaikin が保持するため from/to は厳密に保たれる)。
 * 見つからなければ null(呼び出し側は次点のノード・角度候補へ進む)。
 */
function findClearPath(
  from: Vec2,
  to: Vec2,
  waterSdf: (x: number, z: number) => number,
  footprint: Polygon,
): Vec2[] | null {
  if (polylineClear([from, to], waterSdf, footprint)) return [from, to];

  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len;
  const pz = dx / len;

  // 1 via 点(中点からの横ずれ)
  const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
  for (const off of CONNECTOR_DETOUR_OFFSETS) {
    const via = { x: mid.x + px * off, z: mid.z + pz * off };
    const pts = [from, via, to];
    if (polylineClear(pts, waterSdf, footprint)) return chaikin(pts);
  }

  // 2 via 点(S字。1 via 点で回避できない障害物の縁を追う)
  const q1 = { x: from.x + dx * 0.33, z: from.z + dz * 0.33 };
  const q2 = { x: from.x + dx * 0.66, z: from.z + dz * 0.66 };
  for (const off of CONNECTOR_DETOUR_OFFSETS) {
    const via1 = { x: q1.x + px * off, z: q1.z + pz * off };
    const via2 = { x: q2.x + px * off, z: q2.z + pz * off };
    const pts = [from, via1, via2, to];
    if (polylineClear(pts, waterSdf, footprint)) return chaikin(pts);
  }
  return null;
}

interface CenterConnector {
  fromNodeId: string;
  entry: Vec2;
  path: Vec2[];
}

/**
 * 広場中心から角度 theta のレイと広場ポリゴン(中心まわりの星形多角形。
 * plazaPolygon の頂点は角度の単調な関数で配置されるため、任意方向のレイは
 * 境界とちょうど1回交わる)との交点。「広場縁」を wobble 込みの実形状から
 * 厳密に求める(半径の仮定に頼らない)。交点が見つからない場合(数値誤差)
 * は radius 位置へフォールバックする
 */
function plazaEdgePoint(plaza: Plaza, theta: number): Vec2 {
  const center = plaza.position;
  const dx = Math.cos(theta);
  const dz = Math.sin(theta);
  const n = plaza.polygon.length;
  for (let i = 0; i < n; i++) {
    const a = plaza.polygon[i];
    const b = plaza.polygon[(i + 1) % n];
    if (!a || !b) continue;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const det = ex * dz - ez * dx;
    if (Math.abs(det) < 1e-9) continue;
    const acx = a.x - center.x;
    const acz = a.z - center.z;
    const t = (ex * acz - ez * acx) / det;
    const s = (dx * acz - dz * acx) / det;
    if (t >= 0 && s >= -1e-6 && s <= 1 + 1e-6) {
      return { x: center.x + dx * t, z: center.z + dz * t };
    }
  }
  return { x: center.x + dx * plaza.radius, z: center.z + dz * plaza.radius };
}

/**
 * 中心前広場の接続路を決定論的に探す: facing の延長線(角度オフセット候補を
 * 近い順に走査)× 最寄りの道路ノード(全 class。距離昇順→id 昇順でタイブレーク)
 * の組み合わせを、経路が見つかるまで順に試す。乱数は使わない。
 */
function buildCenterConnector(
  model: WorldModel,
  plaza: Plaza,
  facing: number,
  waterSdf: (x: number, z: number) => number,
  footprint: Polygon,
): CenterConnector | null {
  for (const off of CONNECTOR_ANGLE_OFFSETS) {
    const theta = facing + off;
    const entry: Vec2 = plazaEdgePoint(plaza, theta);
    if (waterSdf(entry.x, entry.z) < CONNECTOR_WATER_CLEAR) continue;
    if (footprint.length >= 3 && polygonSignedDistance(entry.x, entry.z, footprint) < CONNECTOR_FOOT_CLEAR) {
      continue;
    }
    const candidates = model.network.nodes
      .map((n) => ({
        id: n.id,
        position: n.position,
        d: Math.hypot(n.position.x - entry.x, n.position.z - entry.z),
      }))
      .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const cand of candidates) {
      const path = findClearPath(cand.position, entry, waterSdf, footprint);
      if (path) return { fromNodeId: cand.id, entry, path };
    }
  }
  return null;
}

/**
 * 全広場の道路接続保証(courtyard を除く)の検証:
 * 少なくとも1本の道路 edge の path 標本点が広場ポリゴンの周長に接するか
 * 内部を通る(polygonSignedDistance ≤ 許容差)。
 */
function plazaTouchesRoad(
  polygon: Polygon,
  edges: WorldModel["network"]["edges"],
): boolean {
  for (const edge of edges) {
    const samples = resamplePath(edge.path, ROAD_TOUCH_SAMPLE_STEP);
    for (const p of samples) {
      if (polygonSignedDistance(p.x, p.z, polygon) <= ROAD_TOUCH_TOLERANCE) {
        return true;
      }
    }
  }
  return false;
}

/** 接触検証が外れた場合にアンカーへ寄せる段階数(契約: network-plaza.md Plaza 節) */
const TOUCH_NUDGE_MAX_STEPS = 6;
/** 1段階あたりの寄せ幅(半径比。契約と同じ提案値) */
const TOUCH_NUDGE_STEP_RATIO = 0.15;

/**
 * gate / bridgehead / crossing 広場の採択直前に行う接触検証+寄せ
 * (契約: network-plaza.md Plaza 節「全広場の道路接続保証」)。
 *
 * `pos` が既に道路に接していればそのまま返す。外れている場合は `anchor`
 * (gate 位置 / 橋詰めの道路端 / 交差ノード)へ向けて `radius ×
 * TOUCH_NUDGE_STEP_RATIO` ずつ最大 `TOUCH_NUDGE_MAX_STEPS` 回寄せ、
 * 既存の `siteOk`(水域・footprint・広場間距離)を保ったまま再検証する。
 * 決定論的(乱数を消費しない)。寄せても接しなければ null を返し、
 * 呼び出し側は次の候補(縮小・別の袂・棄却)へ進む。
 */
function resolveTouchingSite(
  check: SiteCheck,
  pos: Vec2,
  radius: number,
  wobbles: number[],
  anchor: Vec2,
  edges: WorldModel["network"]["edges"],
): { position: Vec2; polygon: Polygon } | null {
  const initialPolygon = plazaPolygon(pos, radius, wobbles);
  if (plazaTouchesRoad(initialPolygon, edges)) {
    return { position: pos, polygon: initialPolygon };
  }
  const dx = anchor.x - pos.x;
  const dz = anchor.z - pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return null;
  const ux = dx / dist;
  const uz = dz / dist;
  const step = radius * TOUCH_NUDGE_STEP_RATIO;
  for (let k = 1; k <= TOUCH_NUDGE_MAX_STEPS; k++) {
    const d = Math.min(step * k, dist);
    const candidate: Vec2 = { x: pos.x + ux * d, z: pos.z + uz * d };
    if (!siteOk(check, candidate, radius, wobbles)) continue;
    const candidatePolygon = plazaPolygon(candidate, radius, wobbles);
    if (plazaTouchesRoad(candidatePolygon, edges)) {
      return { position: candidate, polygon: candidatePolygon };
    }
  }
  return null;
}

/** 湖・池・水路を合成した水域 sdf(正=陸側) */
function combinedWaterSdf(model: WorldModel): (x: number, z: number) => number {
  const field = createWaterField(model.ground.boundary, waterBodies(model.water));
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

/**
 * 中心ノードへ到来する道路の方向の重み付き平均(main 1.0 / connector 0.5)。
 * 道路が中心へ接続しない縮退時は最寄りの進入点方向。
 */
function roadConvergenceAngle(model: WorldModel): number {
  const c = model.centerPlan.position;
  let sx = 0;
  let sz = 0;
  for (const edge of model.network.edges) {
    const path = edge.path;
    if (path.length < 2) continue;
    const head = path[0];
    const tail = path[path.length - 1];
    if (!head || !tail) continue;
    let q: Vec2 | undefined;
    if (Math.hypot(head.x - c.x, head.z - c.z) < 1e-6) q = path[1];
    else if (Math.hypot(tail.x - c.x, tail.z - c.z) < 1e-6) q = path[path.length - 2];
    if (!q) continue;
    const dx = q.x - c.x;
    const dz = q.z - c.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const w = edge.class === "main" ? 1 : 0.5;
    sx += (dx / len) * w;
    sz += (dz / len) * w;
  }
  if (Math.hypot(sx, sz) > 0.15) return Math.atan2(sz, sx);
  // 縮退: 最寄りの進入点方向
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const e of model.network.entryPoints) {
    const d = Math.hypot(e.position.x - c.x, e.position.z - c.z);
    if (d < bestD) {
      bestD = d;
      best = e.position;
    }
  }
  if (best) return Math.atan2(best.z - c.z, best.x - c.x);
  return Math.PI / 4;
}

/** position 中心の不整形 n 角形(時計回り。頂点は radius の円内) */
function plazaPolygon(
  position: Vec2,
  radius: number,
  wobbles: number[],
): Polygon {
  const poly: Polygon = [];
  for (let i = 0; i < PLAZA_VERTICES; i++) {
    // 偏角を減少方向に回して時計回り(Polygon 規約)
    const theta = -(i / PLAZA_VERTICES) * Math.PI * 2;
    const r =
      radius * (PLAZA_WOBBLE_MIN + (1 - PLAZA_WOBBLE_MIN) * (wobbles[i] ?? 1));
    poly.push({
      x: position.x + Math.cos(theta) * r,
      z: position.z + Math.sin(theta) * r,
    });
  }
  return poly;
}

interface SiteCheck {
  waterSdf: (x: number, z: number) => number;
  boundaryInside: (p: Vec2) => number;
  footprint: Polygon;
  accepted: Plaza[];
}

/**
 * 候補円(中心+半径)が衝突なく置けるか。円周(radius)のサンプルに加えて
 * 実際のポリゴン頂点(揺らぎ込み)も検査し、アサーションと整合させる。
 */
function siteOk(
  check: SiteCheck,
  pos: Vec2,
  radius: number,
  wobbles: number[],
): boolean {
  if (check.boundaryInside(pos) < radius * 0.8 + 1) return false;
  if (check.waterSdf(pos.x, pos.z) < radius * 0.3) return false;
  if (
    check.footprint.length >= 3 &&
    polygonSignedDistance(pos.x, pos.z, check.footprint) < radius * 0.55
  ) {
    return false;
  }
  const probes: Vec2[] = plazaPolygon(pos, radius, wobbles);
  for (let i = 0; i < PLAZA_VERTICES; i++) {
    // 頂点と同じ方位の radius 円周上(揺らぎで縮む前の外周)も併せて検査する
    const theta = -(i / PLAZA_VERTICES) * Math.PI * 2;
    probes.push({
      x: pos.x + Math.cos(theta) * radius,
      z: pos.z + Math.sin(theta) * radius,
    });
  }
  for (const q of probes) {
    if (check.waterSdf(q.x, q.z) < 0.3) return false;
    if (check.boundaryInside(q) < 1) return false;
    if (
      check.footprint.length >= 3 &&
      polygonSignedDistance(q.x, q.z, check.footprint) < 0.3
    ) {
      return false;
    }
  }
  for (const other of check.accepted) {
    const d = Math.hypot(other.position.x - pos.x, other.position.z - pos.z);
    if (d < other.radius + radius + PLAZA_GAP) return false;
  }
  return true;
}

/** パイプライン段の実体: plazas と centerPlan.facing / heightHint を埋める */
export function runPlazas(model: WorldModel): void {
  const { seed, derived } = model.meta;
  const center = model.centerPlan.position;
  const boundaryRadius = createBoundaryRadius(model.ground.boundary);
  const check: SiteCheck = {
    waterSdf: combinedWaterSdf(model),
    boundaryInside: (p) =>
      boundaryRadius(Math.atan2(p.z, p.x)) - Math.hypot(p.x, p.z),
    footprint: model.centerPlan.footprint,
    accepted: [],
  };
  const plazas: Plaza[] = check.accepted;
  let assertionViolations = 0;

  // --- 中心前広場(facing の確定を兼ねる) ---
  const facingInit = roadConvergenceAngle(model);
  let facing = facingInit;
  let centerPlaza: Plaza | null = null;
  const footHalf = derived.centerFootprint / 2;
  {
    const rng = makeRng(seed, "plazas/center");
    const wobbles: number[] = [];
    for (let i = 0; i < PLAZA_VERTICES; i++) wobbles.push(rng.next());
    let placed = false;
    for (const scale of SHRINK_STEPS) {
      if (placed) break;
      const r = derived.centerPlazaRadius * scale;
      for (const da of CENTER_ANGLE_OFFSETS) {
        if (placed) break;
        const a = facingInit + da;
        // footprint(軸平行の正方形)の縁までの距離を方向別に取り、
        // 広場円が footprint に重ならない最小オフセットで隣接させる。
        // 水路等が縁に走る場合は径方向へ少し逃がす(extra)
        const edgeT =
          footHalf /
          Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)), 1e-6);
        for (const extra of [0, 4, 8, 12]) {
          const pos = {
            x: center.x + Math.cos(a) * (edgeT + r + 1 + extra),
            z: center.z + Math.sin(a) * (edgeT + r + 1 + extra),
          };
          if (!siteOk(check, pos, r, wobbles)) continue;
          const plaza: Plaza = {
            id: "plaza/center",
            kind: "center",
            position: pos,
            radius: r,
            polygon: plazaPolygon(pos, r, wobbles),
          };
          plazas.push(plaza);
          centerPlaza = plaza;
          // 採択した広場の方位で facing を確定する(契約)
          facing = Math.atan2(pos.z - center.z, pos.x - center.x);
          placed = true;
          break;
        }
      }
    }
    if (!placed) assertionViolations++;
  }

  // --- 中心前広場の接続路(契約: network-plaza.md Plaza 節
  //     「中心前広場の接続路」)。中心前広場が確定した後、facing の延長線に
  //     最も近い広場縁(±30°まで許容)と、最寄りの道路ノード(全 class)を
  //     決定論的に走査して短い接続路を network へ追記のみで加える ---
  if (centerPlaza) {
    const conn = buildCenterConnector(
      model,
      centerPlaza,
      facing,
      check.waterSdf,
      check.footprint,
    );
    if (conn) {
      const entryNodeId = `node/street/plaza/${centerPlaza.id}`;
      model.network.nodes = [
        ...model.network.nodes,
        { id: entryNodeId, position: conn.entry },
      ];
      model.network.edges = [
        ...model.network.edges,
        {
          id: `street/plaza/${centerPlaza.id}`,
          from: conn.fromNodeId,
          to: entryNodeId,
          class: "street",
          width: STREET_WIDTH,
          path: conn.path,
          grade: clamp(derived.roadGrade - STREET_GRADE_DROP, 0, 2),
        },
      ];
    } else {
      assertionViolations++;
    }
  }

  // --- 結界門前広場 ---
  for (const gate of model.wards.gates) {
    const rng = makeRng(seed, `plazas/gate/${gate.id}`);
    const wobbles: number[] = [];
    for (let i = 0; i < PLAZA_VERTICES; i++) wobbles.push(rng.next());
    // 門から中心側へ、道路方向に沿って置く
    const toCenter = Math.atan2(
      center.z - gate.position.z,
      center.x - gate.position.x,
    );
    const dirDot =
      Math.cos(gate.angle) * Math.cos(toCenter) +
      Math.sin(gate.angle) * Math.sin(toCenter);
    const sign = dirDot >= 0 ? 1 : -1;
    for (const scale of SHRINK_STEPS) {
      const r = (5 + 5 * derived.gateScale) * scale;
      const pos = {
        x: gate.position.x + Math.cos(gate.angle) * sign * (r + 2),
        z: gate.position.z + Math.sin(gate.angle) * sign * (r + 2),
      };
      if (!siteOk(check, pos, r, wobbles)) continue;
      // 接触検証: 外れていれば門位置(道路との交点近傍)へ寄せて再検証する
      const resolved = resolveTouchingSite(
        check,
        pos,
        r,
        wobbles,
        gate.position,
        model.network.edges,
      );
      if (!resolved) continue;
      plazas.push({
        id: `plaza/gate/${gate.id}`,
        kind: "gate",
        position: resolved.position,
        radius: r,
        polygon: resolved.polygon,
      });
      break;
    }
  }

  // --- 橋詰め広場(中心に近い袂を優先。採択は watersideRate 駆動) ---
  for (const bridge of model.water.bridges) {
    const rng = makeRng(seed, `plazas/bridgehead/${bridge.id}`);
    const adopt = rng.chance(0.45 + 0.5 * derived.watersideRate);
    const wobbles: number[] = [];
    for (let i = 0; i < PLAZA_VERTICES; i++) wobbles.push(rng.next());
    if (!adopt) continue;
    const r0 = clamp(3 + bridge.width, 4, 8);
    const endFor = (sign: number, r: number): Vec2 => ({
      x: bridge.position.x + Math.cos(bridge.angle) * sign * (bridge.length / 2 + r + 1.5),
      z: bridge.position.z + Math.sin(bridge.angle) * sign * (bridge.length / 2 + r + 1.5),
    });
    const dA = Math.hypot(
      endFor(1, r0).x - center.x,
      endFor(1, r0).z - center.z,
    );
    const dB = Math.hypot(
      endFor(-1, r0).x - center.x,
      endFor(-1, r0).z - center.z,
    );
    const signs = dA <= dB ? [1, -1] : [-1, 1];
    let placed = false;
    for (const sign of signs) {
      if (placed) break;
      // 橋詰めの道路端(橋の袂。r=-1.5 で bridge.length/2 の地点に戻す
      // = 橋詰め広場を寄せる先のアンカー)
      const roadEnd = endFor(sign, -1.5);
      for (const scale of SHRINK_STEPS) {
        const r = r0 * scale;
        const end = endFor(sign, r);
        if (!siteOk(check, end, r, wobbles)) continue;
        // 接触検証: 外れていれば橋詰めの道路端へ寄せて再検証する
        const resolved = resolveTouchingSite(
          check,
          end,
          r,
          wobbles,
          roadEnd,
          model.network.edges,
        );
        if (!resolved) continue;
        plazas.push({
          id: `plaza/bridgehead/${bridge.id}`,
          kind: "bridgehead",
          position: resolved.position,
          radius: r,
          polygon: resolved.polygon,
        });
        placed = true;
        break;
      }
    }
  }

  // --- 主道交差点広場(確率的) ---
  const mainDegree = new Map<string, number>();
  for (const edge of model.network.edges) {
    if (edge.class !== "main") continue;
    mainDegree.set(edge.from, (mainDegree.get(edge.from) ?? 0) + 1);
    mainDegree.set(edge.to, (mainDegree.get(edge.to) ?? 0) + 1);
  }
  for (const node of model.network.nodes) {
    if ((mainDegree.get(node.id) ?? 0) < 2) continue;
    if (
      Math.hypot(node.position.x - center.x, node.position.z - center.z) < 1e-6
    ) {
      continue; // 中心ノードは中心前広場の担当
    }
    const rng = makeRng(seed, `plazas/crossing/${node.id}`);
    const adopt = rng.chance(CROSSING_CHANCE);
    const rPick = rng.next();
    const wobbles: number[] = [];
    for (let i = 0; i < PLAZA_VERTICES; i++) wobbles.push(rng.next());
    if (!adopt) continue;
    for (const scale of SHRINK_STEPS) {
      const r = (4 + 2.5 * rPick) * scale;
      if (!siteOk(check, node.position, r, wobbles)) continue;
      // 接触検証: crossing は交差ノード自身がアンカー(構成上ほぼ常に
      // 接するが、寄せ処理の経路を他 kind と揃えて一貫させる)
      const resolved = resolveTouchingSite(
        check,
        node.position,
        r,
        wobbles,
        node.position,
        model.network.edges,
      );
      if (!resolved) continue;
      plazas.push({
        id: `plaza/crossing/${node.id}`,
        kind: "crossing",
        position: resolved.position,
        radius: r,
        polygon: resolved.polygon,
      });
      break;
    }
  }

  model.plazas = plazas;

  // --- centerPlan 後半: facing / heightHint の確定 ---
  model.centerPlan.facing = facing;
  const axes = model.centerPlan.axes;
  let dominant: keyof typeof AXIS_HEIGHT_FACTOR = "arcane";
  let bestAxis = axes.arcane;
  for (const key of ["authority", "waterside", "rustic"] as const) {
    if (axes[key] > bestAxis) {
      bestAxis = axes[key];
      dominant = key;
    }
  }
  model.centerPlan.heightHint =
    derived.centerHeight * AXIS_HEIGHT_FACTOR[dominant];

  // --- パイプライン内アサーション(throw せず件数を console に出す) ---
  for (let i = 0; i < plazas.length; i++) {
    const a = plazas[i];
    if (!a) continue;
    for (let j = i + 1; j < plazas.length; j++) {
      const b = plazas[j];
      if (!b) continue;
      const d = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      if (d < a.radius + b.radius) assertionViolations++;
    }
    for (const v of a.polygon) {
      if (check.waterSdf(v.x, v.z) < 0) assertionViolations++;
      if (
        check.footprint.length >= 3 &&
        pointInPolygon(v.x, v.z, check.footprint)
      ) {
        assertionViolations++;
      }
    }
  }
  if (!(model.centerPlan.heightHint > 0)) assertionViolations++;
  if (!Number.isFinite(model.centerPlan.facing)) assertionViolations++;
  // 全広場の道路接続保証(courtyard を除く。契約:
  // network-plaza.md Plaza 節「全広場の道路接続保証」)。gate / bridgehead /
  // crossing は採択直前の resolveTouchingSite が接触検証+寄せ+棄却まで
  // 済ませており、center は上の接続路が満たすため、ここでは最終防御として
  // 二重に検証する
  for (const plaza of plazas) {
    if (plaza.kind === "courtyard") continue;
    if (!plazaTouchesRoad(plaza.polygon, model.network.edges)) assertionViolations++;
  }
  if (assertionViolations > 0) {
    console.warn(`plazas: パイプライン内アサーション違反 ${assertionViolations} 件`);
  }
}
