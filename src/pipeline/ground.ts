/**
 * 段2「地面」: World Scale 駆動の実寸、seed ごとに歪む有機的な外縁境界ポリゴン、
 * 材質ゾーン(zoneMask)の下地を生成する。
 * データの正は docs/internal/contracts/worldmodel.md(Ground 節)。
 *
 * - 境界は低周波の調和波で円を歪めた星形ポリゴン(makeRng(seed, "ground"))。
 *   閉多角形・自己交差なし・時計回り(shoelace 符号負)を保証する
 * - zoneMask の下地は「草地ベース+土の斑・むら」。砂洲・湿地チャネルは
 *   水系段(pipeline/water)が水域近傍へ書き込むため、この段では 0 のまま
 * - edgeStyle(外周の閉じ方)も水系段が確定する(初期値 "fog" を維持)
 */
import { makeRng } from "../rng";
import type { Polygon, WorldModel } from "../model/worldmodel";
import { createZoneMask, zoneCellIndex, type ZoneMask } from "../model/zonemask";
import { fbm2D, noiseSeed } from "./noise";

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 境界を歪める低周波調和波の次数(k=1 は中心ずれになるため使わない) */
const BOUNDARY_HARMONICS = [2, 3, 4, 5, 6] as const;
/** 基準半径(size 比)。歪み込みで半径が 0.3〜0.5×size に収まる設計 */
const BASE_RADIUS_RATIO = 0.44;

/**
 * seed ごとに歪む有機的な外縁境界ポリゴンを生成する。
 * 原点まわりの星形(半径関数 r(θ))なので自己交差しない。
 * 偏角を減少方向に回ることで時計回り(shoelace 符号負)にする。
 */
export function generateBoundary(seed: string, size: number): Polygon {
  const rng = makeRng(seed, "ground");
  // 消費順・消費数固定: 次数ごとに (振幅, 位相) の2値
  const harmonics = BOUNDARY_HARMONICS.map((k) => ({
    k,
    amp: (0.08 / k) * rng.range(0.4, 1.0),
    phase: rng.range(0, Math.PI * 2),
  }));

  const base = size * BASE_RADIUS_RATIO;
  const count = clamp(Math.round(size / 4), 64, 128);
  const points: Polygon = [];
  for (let i = 0; i < count; i++) {
    const theta = -(i / count) * Math.PI * 2;
    let r = 1;
    for (const h of harmonics) r += h.amp * Math.cos(h.k * theta + h.phase);
    points.push({
      x: base * r * Math.cos(theta),
      z: base * r * Math.sin(theta),
    });
  }
  return points;
}

/** 土の斑の面積感(草地ベースに対する上限重み) */
const DIRT_MAX = 0.92;
/** 明度ムラの振幅(art-direction 5.2節: ±8%程度) */
const BRIGHTNESS_VARIATION = 0.08;

/**
 * zoneMask の下地を生成する: 草地ベース+土の斑・むら。
 * 斑は格子ハッシュノイズ(順序非依存)で作り、乱数ストリームを消費しない。
 */
export function generateZoneMask(seed: string, size: number): ZoneMask {
  const resolution = clamp(Math.round(size / 5), 48, 112);
  const cellSize = size / resolution;
  const mask = createZoneMask(resolution, cellSize);

  const dirtSeed = noiseSeed(seed, "ground/dirt");
  const brightSeed = noiseSeed(seed, "ground/brightness");
  const patchScale = size / 7; // 土の斑の基本波長
  const brightScale = size / 10; // 明度ムラの基本波長

  const half = size / 2;
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const x = (ix + 0.5) * cellSize - half;
      const z = (iz + 0.5) * cellSize - half;

      const n = fbm2D(dirtSeed, x / patchScale, z / patchScale, 2);
      const dirt = clamp(
        0.03 + DIRT_MAX * smoothstep(0.55, 0.68, n),
        0,
        0.95,
      );

      const w = zoneCellIndex(mask, ix, iz);
      mask.weights[w] = 1 - dirt; // grass
      mask.weights[w + 1] = dirt; // dirt
      // sandbar / marsh は水系段が書き込む(この段では 0 のまま)

      // 明度ムラ: 低周波ノイズに、土の斑の芯をわずかに沈める相関を加える
      // (合計は ±8% の帯域内にクランプ。art-direction 5.2節)
      const b = fbm2D(brightSeed, x / brightScale, z / brightScale, 2);
      mask.brightness[iz * resolution + ix] = clamp(
        1 + BRIGHTNESS_VARIATION * (2 * b - 1) - 0.035 * dirt,
        1 - BRIGHTNESS_VARIATION,
        1 + BRIGHTNESS_VARIATION,
      );
    }
  }
  return mask;
}

/** パイプライン段の実体: ground 一式を埋める */
export function runGround(model: WorldModel): void {
  const size = model.meta.derived.worldSize;
  model.ground.size = size;
  model.ground.boundary = generateBoundary(model.meta.seed, size);
  model.ground.zoneMask = generateZoneMask(model.meta.seed, size);
  // サマリーは段13(summary)の担当だが、中間PHASEでは部分的に埋める
  // (contracts/worldmodel.md の Summary 節)
  model.summary.scale.worldSize = size;
}
