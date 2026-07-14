/**
 * 風車のロータ・水車の水輪の回転(表示演出)。
 * 数値の正は art-direction 5.5節「表示演出(回転)の数値」:
 * ロータ = 1 回転 22 秒(正面から見て時計回り)、水輪 = 1 回転 11 秒
 * (facing 基準で固定)。いずれも等速。
 *
 * WorldModel・メッシュは静的データ(初期角 = params.phase 込みの姿勢)
 * のみを持ち、回転角は毎フレーム viewer が上書きする(contracts/
 * facilities.md「表示演出」節)。prefers-reduced-motion では main が
 * 更新を止めるため初期角で静止し、低プリセットの更新間引きは水面・
 * 発光の明滅と同じ時間更新の規約に従う。
 */
import type * as THREE from "three";
import type { SpinData } from "../mesh/facilities";

/** ロータの周期(秒)。正面(+z 側)から見て時計回り = 負の z 回転 */
const ROTOR_PERIOD_S = 22;
/** 水輪の周期(秒) */
const WHEEL_PERIOD_S = 11;

const ROTOR_SPEED = -(Math.PI * 2) / ROTOR_PERIOD_S;
const WHEEL_SPEED = (Math.PI * 2) / WHEEL_PERIOD_S;

/** シーンから回転部品(userData.spin 持ち)を収集する(生成時に 1 回) */
export function collectSpinners(root: THREE.Object3D): THREE.Object3D[] {
  const spinners: THREE.Object3D[] = [];
  root.traverse((obj) => {
    if (obj.userData.spin) spinners.push(obj);
  });
  return spinners;
}

/** 回転部品の姿勢を経過時間から決める(等速。初期角 = phase) */
export function updateSpinners(
  spinners: readonly THREE.Object3D[],
  elapsed: number,
): void {
  for (const obj of spinners) {
    const spin = obj.userData.spin as SpinData;
    if (spin.kind === "rotor") {
      obj.rotation.z = spin.phase + ROTOR_SPEED * elapsed;
    } else {
      obj.rotation.x = spin.phase + WHEEL_SPEED * elapsed;
    }
  }
}
