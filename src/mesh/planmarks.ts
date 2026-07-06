/**
 * 計画データの開発用デバッグ描画: 結界環(ringPath を wall/overwater/gap で
 * 色分けした細いライン)と、魔導塔・結界門・聖域・魔法灯・浮遊要素・
 * BridgeSite のマーカー(小さな柱・点)。
 *
 * これは仮実装ではなく「PHASE 5b が立体に置換するまでの開発用表示」という
 * 設計上の役割を持つ(implementation-spec PHASE 3「PHASE 5b で立体に
 * 置換する」、計画書 commit 11)。絵を壊さない控えめな造形とし、
 * 発光色は art-direction 5.4節の結界青緑系を小面積でのみ使う。
 * draw call は LineSegments 1 + InstancedMesh 1 に抑える(1.8節)。
 */
import * as THREE from "three";
import type { WorldModel } from "../model/worldmodel";

/** 結界青緑(art-direction 5.4節): コア / 縁・弱い光 */
const WARD_CORE = new THREE.Color("#5fd4c0");
const WARD_EDGE = new THREE.Color("#8fe6d8");
/** 水晶の非発光部(5.4節)。聖域マーカーに使う */
const CRYSTAL_BODY = new THREE.Color("#4a6a78");
/** 開口(gap)区間は霧と同族の青灰で沈める(発光させない) */
const GAP_COLOR = new THREE.Color("#4a545e");
/** BridgeSite マーカー: 石と同族(5.1節)。魔法ではないので青緑を使わない */
const BRIDGE_MARK = new THREE.Color("#a8a49b");

/** ラインの高さ(地面のわずかに上) */
const RING_Y = 0.35;

/** 結界環のライン(wardLevel 0 では null) */
function buildRingLine(model: WorldModel): THREE.LineSegments | null {
  const { ringPath, ringSegments } = model.wards;
  if (ringPath.length < 2 || ringSegments.length === 0) return null;
  const n = ringPath.length;
  const positions: number[] = [];
  const colors: number[] = [];
  for (const seg of ringSegments) {
    const color =
      seg.kind === "wall"
        ? WARD_CORE
        : seg.kind === "overwater"
          ? WARD_EDGE
          : GAP_COLOR;
    for (let k = seg.start; k < seg.end; k++) {
      const a = ringPath[k % n];
      const b = ringPath[(k + 1) % n];
      if (!a || !b) continue;
      positions.push(a.x, RING_Y, a.z, b.x, RING_Y, b.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(new Float32Array(colors), 3),
  );
  const line = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ vertexColors: true }),
  );
  line.name = "plan-ring";
  return line;
}

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

/** 計画マーカー(塔・門・聖域・魔法灯・浮遊要素・BridgeSite)を集める */
function collectMarkers(model: WorldModel): Marker[] {
  const marks: Marker[] = [];
  const w = model.wards;
  for (const t of w.towers) {
    marks.push({
      x: t.position.x,
      y: 0,
      z: t.position.z,
      sx: 1.5,
      sy: t.height,
      sz: 1.5,
      rotY: 0,
      color: WARD_CORE,
    });
  }
  for (const g of w.gates) {
    // 門は道をまたぐ横木として、道路方向と直交に置く
    marks.push({
      x: g.position.x,
      y: 0,
      z: g.position.z,
      sx: 3.4,
      sy: 4.2,
      sz: 0.6,
      rotY: -(g.angle + Math.PI / 2),
      color: WARD_EDGE,
    });
  }
  for (const s of w.shrines) {
    marks.push({
      x: s.position.x,
      y: 0,
      z: s.position.z,
      sx: 1.5,
      sy: 1.7,
      sz: 1.5,
      rotY: 0,
      color: CRYSTAL_BODY,
    });
  }
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
 * 計画デバッグ描画のグループを構築する。表示物が無ければ null。
 * マーカーは1つの InstancedMesh(unlit)に集約する。
 */
export function buildPlanMarks(model: WorldModel): THREE.Group | null {
  const group = new THREE.Group();
  group.name = "plan-marks";

  const ring = buildRingLine(model);
  if (ring) group.add(ring);

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
