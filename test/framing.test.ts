import { describe, expect, it } from "vitest";
import {
  FLOOR_HEIGHT,
  type Polygon,
  type WorldModel,
} from "../src/model/worldmodel";
import { buildGalleryWorld, GALLERY_TARGET_IDS } from "../src/pipeline/gallery";
import {
  computeGalleryFraming,
  HOME_DISTANCE_RATIO,
} from "../src/viewer/framing";
import { CAMERA_FOV } from "../src/viewer/constants";

const DESKTOP_ASPECT = 1280 / 800;
const MOBILE_ASPECT = 375 / 812;

/** 検証用: framing の home 距離(orbit の home 式と同じ) */
function homeDistance(size: number): number {
  return size * HOME_DISTANCE_RATIO;
}

/**
 * 検証用: 対象(建物または施設)の footprint・
 * 全高の見積もり・facing。framing 側の実装を再利用せず素朴に導出する
 */
function targetInfo(model: WorldModel): {
  footprint: Polygon;
  top: number;
  facing: number;
} {
  const b = model.buildings[0];
  if (b) {
    return {
      footprint: b.footprint,
      top: b.foundation.plinthHeight + b.floors * FLOOR_HEIGHT,
      facing: b.facing,
    };
  }
  const facilities = model.facilities;
  const first = facilities[0];
  if (!first) throw new Error("gallery world has no target");
  // 施設は複数(屋台の列)でも全体の和集合が鑑賞対象(framing と同じ扱い)
  let top = 0.5;
  const footprint: Polygon = [];
  for (const f of facilities) {
    footprint.push(...f.footprint);
    for (const p of f.parts) {
      top = Math.max(
        top,
        p.transform.position[1] + Math.abs(p.transform.scale[1]),
      );
    }
  }
  return { footprint, top, facing: first.facing };
}

describe("framing: ギャラリー初期構図(対象寸法駆動。G2b)", () => {
  it("全対象: 外接球(footprintバウンディングボックス+全高見積もり)が視野に余白つきで収まる距離になる", () => {
    for (const targetId of GALLERY_TARGET_IDS) {
      for (const aspect of [DESKTOP_ASPECT, MOBILE_ASPECT]) {
        const model = buildGalleryWorld(targetId, "everdusk-101", {});
        const f = computeGalleryFraming(model, CAMERA_FOV, aspect);
        const info = targetInfo(model);

        // 対象の外接半径の下限(パディング・屋根見積もりを除いた素の寸法)。
        // framing の距離が「この下限がぴったり収まる距離」以上であることを、
        // framing 自身の式を再利用せずに検証する
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const p of info.footprint) {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
        const w = maxX - minX;
        const d = maxZ - minZ;
        const rawR = Math.hypot(w / 2, d / 2, info.top / 2);

        const halfV = ((CAMERA_FOV / 2) * Math.PI) / 180;
        const halfH = Math.atan(Math.tan(halfV) * aspect);
        const halfMin = Math.min(halfV, halfH);
        const fitDistance = rawR / Math.sin(halfMin);

        // 素の外接球がぴったり収まる距離より必ず遠い(=収まる+余白)
        expect(homeDistance(f.size)).toBeGreaterThan(fitDistance);
        // かつ極端に遠すぎない(裏庭の塀・付属屋など footprint 外の部品と
        // 屋根・余白込みでも、footprint 基準の下限の5倍以内)
        expect(homeDistance(f.size)).toBeLessThan(fitDistance * 5);
      }
    }
  });

  it("注視点は対象の部品込みバウンディングボックスの内側(高さは 0 より上)", () => {
    const model = buildGalleryWorld("building/house", "everdusk-101", {});
    const f = computeGalleryFraming(model, CAMERA_FOV, DESKTOP_ASPECT);
    const building = model.buildings[0]!;
    // 部品位置の xz 範囲(スケール・回転による広がりを除いた内側の範囲)。
    // 注視点(バウンディングボックス中心)はこの範囲を大きく外れない
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const part of building.parts) {
      const [x, , z] = part.transform.position;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    expect(f.target.x).toBeGreaterThanOrEqual(minX - 5);
    expect(f.target.x).toBeLessThanOrEqual(maxX + 5);
    expect(f.target.z).toBeGreaterThanOrEqual(minZ - 5);
    expect(f.target.z).toBeLessThanOrEqual(maxZ + 5);
    expect(f.target.y).toBeGreaterThan(0);
    expect(f.target.y).toBeLessThan(
      building.foundation.plinthHeight + building.floors * FLOOR_HEIGHT + 20,
    );
  });

  it("縦長(モバイル)アスペクトでは横長(デスクトップ)より距離が遠い(収まる側で計算)", () => {
    const model = buildGalleryWorld("building/hall", "everdusk-101", {});
    const desktop = computeGalleryFraming(model, CAMERA_FOV, DESKTOP_ASPECT);
    const mobile = computeGalleryFraming(model, CAMERA_FOV, MOBILE_ASPECT);
    expect(mobile.size).toBeGreaterThan(desktop.size);
  });

  it("初期方位は対象の正面(facing)側から見る(正面方向との開きが90度未満)", () => {
    for (const targetId of GALLERY_TARGET_IDS) {
      const model = buildGalleryWorld(targetId, "everdusk-101", {});
      const f = computeGalleryFraming(model, CAMERA_FOV, DESKTOP_ASPECT);
      const info = targetInfo(model);
      // カメラは target + (sin az, cos az)×距離 に立つ(orbit.ts)。
      // そのオフセット方向と正面方向 (cos facing, sin facing) の内積が
      // 正なら、カメラは正面側の半空間にいる
      const camDir = { x: Math.sin(f.azimuth), z: Math.cos(f.azimuth) };
      const front = {
        x: Math.cos(info.facing),
        z: Math.sin(info.facing),
      };
      const dot = camDir.x * front.x + camDir.z * front.z;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it("決定論: 同一モデル・同一画角・同一アスペクトで同一の構図", () => {
    const a = computeGalleryFraming(
      buildGalleryWorld("building/waterside", "seed-f", {}),
      CAMERA_FOV,
      DESKTOP_ASPECT,
    );
    const b = computeGalleryFraming(
      buildGalleryWorld("building/waterside", "seed-f", {}),
      CAMERA_FOV,
      DESKTOP_ASPECT,
    );
    expect(a).toEqual(b);
  });
});
