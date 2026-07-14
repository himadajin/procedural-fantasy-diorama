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

/** 天幕(canopy)の厚み(実寸固定。契約「施設部品の語彙」) */
const CANOPY_T = 0.06;
/** 天幕の裏面(下面)の沈み(布の陰。軒裏の焼き込みと同じ流儀の控えめな値) */
const CANOPY_UNDERSIDE_SHADE = 0.78;

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
 * canopy: 片流れの布屋根(屋台の天幕)。厚み 0.06(実寸固定)の薄板が
 * ローカル +z へ流れ落ちる。position は高い縁の下端中心、scale =
 * 間口 × 落差(高い縁と低い縁の y 差)× 奥行き(契約「施設部品の語彙」)。
 * 下面は頂点カラーで一段沈める(布の陰。軒裏の焼き込みと同じ流儀)。
 */
function canopyPart(part: Part, buf: GeoBuffer, base: THREE.Color): void {
  const xf = makeXform(part);
  const sy = Math.max(Math.abs(part.transform.scale[1]), 1e-6);
  const t = CANOPY_T / sy; // 厚み(ローカル y 単位)
  // ローカル z は 0(高い縁 = position)〜 +1(低い縁)。y は 0(高い縁の
  // 下端)から低い縁の −1 へ流れ落ちる(contract の position 規約)
  const inside = xf([0, -0.5 + t / 2, 0.5]);
  const s4 = [1, 1, 1, 1];
  const sh = CANOPY_UNDERSIDE_SHADE;
  const sh4 = [sh, sh, sh, sh];
  // 上面(高い縁 y = t → 低い縁 y = −1 + t)
  face(
    buf,
    xf,
    [
      [-0.5, t, 0],
      [0.5, t, 0],
      [0.5, -1 + t, 1],
      [-0.5, -1 + t, 1],
    ],
    s4,
    inside,
    base,
  );
  // 下面(一段沈める)
  face(
    buf,
    xf,
    [
      [-0.5, 0, 0],
      [0.5, 0, 0],
      [0.5, -1, 1],
      [-0.5, -1, 1],
    ],
    sh4,
    inside,
    base,
  );
  // 縁 4 面(高い側・低い側・左右)
  face(
    buf,
    xf,
    [
      [-0.5, 0, 0],
      [0.5, 0, 0],
      [0.5, t, 0],
      [-0.5, t, 0],
    ],
    s4,
    inside,
    base,
  );
  face(
    buf,
    xf,
    [
      [-0.5, -1, 1],
      [0.5, -1, 1],
      [0.5, -1 + t, 1],
      [-0.5, -1 + t, 1],
    ],
    s4,
    inside,
    base,
  );
  face(
    buf,
    xf,
    [
      [-0.5, 0, 0],
      [-0.5, -1, 1],
      [-0.5, -1 + t, 1],
      [-0.5, t, 0],
    ],
    s4,
    inside,
    base,
  );
  face(
    buf,
    xf,
    [
      [0.5, 0, 0],
      [0.5, -1, 1],
      [0.5, -1 + t, 1],
      [0.5, t, 0],
    ],
    s4,
    inside,
    base,
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
      if (part.type === "canopy") {
        canopyPart(part, solid, base);
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
