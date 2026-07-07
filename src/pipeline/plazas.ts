/**
 * 段9「広場」: 中心前・結界門前・橋詰め・主道交差点の空地ポリゴンを確定し、
 * centerPlan.facing / heightHint を埋める。
 * データの正は docs/internal/contracts/network-plaza.md(Plaza / CenterPlan 節)、
 * 設計は implementation-spec 1.3節(段9)・PHASE 3。舗装の描画と zoneMask
 * 上書きは PHASE 3 commit 11 の担当。
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
} from "../model/waterfield";

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
/** 支配軸ごとの heightHint 係数(契約) */
const AXIS_HEIGHT_FACTOR = {
  arcane: 1.15,
  authority: 1.0,
  waterside: 0.85,
  rustic: 0.7,
} as const;

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
          plazas.push({
            id: "plaza/center",
            kind: "center",
            position: pos,
            radius: r,
            polygon: plazaPolygon(pos, r, wobbles),
          });
          // 採択した広場の方位で facing を確定する(契約)
          facing = Math.atan2(pos.z - center.z, pos.x - center.x);
          placed = true;
          break;
        }
      }
    }
    if (!placed) assertionViolations++;
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
      plazas.push({
        id: `plaza/gate/${gate.id}`,
        kind: "gate",
        position: pos,
        radius: r,
        polygon: plazaPolygon(pos, r, wobbles),
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
      for (const scale of SHRINK_STEPS) {
        const r = r0 * scale;
        const end = endFor(sign, r);
        if (!siteOk(check, end, r, wobbles)) continue;
        plazas.push({
          id: `plaza/bridgehead/${bridge.id}`,
          kind: "bridgehead",
          position: end,
          radius: r,
          polygon: plazaPolygon(end, r, wobbles),
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
      plazas.push({
        id: `plaza/crossing/${node.id}`,
        kind: "crossing",
        position: node.position,
        radius: r,
        polygon: plazaPolygon(node.position, r, wobbles),
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
  if (assertionViolations > 0) {
    console.warn(`plazas: パイプライン内アサーション違反 ${assertionViolations} 件`);
  }
}
