/**
 * 施設(Facility)のメッシュビルダー(Phase D タスク D2b)。
 * 部品語彙の正は docs/internal/contracts/facilities.md「施設部品の語彙」、
 * 色は art-direction 5.5節(基準色表は mesh/buildings.ts の
 * MATERIAL_COLORS と同期)。
 *
 * 施設の parts はすべてマージ経路(頂点カラー+±8% 明度ムラ+AO 焼き込み。
 * 位置ハッシュ由来・乱数ストリーム非消費)で、躯体束(facilities-solid)と
 * 屋根束(facilities-roof)の 2 メッシュへ集約する。既存の建物部品型
 * (fence / plinth / gable 等)は mesh/buildings.ts の MERGE_HANDLERS を
 * そのまま流用し、経路・形状を建物と完全に一致させる。beam は建物では
 * インスタンス経路だが、施設(柵の柱・横木)ではマージへ寄せる(契約
 * 「新設 4 型はいずれもマージ経路」の柵の集約方針)。
 * 未知の型は warn を出して読み飛ばす(建物メッシュと同じ流儀)。
 */
import * as THREE from "three";
import type { Part, WorldModel } from "../model/worldmodel";
import {
  MERGE_HANDLERS,
  ROOF_MATERIAL_IDS,
  boxPart,
  buildGeoBuffer,
  face,
  makeXform,
  materialColor,
  type GeoBuffer,
  type L,
} from "./buildings";

/**
 * 作物の緑(畝の上面のみ。`params.top` 1 / 2。art-direction 5.5節)。
 * 0(または省略)は materialId の色のまま(裸の耕土)。
 */
const CROP_COLORS: Record<number, THREE.Color> = {
  1: new THREE.Color("#83975a"),
  2: new THREE.Color("#95a163"),
};

/** 柵の柱・横木(beam)の足元の焼き込み(建物の石垣と同じ帯の控えめな値) */
const BEAM_FOOT_AO = 0.85;

/**
 * ground-patch: 地面に接する薄い直方体(畑の基盤・畝・牧草パッチ等)。
 * `params.top` で上面のみ作物の緑に塗り分け、側面は materialId のまま
 * (契約「施設部品の語彙」)。底面は地面に接して見えないため省略する
 * (形状契約は「薄い直方体」のまま。描画の縮約)。
 */
function groundPatchPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const inside = xf([0, 0.4, 0]);
  const s4 = [1, 1, 1, 1];
  const sides: L[][] = [
    [
      [-0.5, 0, -0.5],
      [0.5, 0, -0.5],
      [0.5, 1, -0.5],
      [-0.5, 1, -0.5],
    ],
    [
      [0.5, 0, -0.5],
      [0.5, 0, 0.5],
      [0.5, 1, 0.5],
      [0.5, 1, -0.5],
    ],
    [
      [0.5, 0, 0.5],
      [-0.5, 0, 0.5],
      [-0.5, 1, 0.5],
      [0.5, 1, 0.5],
    ],
    [
      [-0.5, 0, 0.5],
      [-0.5, 0, -0.5],
      [-0.5, 1, -0.5],
      [-0.5, 1, 0.5],
    ],
  ];
  for (const quad of sides) face(buf, xf, quad, s4, inside, base);
  const top = Math.round(part.params?.top ?? 0);
  const topColor = CROP_COLORS[top] ?? base;
  face(
    buf,
    xf,
    [
      [-0.5, 1, -0.5],
      [0.5, 1, -0.5],
      [0.5, 1, 0.5],
      [-0.5, 1, 0.5],
    ],
    s4,
    inside,
    topColor,
  );
}

/**
 * WorldModel の facilities を三角形化する。躯体束と屋根束の最大 2 つの
 * マージメッシュを返す(facilities が空なら空配列)。
 */
export function buildFacilities(model: WorldModel): THREE.Object3D[] {
  if (model.facilities.length === 0) return [];
  const solid: GeoBuffer = {
    positions: [],
    normals: [],
    colors: [],
    indices: [],
  };
  const roof: GeoBuffer = {
    positions: [],
    normals: [],
    colors: [],
    indices: [],
  };
  let unknown = 0;

  for (const facility of model.facilities) {
    for (const part of facility.parts) {
      const base = materialColor(part.materialId);
      if (part.type === "ground-patch") {
        groundPatchPart(part, solid, base);
        continue;
      }
      if (part.type === "beam") {
        boxPart(part, solid, base, BEAM_FOOT_AO);
        continue;
      }
      const handler = MERGE_HANDLERS[part.type];
      if (handler) {
        handler(part, ROOF_MATERIAL_IDS.has(part.materialId) ? roof : solid, base);
        continue;
      }
      unknown++;
    }
  }
  if (unknown > 0) {
    console.warn(`mesh/facilities: 未知の部品型 ${unknown} 件を読み飛ばした`);
  }

  const out: THREE.Object3D[] = [];
  const addMerged = (buf: GeoBuffer, name: string, roughness: number): void => {
    if (buf.indices.length === 0) return;
    const mesh = new THREE.Mesh(
      buildGeoBuffer(buf),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness }),
    );
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  };
  addMerged(solid, "facilities-solid", 1);
  addMerged(roof, "facilities-roof", 0.92);
  return out;
}
