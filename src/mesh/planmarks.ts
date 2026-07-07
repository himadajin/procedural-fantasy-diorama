/**
 * 計画データの開発用デバッグ描画: 魔法灯・浮遊要素・BridgeSite の
 * マーカー(小さな柱・点)。
 *
 * これは仮実装ではなく「PHASE 5b が立体に置換するまでの開発用表示」という
 * 設計上の役割を持つ(implementation-spec PHASE 3「PHASE 5b で立体に
 * 置換する」、計画書 commit 11)。結界環ライン・魔導塔・結界門・聖域の
 * マーカーは PHASE 5b commit 17 が立体(mesh/wardparts.ts)へ置換済みで、
 * 残りの魔法灯・浮遊要素・橋は commit 18 の担当
 * (contracts/worldmodel.md「結界構造の立体化」)。
 * 絵を壊さない控えめな造形とし、発光色は art-direction 5.4節の
 * 結界青緑系を小面積でのみ使う。draw call は InstancedMesh 1 に抑える。
 */
import * as THREE from "three";
import type { WorldModel } from "../model/worldmodel";

/** 結界青緑(art-direction 5.4節): コア / 縁・弱い光 */
const WARD_CORE = new THREE.Color("#5fd4c0");
const WARD_EDGE = new THREE.Color("#8fe6d8");
/** BridgeSite マーカー: 石と同族(5.1節)。魔法ではないので青緑を使わない */
const BRIDGE_MARK = new THREE.Color("#a8a49b");

interface Marker {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotY: number;
  color: THREE.Color;
}

/** 計画マーカー(魔法灯・浮遊要素・BridgeSite)を集める */
function collectMarkers(model: WorldModel): Marker[] {
  const marks: Marker[] = [];
  const w = model.wards;
  for (const l of w.lamps) {
    marks.push({
      x: l.position.x,
      y: 0,
      z: l.position.z,
      sx: 0.28,
      sy: 2.2,
      sz: 0.28,
      rotY: 0,
      color: WARD_CORE,
    });
  }
  for (const f of w.floaters) {
    marks.push({
      x: f.basePosition.x,
      y: f.basePosition.y - f.size / 2,
      z: f.basePosition.z,
      sx: f.size,
      sy: f.size,
      sz: f.size,
      rotY: 0,
      color: WARD_EDGE,
    });
  }
  for (const b of model.water.bridges) {
    // 水面(-0.6)からわずかに顔を出す低い標(石と同族色)
    marks.push({
      x: b.position.x,
      y: -0.55,
      z: b.position.z,
      sx: 1.1,
      sy: 0.85,
      sz: 1.1,
      rotY: -b.angle,
      color: BRIDGE_MARK,
    });
  }
  return marks;
}

/**
 * 計画デバッグ描画のグループを構築する(魔法灯・浮遊要素・BridgeSite。
 * commit 18 で立体に置換)。表示物が無ければ null。
 * マーカーは1つの InstancedMesh(unlit)に集約する。
 */
export function buildPlanMarks(model: WorldModel): THREE.Group | null {
  const group = new THREE.Group();
  group.name = "plan-marks";

  const marks = collectMarkers(model);
  if (marks.length > 0) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0); // 原点=足元
    // unlit の MeshBasicMaterial: 計画表示であることが読み分けられ、
    // 霧には沈む(青緑は小さな柱・点の面積に留まる)
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, marks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < marks.length; i++) {
      const mk = marks[i];
      if (!mk) continue;
      q.setFromAxisAngle(up, mk.rotY);
      m.compose(
        new THREE.Vector3(mk.x, mk.y, mk.z),
        q,
        new THREE.Vector3(mk.sx, mk.sy, mk.sz),
      );
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, mk.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = "plan-markers";
    group.add(mesh);
  }

  return group.children.length > 0 ? group : null;
}
