/**
 * メッシュビルダー: WorldModel → Three.js シーングラフ。
 * WorldModel のみを入力とし、パイプラインの内部状態に依存しない
 * (contracts/pipeline.md)。
 */
import * as THREE from "three";
import type { WorldModel } from "../model/worldmodel";
import { sampleZoneMask, ZONE_KINDS, type ZoneKind } from "../model/zonemask";

/**
 * 材質ゾーンの基準色(art-direction 5.2節)。
 * 明度ムラは zoneMask.brightness(±8%)を乗じる。明度の一様スケールは
 * HSV 彩度を変えないため、大面積の彩度上限(同 2.1節)は基準色の規律のまま保たれる。
 */
const ZONE_COLORS: Record<ZoneKind, string> = {
  grass: "#7a8a55",
  dirt: "#8a7458",
  sandbar: "#a89570",
  marsh: "#6b7452",
};

/** 地面の放射方向の分割数(境界頂点数×リング数が頂点数の目安) */
const GROUND_RINGS = 20;

/**
 * 地面メッシュ: 境界ポリゴン内部を三角形分割した平坦メッシュ+
 * zoneMask をサンプリングした頂点カラー。
 * boundary は原点まわりの星形・時計回り(contracts/worldmodel.md が保証)なので、
 * 中心から境界へ向かう放射リングで一意に三角形分割できる。
 */
function buildGround(model: WorldModel): THREE.Mesh {
  const { boundary, zoneMask } = model.ground;
  const n = boundary.length;
  const rings = GROUND_RINGS;

  const zoneColors = ZONE_KINDS.map(
    (kind) => new THREE.Color(ZONE_COLORS[kind]),
  );

  const vertexCount = 1 + n * rings;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  const writeVertex = (index: number, x: number, z: number): void => {
    positions[index * 3] = x;
    positions[index * 3 + 2] = z;
    const sample = sampleZoneMask(zoneMask, x, z);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < zoneColors.length; k++) {
      const w = sample.weights[k as 0 | 1 | 2 | 3];
      const c = zoneColors[k];
      if (!c) continue;
      r += w * c.r;
      g += w * c.g;
      b += w * c.b;
    }
    colors[index * 3] = r * sample.brightness;
    colors[index * 3 + 1] = g * sample.brightness;
    colors[index * 3 + 2] = b * sample.brightness;
  };

  // 頂点: 中心1点+リング(内側→外側。最外リングは境界ポリゴンそのもの)
  writeVertex(0, 0, 0);
  const ringVertex = (j: number, i: number): number => 1 + (j - 1) * n + i;
  for (let j = 1; j <= rings; j++) {
    const f = j / rings;
    for (let i = 0; i < n; i++) {
      const p = boundary[i];
      if (!p) continue;
      writeVertex(ringVertex(j, i), p.x * f, p.z * f);
    }
  }

  // インデックス: 中心ファン+リング間の帯。境界が時計回り(shoelace 負)
  // のとき、この並びで法線が +y を向く
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    indices.push(0, ringVertex(1, i), ringVertex(1, (i + 1) % n));
  }
  for (let j = 1; j < rings; j++) {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = ringVertex(j, i);
      const b = ringVertex(j + 1, i);
      const c = ringVertex(j + 1, i1);
      const d = ringVertex(j, i1);
      indices.push(a, b, c, a, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const ground = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  ground.name = "ground";
  ground.receiveShadow = true;
  return ground;
}

export function buildWorld(model: WorldModel): THREE.Group {
  const group = new THREE.Group();
  group.name = "generated-world";
  group.add(buildGround(model));
  return group;
}

/** サブツリーの geometry / material を dispose して破棄する */
export function disposeWorld(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m.dispose();
    }
  });
  group.removeFromParent();
}
