/**
 * PHASE 4b commit 14: 開口・木組み・煙突・素材階層のテスト。
 * 契約は docs/internal/contracts/buildings.md
 * 「PHASE 4b commit 14 の追加語彙」「PHASE 4b commit 14 の詳細部品の性質」
 * 「Building.materials の決め方」。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  createEmptyWorldModel,
  type Building,
  type Params,
  type Part,
  type WorldModel,
} from "../src/model/worldmodel";
import { polygonSignedDistance } from "../src/model/waterfield";
import { runDerive } from "../src/pipeline/derive";
import { runGround } from "../src/pipeline/ground";
import { runWater } from "../src/pipeline/water";
import { runSiting } from "../src/pipeline/siting";
import { runNetwork } from "../src/pipeline/network";
import { runCanals } from "../src/pipeline/canals";
import { runDensity } from "../src/pipeline/density";
import { runWards } from "../src/pipeline/wards";
import { runPlazas } from "../src/pipeline/plazas";
import { runPaving } from "../src/pipeline/paving";
import { runParcels } from "../src/pipeline/parcels";
import {
  CHIMNEY_BASE_WIDTH,
  CHIMNEY_OVERSIZE,
  FLOOR_HEIGHT,
  runBuildings,
} from "../src/pipeline/buildings";

const SEEDS = ["everdusk-101", "seed-a", "seed-b"];

function build(seed: string, over: Partial<Params> = {}): WorldModel {
  const model = createEmptyWorldModel(seed, { ...DEFAULT_PARAMS, ...over });
  runDerive(model);
  runGround(model);
  runWater(model);
  runSiting(model);
  runNetwork(model);
  runCanals(model);
  runDensity(model);
  runWards(model);
  runPlazas(model);
  runPaving(model);
  runParcels(model);
  runBuildings(model);
  return model;
}

const cache = new Map<string, WorldModel>();
function cached(seed: string, over: Partial<Params> = {}): WorldModel {
  const key = seed + JSON.stringify(over);
  let model = cache.get(key);
  if (!model) {
    model = build(seed, over);
    cache.set(key, model);
  }
  return model;
}

function partsOf(b: Building, type: string): Part[] {
  return b.parts.filter((p) => p.type === type);
}

/** 部品の xz 四隅(変換規約: scale → Y回転 → position) */
function partCorners(part: Part): { x: number; z: number }[] {
  const [px, , pz] = part.transform.position;
  const [sx, , sz] = part.transform.scale;
  const cos = Math.cos(part.transform.rotation);
  const sin = Math.sin(part.transform.rotation);
  const out: { x: number; z: number }[] = [];
  for (const [lx, lz] of [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ] as const) {
    const x = lx * sx;
    const z = lz * sz;
    out.push({ x: px + x * cos + z * sin, z: pz - x * sin + z * cos });
  }
  return out;
}

/** 点から線分への距離 */
function distToSegment(
  px: number,
  pz: number,
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  const t =
    lenSq > 0
      ? Math.min(1, Math.max(0, ((px - a.x) * dx + (pz - a.z) * dz) / lenSq))
      : 0;
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

/**
 * 開口(窓・扉)が同じ建物のいずれかの壁体部品の壁面(側面)上にあり、
 * 高さも壁体の範囲に収まるか(契約: 開口部品の変換規約)。
 */
function openingOnWall(b: Building, opening: Part): boolean {
  const [ox, oy, oz] = opening.transform.position;
  const oh = opening.transform.scale[1];
  for (const wall of partsOf(b, "wall")) {
    const wy = wall.transform.position[1];
    if (oy < wy - 1e-6 || oy + oh > wy + FLOOR_HEIGHT + 1e-6) continue;
    const corners = partCorners(wall);
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const c = corners[(i + 1) % corners.length];
      if (!a || !c) continue;
      if (distToSegment(ox, oz, a, c) < 0.02) return true;
    }
  }
  return false;
}

/** 建物ごとの窓・扉・煙突などの型別集計 */
function countType(model: WorldModel, type: string): number {
  let n = 0;
  for (const b of general(model)) n += partsOf(b, type).length;
  return n;
}

/**
 * 一般建物(中心建築は専用文法・専用語彙のため除外。
 * 中心建築の検証は test/center.test.ts)
 */
function general(model: WorldModel): Building[] {
  return model.buildings.filter((b) => b.role !== "center");
}

/**
 * 水辺と低密度郊外を含む組(水域バリエーション+
 * warehouse / outskirt / hall が現れる広域低密の組)。
 */
const COMBOS: [string, Partial<Params>][] = SEEDS.flatMap((seed) => [
  [seed, {}],
  [seed, { water: 70 }],
  [seed, { worldScale: 90, settlement: 20 }],
]);

describe("building details: 扉(正面 frontEdge 側に必ず 1 つ)", () => {
  it("全建物が扉をちょうど 1 つ持ち、外向きが親区画の facing と一致し、壁面上にある", () => {
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      const parcelById = new Map(model.parcels.map((p) => [p.id, p]));
      expect(general(model).length).toBeGreaterThan(0);
      for (const b of general(model)) {
        // 正面扉の一意性は waterfront でない door で判定する(契約。
        // 水辺拡張の追加扉=デッキ出入り口・水路裏口は params.waterfront = 1)
        const doors = partsOf(b, "door").filter(
          (p) => p.params?.waterfront !== 1,
        );
        expect(doors.length).toBe(1);
        const door = doors[0];
        if (!door) continue;
        // 開口の外向き法線 = (sin r, cos r)(契約の変換規約)
        const nx = Math.sin(door.transform.rotation);
        const nz = Math.cos(door.transform.rotation);
        const parcel = b.parcelId ? parcelById.get(b.parcelId) : undefined;
        expect(parcel).toBeDefined();
        if (parcel) {
          // 正面 = 親区画の facing(揺らぎは ±3° 以内)
          const dot =
            nx * Math.cos(parcel.facing) + nz * Math.sin(parcel.facing);
          expect(dot).toBeGreaterThan(Math.cos((6 * Math.PI) / 180));
        }
        expect(openingOnWall(b, door)).toBe(true);
      }
    }
  });
});

describe("building details: 窓(壁面上・少なく大きく)", () => {
  it("全ての窓が壁面上にあり、寸法が「少なく大きく」の帯に収まる", () => {
    let windowTotal = 0;
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      for (const b of general(model)) {
        for (const w of partsOf(b, "window")) {
          windowTotal++;
          expect(openingOnWall(b, w)).toBe(true);
          // 大きい窓(幅 0.95〜1.3、高さ 0.9〜1.85)
          expect(w.transform.scale[0]).toBeGreaterThanOrEqual(0.95);
          expect(w.transform.scale[0]).toBeLessThanOrEqual(1.3);
          expect(w.transform.scale[1]).toBeGreaterThanOrEqual(0.9);
          expect(w.transform.scale[1]).toBeLessThanOrEqual(1.85);
        }
      }
    }
    expect(windowTotal).toBeGreaterThan(0);
  });
});

describe("building details: 煙突(実寸比 15% 過大。art-direction 6節)", () => {
  it("胴幅 = 0.72 × 1.15 で固定され、footprint 内から棟より上へ抜ける", () => {
    let chimneyTotal = 0;
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      for (const b of general(model)) {
        for (const c of partsOf(b, "chimney")) {
          chimneyTotal++;
          expect(c.transform.scale[0]).toBeCloseTo(
            CHIMNEY_BASE_WIDTH * CHIMNEY_OVERSIZE,
            9,
          );
          expect(c.transform.scale[2]).toBeCloseTo(
            CHIMNEY_BASE_WIDTH * CHIMNEY_OVERSIZE,
            9,
          );
          // footprint 内(中心が内側)
          const [px, py, pz] = c.transform.position;
          expect(polygonSignedDistance(px, pz, b.footprint)).toBeLessThan(0);
          // 頂部は壁天端より高い(屋根を貫いて棟越えする)
          const wallTop = b.foundation.plinthHeight + b.floors * FLOOR_HEIGHT;
          expect(py + c.transform.scale[1]).toBeGreaterThan(wallTop + 0.5);
        }
      }
    }
    expect(chimneyTotal).toBeGreaterThan(0);
  });
});

describe("building details: 素材階層と木組みの連動", () => {
  it("木組み梁・ジェッティは wall='plaster' の建物にのみ付く", () => {
    let beamBuildings = 0;
    for (const [seed, over] of COMBOS) {
      for (const b of general(cached(seed, over))) {
        // 水辺拡張の beam(欄干・杭繋ぎ・持ち送り。waterfront)は
        // 壁材に依らず付く(契約の例外)
        const hasBeam =
          partsOf(b, "beam").filter((p) => p.params?.waterfront !== 1).length >
          0;
        const hasJetty = partsOf(b, "jetty").length > 0;
        if (hasBeam) beamBuildings++;
        if (hasBeam) expect(b.materials.wall).toBe("plaster");
        if (hasJetty) expect(hasBeam).toBe(true);
      }
    }
    expect(beamBuildings).toBeGreaterThan(0);
  });

  it("ジェッティの建物は上階の壁が正面へ張り出す(1階より奥行きが大きい)", () => {
    let jettyBuildings = 0;
    for (const [seed, over] of COMBOS) {
      for (const b of general(cached(seed, over))) {
        if (partsOf(b, "jetty").length === 0) continue;
        jettyBuildings++;
        const walls = partsOf(b, "wall");
        const ground = walls.find((w) => w.params?.floor === 0);
        const upper = walls.find((w) => w.params?.floor === 1);
        expect(ground).toBeDefined();
        expect(upper).toBeDefined();
        if (!ground || !upper) continue;
        // 壁体は同じ回転を共有する(scale[2] = 翼の奥行き)。
        // ジェッティは正面(奥行き方向)へ 0.32 張り出す
        expect(upper.transform.rotation).toBeCloseTo(
          ground.transform.rotation,
          9,
        );
        expect(upper.transform.scale[2]).toBeGreaterThan(
          ground.transform.scale[2] + 0.2,
        );
      }
    }
    expect(jettyBuildings).toBeGreaterThan(0);
  });
});

describe("building details: Prosperity 20/60/95 の素材階層移行(implementation-spec PHASE 4b)", () => {
  const WALL_ORDER = ["rough-wood", "plaster", "stone", "ashlar"];
  const ROOF_ORDER = ["thatch", "shingle", "tile", "slate"];
  const LEVELS = [20, 60, 95];

  function tierStats(prosperity: number): {
    wallMean: number;
    roofMean: number;
    wallLowShare: number;
    wallHighShare: number;
    windowsPerBuilding: number;
    chimneys: number;
    beamBuildings: number;
    buildings: number;
  } {
    let wallSum = 0;
    let roofSum = 0;
    let low = 0;
    let high = 0;
    let windows = 0;
    let chimneys = 0;
    let beamBuildings = 0;
    let n = 0;
    for (const seed of SEEDS) {
      const model = cached(seed, { prosperity });
      for (const b of general(model)) {
        n++;
        wallSum += WALL_ORDER.indexOf(b.materials.wall);
        roofSum += ROOF_ORDER.indexOf(b.materials.roof);
        const w = WALL_ORDER.indexOf(b.materials.wall);
        if (w <= 1) low++;
        if (w >= 2) high++;
        windows += partsOf(b, "window").length;
        chimneys += partsOf(b, "chimney").length;
        if (partsOf(b, "beam").length > 0) beamBuildings++;
      }
    }
    expect(n).toBeGreaterThan(0);
    return {
      wallMean: wallSum / n,
      roofMean: roofSum / n,
      wallLowShare: low / n,
      wallHighShare: high / n,
      windowsPerBuilding: windows / n,
      chimneys,
      beamBuildings,
      buildings: n,
    };
  }

  it("壁材・屋根材の階層(添字の平均)が 20 → 60 → 95 で単調に上がる", () => {
    const [s20, s60, s95] = LEVELS.map(tierStats) as [
      ReturnType<typeof tierStats>,
      ReturnType<typeof tierStats>,
      ReturnType<typeof tierStats>,
    ];
    expect(s20.wallMean).toBeLessThan(s60.wallMean);
    expect(s60.wallMean).toBeLessThan(s95.wallMean);
    expect(s20.roofMean).toBeLessThan(s60.roofMean);
    expect(s60.roofMean).toBeLessThan(s95.roofMean);
    // 端の水準では低層 / 高層が支配的(掘立・茅 ⇔ 石造・切石の移行)
    expect(s20.wallLowShare).toBeGreaterThan(0.6);
    expect(s95.wallHighShare).toBeGreaterThan(0.6);
  });

  it("窓の数・煙突が Prosperity で増え、木組みは中間帯で顕著", () => {
    const [s20, s60, s95] = LEVELS.map(tierStats) as [
      ReturnType<typeof tierStats>,
      ReturnType<typeof tierStats>,
      ReturnType<typeof tierStats>,
    ];
    expect(s20.windowsPerBuilding).toBeLessThan(s60.windowsPerBuilding);
    expect(s60.windowsPerBuilding).toBeLessThan(s95.windowsPerBuilding);
    expect(s20.chimneys / s20.buildings).toBeLessThan(
      s95.chimneys / s95.buildings,
    );
    // 木組み梁(plaster 連動)は中 Prosperity 帯で顕著、切石帯では消える
    expect(s60.beamBuildings).toBeGreaterThan(0);
    expect(s95.beamBuildings / s95.buildings).toBeLessThan(
      s60.beamBuildings / s60.buildings,
    );
  });
});

describe("building details: 役割による部品構成の差", () => {
  it("扉の寸法・窓高・石垣の有無が役割で異なる(hall / house / warehouse)", () => {
    let halls = 0;
    let houses = 0;
    let warehouses = 0;
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      // 同一モデル内の役割比較(detailAmount が共通の条件で比べる)
      let hallWindowH = -Infinity;
      let houseWindowH = -Infinity;
      for (const b of general(model)) {
        const door = partsOf(b, "door")[0];
        if (b.role === "warehouse") {
          warehouses++;
          // 倉庫は荷入れ口(高い扉)
          if (door) expect(door.transform.scale[1]).toBeCloseTo(2.5, 9);
          // 石垣は house / hall のみ
          expect(partsOf(b, "fence").length).toBe(0);
        } else if (door) {
          expect(door.transform.scale[1]).toBeLessThanOrEqual(2.15 + 1e-9);
        }
        if (b.role === "hall") {
          halls++;
          for (const w of partsOf(b, "window")) {
            hallWindowH = Math.max(hallWindowH, w.transform.scale[1]);
          }
        }
        if (b.role === "house") {
          houses++;
          for (const w of partsOf(b, "window")) {
            houseWindowH = Math.max(houseWindowH, w.transform.scale[1]);
          }
        }
        if (b.role === "outskirt" || b.role === "bridgehead") {
          expect(partsOf(b, "fence").length).toBe(0);
        }
      }
      // hall の窓は house より縦長(役割係数 1.3)
      if (hallWindowH > -Infinity && houseWindowH > -Infinity) {
        expect(hallWindowH).toBeGreaterThan(houseWindowH);
      }
    }
    // 比較が空検証にならない
    expect(halls).toBeGreaterThan(0);
    expect(houses).toBeGreaterThan(0);
    expect(warehouses).toBeGreaterThan(0);
  });

  it("石垣・外階段・屋根小窓が生成される(非空検証)", () => {
    let fences = 0;
    let stairs = 0;
    let dormers = 0;
    for (const [seed, over] of COMBOS) {
      const model = cached(seed, over);
      fences += countType(model, "fence");
      stairs += countType(model, "stair");
      dormers += countType(model, "dormer");
    }
    expect(fences).toBeGreaterThan(0);
    expect(stairs).toBeGreaterThan(0);
    expect(dormers).toBeGreaterThan(0);
  });
});
