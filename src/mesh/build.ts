/**
 * メッシュビルダー: WorldModel → Three.js シーングラフ。
 * WorldModel のみを入力とし、パイプラインの内部状態に依存しない
 * (contracts/pipeline.md)。地面・水面・岸スカートの三角形分割は
 * model/waterfield.ts の純関数(パイプラインの岸線抽出と同一)から導出し、
 * 絵とデータの岸線を一致させる。
 */
import * as THREE from "three";
import {
  SHORE_SKIRT_BOTTOM_Y,
  WATER_SURFACE_Y,
  type WorldModel,
} from "../model/worldmodel";
import { sampleZoneMask, ZONE_KINDS, type ZoneKind } from "../model/zonemask";
import {
  GRID_SPAN_RATIO,
  createWaterField,
  fieldGradient,
  gridCellCount,
  marchPositiveRegion,
  waterBodies,
  type WaterField,
} from "../model/waterfield";
import { buildCanalSurfaces, buildPaving, gradeColor } from "./paving";
import { buildBuildings } from "./buildings";
import { buildFacilities } from "./facilities";
import { buildVegetation } from "./vegetation";
import { applyLampTint, createLampTint } from "./wardparts";

/**
 * 材質ゾーンの基準色(art-direction 5.2節)。
 * 明度ムラは zoneMask.brightness(±8%)を乗じる。明度の一様スケールは
 * HSV 彩度を変えないため、大面積の彩度上限(同 2.1節)は基準色の規律のまま保たれる。
 * 舗装("paved")チャネルの色は固定値ではなく derived.roadGrade による
 * 土→砂利→石畳の補間(contracts/ground-water.md ZoneMask 節)。
 */
const ZONE_COLORS: Record<Exclude<ZoneKind, "paved">, string> = {
  grass: "#7a8a55",
  dirt: "#8a7458",
  sandbar: "#a89570",
  marsh: "#6b7452",
};

/** モデルの roadGrade を反映した材質ゾーンの頂点カラー表を作る */
function zoneColorTable(model: WorldModel): THREE.Color[] {
  return ZONE_KINDS.map((kind) =>
    kind === "paved"
      ? gradeColor(model.meta.derived.roadGrade)
      : new THREE.Color(ZONE_COLORS[kind]),
  );
}

/** 水面の基準色(art-direction 5.3節)。青緑の純色は置かず灰を混ぜた青灰 */
const WATER_DEEP = "#2e4a5c";
const WATER_SHALLOW = "#5f8494";
/** 浅瀬の帯の幅。水際の細い帯に限り、水面の大部分は深みの暗さを保つ(同 2.2節) */
const SHALLOW_BAND = 4.5;

/**
 * 外周が霧のときの外縁スカートの深さ(ワールド一辺比)と内側への絞り
 * (深さ比)。深い台座として絞りながら暗い土色へ落とし、
 * 低い視点でも「切れた薄板」に見せない(絵本の断面模型。art-direction 6節)
 */
const FOG_RIM_DEPTH_RATIO = 0.09;
const FOG_RIM_TAPER = 0.55;
/** 外縁水面のとき、海面を地面の縁の下へ差し込む量(隙間を見せない) */
const SEA_UNDERLAP = 2;
/** 霧閉じのとき、水面を外縁の縁までわずかに延長する量(切り口を台座の陰へ) */
const WATER_EDGE_EXTENSION = 2;
/** 霧閉じの台座の深さへ、水際の岸スカートを馴染ませる距離(境界からの距離) */
const RIM_BLEND_DIST = 24;
/** 外縁水面の広がり(ワールド一辺比)。どの角度からも水平線まで届く */
const SEA_EXTENT_RATIO = 2.2;
/** 岸スカートの色(上端=湿った地面、下端=暗い土。黄土〜褐色族) */
const SKIRT_TOP_SHADE = 0.8;
const SKIRT_BOTTOM_SHADE = 0.42;

function smoothstep01(t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
}

/** zoneMask をサンプリングして頂点カラー(r, g, b)を得る */
function zoneColorAt(
  model: WorldModel,
  zoneColors: THREE.Color[],
  x: number,
  z: number,
): [number, number, number] {
  const sample = sampleZoneMask(model.ground.zoneMask, x, z);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < zoneColors.length; k++) {
    const w = sample.weights[k] ?? 0;
    const c = zoneColors[k];
    if (!c) continue;
    r += w * c.r;
    g += w * c.g;
    b += w * c.b;
  }
  return [r * sample.brightness, g * sample.brightness, b * sample.brightness];
}

/**
 * 地面+岸スカートのメッシュ。
 * 地面は水域ポリゴンを穴として除いた陸地(landSdf > 0)の三角形分割
 * (細分グリッドのクリップ。implementation-spec PHASE 2)。
 * 岸スカートは陸地の縁の全周に、地面高 y=0 から水面下(岸=−1.6、
 * 霧閉じの外縁=さらに下)まで落とす帯メッシュ。同じ等値線から作るため
 * 地面との間に隙間ができない。
 */
function buildGround(model: WorldModel, field: WaterField): THREE.Mesh {
  const size = model.ground.size;
  const zoneColors = zoneColorTable(model);
  const march = marchPositiveRegion(field.landSdf, size, gridCellCount(size));

  const landVertexCount = march.positions.length / 2;
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < landVertexCount; i++) {
    const x = march.positions[i * 2] ?? 0;
    const z = march.positions[i * 2 + 1] ?? 0;
    positions.push(x, 0, z);
    normals.push(0, 1, 0);
    const [r, g, b] = zoneColorAt(model, zoneColors, x, z);
    colors.push(r, g, b);
  }
  const indices: number[] = march.triangles.slice();

  // 岸スカート: 縁の各点を上下 2 頂点に分け、縦帯の四角形でつなぐ。
  // 外縁(境界が活性)の下端: 外縁水面なら海面下(岸と同じ)。霧閉じなら
  // 深い台座として内側へ絞りながら暗い土色へ落とす(「絵本の断面模型」の台座。
  // art-direction 6節)。低い視点でも切れた薄板に見えない
  const fogEdge = model.ground.edgeStyle !== "water";
  const rimBottom = fogEdge ? -size * FOG_RIM_DEPTH_RATIO : SHORE_SKIRT_BOTTOM_Y;
  for (const contour of march.contours) {
    const pts = contour.points;
    const n = pts.length;
    if (n < 2) continue;
    const base = positions.length / 3;
    const outward: { x: number; z: number }[] = [];
    for (const p of pts) {
      // 外向き(水・外周側)= 陸地関数の負勾配
      const g = fieldGradient(field.landSdf, p.x, p.z);
      const len = Math.hypot(g.x, g.z);
      const ox = len > 1e-9 ? -g.x / len : 1;
      const oz = len > 1e-9 ? -g.z / len : 0;
      outward.push({ x: ox, z: oz });
      // 岸(水域が活性)か外縁(境界が活性)かで下端の深さ・絞りを変える。
      // 霧閉じでは、境界に近づく岸(水際の土手)も台座の深さへ連続に馴染ませ、
      // 台座に切れ込み(隙間)を見せない
      const boundaryDist = field.boundarySdf(p.x, p.z);
      const isShore = field.waterSdf(p.x, p.z) <= boundaryDist;
      let rimBlend = 0;
      if (fogEdge) {
        rimBlend = isShore
          ? Math.min(1, Math.max(0, 1 - boundaryDist / RIM_BLEND_DIST))
          : 1;
      }
      const bottom =
        SHORE_SKIRT_BOTTOM_Y + (rimBottom - SHORE_SKIRT_BOTTOM_Y) * rimBlend;
      const inset = -bottom * FOG_RIM_TAPER * rimBlend;
      const [r, g2, b] = zoneColorAt(model, zoneColors, p.x, p.z);
      positions.push(
        p.x,
        0,
        p.z,
        p.x - ox * inset,
        bottom,
        p.z - oz * inset,
      );
      colors.push(
        r * SKIRT_TOP_SHADE,
        g2 * SKIRT_TOP_SHADE,
        b * SKIRT_TOP_SHADE,
        r * SKIRT_BOTTOM_SHADE,
        g2 * SKIRT_BOTTOM_SHADE,
        b * SKIRT_BOTTOM_SHADE,
      );
      normals.push(ox, 0, oz, ox, 0, oz);
    }
    const segCount = contour.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % n;
      const p = pts[i];
      const q = pts[j];
      const o = outward[i];
      if (!p || !q || !o) continue;
      const topA = base + i * 2;
      const botA = topA + 1;
      const topB = base + j * 2;
      const botB = topB + 1;
      // 面が外向きになる巻き方を選ぶ: (pT, qT, qB) の面法線 ∝ (dz, 0, −dx)
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (dz * o.x - dx * o.z >= 0) {
        indices.push(topA, topB, botB, topA, botB, botA);
      } else {
        indices.push(topA, botB, topB, topA, botA, botB);
      }
    }
  }

  // 魔法灯の足元の照り返し(頂点カラー焼き込み。PHASE 5b commit 18。
  // 舗装 mesh/paving.ts と同じ純関数を共用する。art-direction 3節)
  applyLampTint(createLampTint(model), positions, colors);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(normals), 3),
  );
  geometry.setIndex(indices);

  const ground = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  ground.name = "ground";
  ground.receiveShadow = true;
  return ground;
}

/** ビューワーが毎フレーム更新する時間 uniform(WorldModel には持ち込まない) */
export interface WaterTimeUniform {
  value: number;
}

/**
 * 水面ノイズの簡略度 uniform(1=3オクターブ / 0=1オクターブ)。
 * 描画プリセットが表示側で切り替える(WorldModel・色の規範は不変。
 * contracts/pipeline.md「描画プリセット・LOD・デバッグ表示」)
 */
export interface WaterDetailUniform {
  value: number;
}

/**
 * 水面メッシュ。湖・池ポリゴン(+外縁水面)から生成し、
 * 水面高 y=-0.6 に置く。岸距離による浅瀬→深みの色を頂点カラーに焼き、
 * 低周波の緩い法線揺らぎと控えめなフレネル風ハイライトを
 * onBeforeCompile の軽い拡張で加える(implementation-spec 1.8節、
 * art-direction 5.3節・7節)。実質不透明で水中は描かない。
 * 琥珀のハイライトは太陽(平行光)のスペキュラのみが作るため太陽方向にのみ出る。
 */
function buildWater(
  model: WorldModel,
  field: WaterField,
  timeUniform: WaterTimeUniform,
  detailUniform: WaterDetailUniform,
): THREE.Mesh | null {
  const size = model.ground.size;
  const seaEdge = model.ground.edgeStyle === "water";

  // 水面の領域: 水域に、外縁水面(境界の外)または水際の延長を加える
  const surfaceSdf = seaEdge
    ? (x: number, z: number): number =>
        Math.min(field.waterSdf(x, z), field.boundarySdf(x, z) - SEA_UNDERLAP)
    : (x: number, z: number): number =>
        Math.max(
          field.waterSdf(x, z),
          -(field.boundarySdf(x, z) + WATER_EDGE_EXTENSION),
        );
  const march = marchPositiveRegion(
    (x, z) => -surfaceSdf(x, z),
    size,
    gridCellCount(size),
  );
  const canalSurfaces = buildCanalSurfaces(model, field);
  if (march.triangles.length === 0 && !seaEdge && canalSurfaces.length === 0) {
    return null;
  }

  const deep = new THREE.Color(WATER_DEEP);
  const shallow = new THREE.Color(WATER_SHALLOW);
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const vertexCount = march.positions.length / 2;
  const pushWaterVertex = (x: number, z: number): void => {
    positions.push(x, WATER_SURFACE_Y, z);
    normals.push(0, 1, 0);
    // 岸距離による浅瀬→深み(浅瀬は水際の細い帯のみ)
    const t = smoothstep01(field.shoreDist(x, z) / SHALLOW_BAND);
    colors.push(
      shallow.r + (deep.r - shallow.r) * t,
      shallow.g + (deep.g - shallow.g) * t,
      shallow.b + (deep.b - shallow.b) * t,
    );
  };
  for (let i = 0; i < vertexCount; i++) {
    pushWaterVertex(march.positions[i * 2] ?? 0, march.positions[i * 2 + 1] ?? 0);
  }
  const indices: number[] = march.triangles.slice();

  if (seaEdge) {
    // 外縁水面: マーチンググリッドの外側を水平線まで四方の台形で埋める
    const inner = (size * GRID_SPAN_RATIO) / 2;
    const outer = size * SEA_EXTENT_RATIO;
    const ring = [
      [-inner, -inner],
      [inner, -inner],
      [inner, inner],
      [-inner, inner],
      [-outer, -outer],
      [outer, -outer],
      [outer, outer],
      [-outer, outer],
    ] as const;
    const base = positions.length / 3;
    for (const [x, z] of ring) pushWaterVertex(x, z);
    const quads = [
      [4, 5, 1, 0],
      [5, 6, 2, 1],
      [6, 7, 3, 2],
      [7, 4, 0, 3],
    ] as const;
    for (const [a, b, c, d] of quads) {
      indices.push(base + a, base + d, base + c, base + a, base + c, base + b);
    }
  }

  // 水路の水面: 湖・池と同じマテリアル・同じ頂点カラー規範のまま同一メッシュへ
  // 統合する(art-direction 5.3節「水路の水色は湖・池と共通」。draw call も増えない)。
  // 高さは地面よりわずかに上の掘り込みチャネル(contracts/ground-water.md Water 節)
  for (const surf of canalSurfaces) {
    const base = positions.length / 3;
    const band = Math.min(SHALLOW_BAND, surf.width * 0.45);
    const count = surf.positions.length / 3;
    for (let i = 0; i < count; i++) {
      positions.push(
        surf.positions[i * 3] ?? 0,
        surf.positions[i * 3 + 1] ?? 0,
        surf.positions[i * 3 + 2] ?? 0,
      );
      normals.push(0, 1, 0);
      // 縁→中央を岸距離とみなし、湖・池と同じ浅瀬→深みの写像で色を決める
      const t = smoothstep01(((surf.edgeT[i] ?? 0) * surf.width) / 2 / band);
      colors.push(
        shallow.r + (deep.r - shallow.r) * t,
        shallow.g + (deep.g - shallow.g) * t,
        shallow.b + (deep.b - shallow.b) * t,
      );
    }
    for (const idx of surf.indices) indices.push(base + idx);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Float32Array(normals), 3),
  );
  geometry.setIndex(indices);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.32,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = timeUniform;
    shader.uniforms.uWaterDetail = detailUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWaterWorld;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWaterWorld = transformed;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uWaterTime;\nuniform float uWaterDetail;\nvarying vec3 vWaterWorld;",
      )
      .replace(
        "#include <normal_fragment_begin>",
        `#include <normal_fragment_begin>
        {
          // 低周波ノイズの緩い法線揺らぎ(art-direction 7節)。時間はビューワーの uniform。
          // 周波数は非整数比で混ぜ、縞に見えないようにする。
          // uWaterDetail は描画プリセットの簡略度(1=3オクターブ / 0=主
          // オクターブのみ。uniform 分岐なので実行パスは一様に短絡される)
          float t = uWaterTime * 0.45;
          vec2 wp = vWaterWorld.xz;
          float nx = sin(wp.x * 0.231 + wp.y * 0.113 + t);
          float nz = cos(wp.y * 0.197 - wp.x * 0.089 - t * 0.87);
          if (uWaterDetail > 0.5) {
            nx += 0.7 * sin(wp.x * 0.071 - wp.y * 0.157 + t * 0.73)
                + 0.5 * sin(wp.y * 0.317 - t * 0.61);
            nz += 0.7 * sin(wp.x * 0.149 + wp.y * 0.059 + t * 0.55)
                + 0.5 * cos(wp.x * 0.283 + t * 0.49);
          } else {
            // 簡略時も揺らぎの見かけの振幅を保つ(絵の規範は同一)
            nx *= 1.4;
            nz *= 1.4;
          }
          normal = normalize(normal + vec3(nx, 0.0, nz) * 0.028);
        }`,
      )
      .replace(
        "#include <opaque_fragment>",
        `{
          // 控えめなフレネル風の縁の明るみ(霧・空と同族の青灰。art-direction 7節)
          float fres = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.0);
          outgoingLight += vec3(0.62, 0.68, 0.75) * fres * 0.08;
        }
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "pfd-water";

  const water = new THREE.Mesh(geometry, material);
  water.name = "water";
  water.receiveShadow = true;
  return water;
}

export function buildWorld(model: WorldModel): THREE.Group {
  const group = new THREE.Group();
  group.name = "generated-world";
  const field = createWaterField(model.ground.boundary, waterBodies(model.water));
  group.add(buildGround(model, field));
  // ビューワー側の時間 uniform(表示演出。WorldModel には影響しない)。
  // 水面の揺らぎと建物発光束の明滅が共有する(reduced-motion では
  // main が更新を止めるため両方とも静止する)
  const timeUniform: WaterTimeUniform = { value: 0 };
  group.userData.waterTime = timeUniform;
  // 水面ノイズの簡略度(描画プリセット。既定は高=3オクターブ。
  // main が userData 経由でライブに切り替える)
  const detailUniform: WaterDetailUniform = { value: 1 };
  group.userData.waterDetail = detailUniform;
  const water = buildWater(model, field, timeUniform, detailUniform);
  if (water) group.add(water);

  // 道路・広場・水路の護岸(マージ 1 メッシュ)+杭(InstancedMesh 1)
  const { paving, piles } = buildPaving(model, field);
  if (paving) group.add(paving);
  if (piles) group.add(piles);

  // 建物+結界構造+魔法灯・浮遊要素+橋(躯体/屋根/発光マージ+各
  // InstancedMesh。部品展開は mesh/wardparts.ts / mesh/bridgeparts.ts。
  // mesh/buildings.ts が束ねる。計画デバッグ描画は PHASE 5b で全廃)
  for (const obj of buildBuildings(model, timeUniform)) group.add(obj);

  // 施設(Phase D): マージ束(躯体+屋根)+回転部品(風車ロータ・水輪)の
  // 個別メッシュ(mesh/facilities.ts)。回転部品は userData.spin を持ち、
  // viewer(spin.ts)が表示演出として回す。生成時に 1 回収集して
  // userData.spinners へ置く(毎フレームの traverse を避ける)
  const spinners: THREE.Object3D[] = [];
  for (const obj of buildFacilities(model)) {
    group.add(obj);
    obj.traverse((child) => {
      if (child.userData.spin) spinners.push(child);
    });
  }
  group.userData.spinners = spinners;

  // 植生(PHASE 6 commit 20): 幹・樹冠+低木の InstancedMesh と草むらの
  // マージメッシュ(mesh/vegetation.ts。draw call +3 以内)
  for (const obj of buildVegetation(model)) group.add(obj);

  return group;
}

/** サブツリーの geometry / material を dispose して破棄する */
export function disposeWorld(group: THREE.Object3D): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m.dispose();
    }
    if (obj instanceof THREE.InstancedMesh) obj.dispose();
  });
  group.removeFromParent();
}
