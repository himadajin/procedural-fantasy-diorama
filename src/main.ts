import * as THREE from "three";
import { createViewer } from "./viewer/viewer";
import {
  CAMERA_INITIAL_AZIMUTH,
  CAMERA_INITIAL_PITCH,
} from "./viewer/constants";

const app = document.getElementById("app");
if (!app) throw new Error("#app not found");

app.style.cssText = "position: fixed; inset: 0; overflow: hidden;";

const viewer = createViewer(app);
if (!viewer) {
  app.innerHTML = `<div style="
    display: grid; place-items: center; height: 100dvh; padding: 24px;
    background: #10141a; color: #e8e4da; text-align: center;
    font-family: system-ui, sans-serif;
  ">この環境では WebGL が利用できないため、箱庭を表示できません。</div>`;
} else {
  // 仮のワールド実寸(PHASE 2 で World Scale 駆動の導出値に置換)
  const worldSize = 400;
  viewer.setWorldSize(worldSize);

  // 無地の平坦な仮グラウンド(PHASE 2 で外縁形状と材質ゾーンを持つ地面に置換)
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(worldSize * 0.5, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#7a8a55", roughness: 1 }),
  );
  ground.receiveShadow = true;
  viewer.worldGroup.add(ground);

  // 初期構図(art-direction 8節)。orbit操作は commit 5(自前コントローラー)で追加
  const distance = worldSize * 0.75;
  const pitch = CAMERA_INITIAL_PITCH;
  const az = CAMERA_INITIAL_AZIMUTH;
  viewer.camera.position.set(
    Math.sin(az) * Math.cos(pitch) * distance,
    Math.sin(pitch) * distance,
    Math.cos(az) * Math.cos(pitch) * distance,
  );
  viewer.camera.lookAt(0, 0, 0);
}
