/**
 * メッシュビルダー: WorldModel → Three.js シーングラフ。
 * WorldModel のみを入力とし、パイプラインの内部状態に依存しない
 * (contracts/pipeline.md)。
 */
import * as THREE from "three";
import type { WorldModel } from "../model/worldmodel";

export function buildWorld(model: WorldModel): THREE.Group {
  const group = new THREE.Group();
  group.name = "generated-world";

  // 無地の平坦な仮グラウンド(PHASE 2 で外縁形状と材質ゾーンを持つ地面に置換)
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(model.ground.size * 0.5, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#7a8a55", roughness: 1 }),
  );
  ground.name = "ground";
  ground.receiveShadow = true;
  group.add(ground);

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
