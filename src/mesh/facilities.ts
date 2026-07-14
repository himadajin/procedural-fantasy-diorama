/**
 * 施設(Facility)のメッシュビルダー。
 * 部品語彙の正は docs/internal/contracts/facilities.md「施設部品の語彙」、
 * 色は art-direction 5.5節(基準色表は mesh/buildings.ts の
 * MATERIAL_COLORS と同期)。
 *
 * 施設の parts は原則マージ経路(頂点カラー+±8% 明度ムラ+AO 焼き込み。
 * 位置ハッシュ由来・乱数ストリーム非消費)で、躯体束(facilities-solid)と
 * 屋根束(facilities-roof)の 2 メッシュへ集約する。既存の建物部品型
 * (fence / plinth / gable 等)は mesh/buildings.ts の MERGE_HANDLERS を
 * そのまま流用し、経路・形状を建物と完全に一致させる。beam は建物では
 * インスタンス経路だが、施設(柵の柱・横木)ではマージへ寄せる(契約
 * 「新設 4 型はいずれもマージ経路」の柵の集約方針)。door / window
 * (風車・水車小屋の開口)も建物では INSTANCED_TYPES(共有プールの
 * インスタンス経路)だが、施設はその共有プールを持たないため
 * mesh/buildings.ts の `openingPart`(建物の `openingPieces` と同一の
 * 枠寸法・色をマージバッファへ描く関数)へ寄せ、追加の draw call を
 * 増やさない。
 *
 * 例外(contracts/facilities.md「表示演出(風車・水車の回転)」): 回転する
 * 部品(`windmill-rotor` / `water-wheel`)は viewer が
 * 表示演出として個別に回すため、部品 1 つ = 1 メッシュ(軸原点のローカル
 * ジオメトリ+親 Group で配置)とし、`userData.spin = { kind, phase }` で
 * viewer(src/viewer/spin.ts)へ引き渡す。回転の速度・向きは viewer が
 * 持ち、WorldModel・メッシュは静的データ(初期角込みの姿勢)のみ。
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
  openingPart,
  type GeoBuffer,
  type L,
  type W,
} from "./buildings";

/**
 * 回転部品のメッシュが viewer へ引き渡す表示演出データ
 * (`userData.spin`)。回転の速度・向きの数値は viewer(spin.ts)が持つ。
 */
export interface SpinData {
  /** rotor = 風車ロータ(ローカル z 軸回り)/ wheel = 水輪(ローカル x 軸回り) */
  kind: "rotor" | "wheel";
  /** 初期回転角(rad。WorldModel の params.phase。静的ジオメトリの個体差) */
  phase: number;
}

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

// --- 回転部品(windmill-rotor / water-wheel) ---

/** 帆の幅・長さ(契約「windmill(風車)」造形の性質: 幅 1.05 × 長さ 3.5。
 *  桁の先端側へ寄せる) */
const SAIL_W = 1.05;
const SAIL_LEN = 3.5;
/** 桁の断面(0.16 角)とハブの半径・奥行き */
const SPAR_T = 0.16;
const HUB_HALF = 0.3;
/** 水輪のリム・パドルの断面(提案値) */
const WHEEL_RIM_RADIAL = 0.09;
const WHEEL_RIM_AXIAL = 0.06;
const WHEEL_PADDLE_LEN = 0.55;
const WHEEL_PADDLE_T = 0.05;

/** 恒等変換(ローカル実寸で作図するための xf) */
function identityXf(): (pt: L) => W {
  return makeXform({
    type: "",
    transform: { position: [0, 0, 0], rotation: 0, scale: [1, 1, 1] },
    materialId: "",
  } as Part);
}

/** 軸平行の実寸ボックス(6 面)をローカルジオメトリへ押し込む */
function localBox(
  buf: GeoBuffer,
  base: THREE.Color,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  const xf = identityXf();
  const inside: W = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const s4 = [1, 1, 1, 1];
  const quads: L[][] = [
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
    ],
    [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    [
      [x0, y0, z0],
      [x0, y0, z1],
      [x0, y1, z1],
      [x0, y1, z0],
    ],
    [
      [x1, y0, z0],
      [x1, y0, z1],
      [x1, y1, z1],
      [x1, y1, z0],
    ],
    [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
    [
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
  ];
  for (const q of quads) face(buf, xf, q, s4, inside, base);
}

/**
 * 任意の直交軸(u・v・w)で張った実寸ボックス(水輪のリム・パドルなどの
 * 回転面内で傾いた部材)をローカルジオメトリへ押し込む。
 */
function orientedBox(
  buf: GeoBuffer,
  base: THREE.Color,
  center: W,
  u: W,
  uh: number,
  v: W,
  vh: number,
  w: W,
  wh: number,
): void {
  const xf = identityXf();
  const corner = (su: number, sv: number, sw: number): L => [
    center[0] + u[0] * uh * su + v[0] * vh * sv + w[0] * wh * sw,
    center[1] + u[1] * uh * su + v[1] * vh * sv + w[1] * wh * sw,
    center[2] + u[2] * uh * su + v[2] * vh * sv + w[2] * wh * sw,
  ];
  const s4 = [1, 1, 1, 1];
  const faces: [L, L, L, L][] = [
    [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1)],
    [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
    [corner(-1, -1, -1), corner(-1, 1, -1), corner(-1, 1, 1), corner(-1, -1, 1)],
    [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)],
    [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
    [corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1)],
  ];
  for (const q of faces) face(buf, xf, q, s4, center, base);
}

/**
 * 回転部品を「軸原点のローカルジオメトリ+配置用の親 Group」として組む。
 * 親 Group が部品の position(軸中心)と Y 回転を持ち、子メッシュが
 * ローカル軸(rotor = z / wheel = x)回りに回転する(初期角 = phase。
 * viewer の spin.ts が毎フレーム上書きする。reduced-motion では静止)。
 */
function buildSpinnerObject(
  part: Part,
  buf: GeoBuffer,
  spin: SpinData,
  name: string,
): THREE.Object3D {
  const mesh = new THREE.Mesh(
    buildGeoBuffer(buf),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  );
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.spin = spin;
  if (spin.kind === "rotor") mesh.rotation.z = spin.phase;
  else mesh.rotation.x = spin.phase;

  const group = new THREE.Group();
  const [px, py, pz] = part.transform.position;
  group.position.set(px, py, pz);
  // Part の変換規約と同じ Y 回転(makeXform: +x → (cosθ, 0, −sinθ))
  group.rotation.y = part.transform.rotation;
  group.add(mesh);
  return group;
}

/**
 * windmill-rotor: ハブ+羽根 4 枚(桁 = 木部の固定色、帆板 = materialId)。
 * ローカル +z = 軸方向、回転面 = xy。羽根は 0°/90°/180°/270° の軸平行
 * 作図とし、任意の位相は親の回転(phase + viewer)で与える。
 */
function buildRotorObject(part: Part): THREE.Object3D {
  const buf: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const sail = materialColor(part.materialId);
  const wood = materialColor("wood");
  const dia = Math.abs(part.transform.scale[0]);
  const len = dia / 2 - 0.1;
  const hubD = Math.abs(part.transform.scale[2]);

  // ハブ(木部)
  localBox(buf, wood, -HUB_HALF, HUB_HALF, -HUB_HALF, HUB_HALF, -hubD / 2, hubD / 2);
  // 羽根 4 枚(dirs = +x, +y, −x, −y。帆は回転方向(+90°)側に張る)
  const sail0 = Math.max(0.6, len - SAIL_LEN);
  const t = SPAR_T / 2;
  const blades: [number, number][] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  for (const [dx, dy] of blades) {
    // 桁: dir に沿った 0.2〜len の角材
    const sx0 = Math.min(dx * 0.2, dx * len);
    const sx1 = Math.max(dx * 0.2, dx * len);
    const sy0 = Math.min(dy * 0.2, dy * len);
    const sy1 = Math.max(dy * 0.2, dy * len);
    localBox(
      buf,
      wood,
      dx === 0 ? -t : sx0,
      dx === 0 ? t : sx1,
      dy === 0 ? -t : sy0,
      dy === 0 ? t : sy1,
      -t,
      t,
    );
    // 帆板: 桁の先端側 sail0〜len、+90° 側へ幅 SAIL_W
    const px = -dy; // dir を +90° 回した側
    const py = dx;
    const a0 = sail0;
    const a1 = len;
    const b0 = 0.1;
    const b1 = 0.1 + SAIL_W;
    const xs = [dx * a0 + px * b0, dx * a1 + px * b0, dx * a0 + px * b1, dx * a1 + px * b1];
    const ys = [dy * a0 + py * b0, dy * a1 + py * b0, dy * a0 + py * b1, dy * a1 + py * b1];
    localBox(
      buf,
      sail,
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
      0.02,
      0.07,
    );
  }
  return buildSpinnerObject(
    part,
    buf,
    { kind: "rotor", phase: part.params?.phase ?? 0 },
    "facility-rotor",
  );
}

/**
 * water-wheel: 8 角形リム 2 枚+パドル 8+軸スタブ(全て materialId =
 * 濡れ木)。ローカル +x = 軸方向、回転面 = yz。
 */
function buildWheelObject(part: Part): THREE.Object3D {
  const buf: GeoBuffer = { positions: [], normals: [], colors: [], indices: [] };
  const base = materialColor(part.materialId);
  const width = Math.abs(part.transform.scale[0]);
  const radius = Math.abs(part.transform.scale[1]) / 2;
  const halfW = width / 2;

  // 軸スタブ
  localBox(buf, base, -halfW - 0.15, halfW + 0.15, -0.12, 0.12, -0.12, 0.12);
  // リム 2 枚(8 角形。セグメント中心角 45°、中点角 22.5° + 45°k)
  const rimR = radius - WHEEL_PADDLE_LEN / 2;
  const segLen = 2 * rimR * Math.tan(Math.PI / 8) + 0.05;
  for (const xSide of [-1, 1] as const) {
    const cx = xSide * (halfW - WHEEL_RIM_AXIAL / 2);
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) * (Math.PI / 4);
      const ry = Math.cos(a);
      const rz = Math.sin(a);
      orientedBox(
        buf,
        base,
        [cx, rimR * ry, rimR * rz],
        [0, -rz, ry], // 接線方向
        segLen / 2,
        [0, ry, rz], // 半径方向
        WHEEL_RIM_RADIAL / 2,
        [1, 0, 0], // 軸方向
        WHEEL_RIM_AXIAL / 2,
      );
    }
  }
  // パドル 8(軸方向いっぱいの板。半径方向 0.55)
  const padR = radius - WHEEL_PADDLE_LEN / 2;
  for (let k = 0; k < 8; k++) {
    const a = k * (Math.PI / 4);
    const ry = Math.cos(a);
    const rz = Math.sin(a);
    orientedBox(
      buf,
      base,
      [0, padR * ry, padR * rz],
      [1, 0, 0],
      halfW,
      [0, ry, rz],
      WHEEL_PADDLE_LEN / 2,
      [0, -rz, ry],
      WHEEL_PADDLE_T / 2,
    );
  }
  return buildSpinnerObject(
    part,
    buf,
    { kind: "wheel", phase: part.params?.phase ?? 0 },
    "facility-wheel",
  );
}

/**
 * WorldModel の facilities を三角形化する。躯体束と屋根束の最大 2 つの
 * マージメッシュを返す(facilities が空なら空配列)。
 */
export function buildFacilities(model: WorldModel): THREE.Object3D[] {
  if (model.facilities.length === 0) return [];
  const out: THREE.Object3D[] = [];
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
      if (part.type === "pile") {
        // 桟橋の杭・係船柱。建物側の pile はインスタンス経路だが、
        // 施設では柵の beam と同じくマージへ寄せる(形状は同じ直方体。
        // 足元 = 水中 y −1.6 のため AO は beam と同じ控えめな値)
        boxPart(part, solid, base, BEAM_FOOT_AO);
        continue;
      }
      if (part.type === "canopy") {
        canopyPart(part, solid, base);
        continue;
      }
      if (part.type === "door" || part.type === "window") {
        openingPart(part, solid, base, part.type);
        continue;
      }
      if (part.type === "windmill-rotor") {
        out.push(buildRotorObject(part));
        continue;
      }
      if (part.type === "water-wheel") {
        out.push(buildWheelObject(part));
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
