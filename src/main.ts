import * as THREE from "three";
import { createViewer } from "./viewer/viewer";
import { OrbitController } from "./viewer/orbit";

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

  // 自前 orbit コントローラー。初期構図は art-direction 8節
  const controls = new OrbitController(viewer.camera, viewer.renderer.domElement);
  controls.configure(worldSize);
  viewer.onFrame((dt) => controls.update(dt));

  // Reset Camera: ビューポート左下の円形ゴーストボタン(パネル外)
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.ariaLabel = "Reset Camera";
  resetButton.title = "Reset Camera";
  resetButton.textContent = "⌂";
  resetButton.style.cssText = `
    position: absolute; left: 16px; bottom: 16px;
    width: 44px; height: 44px; border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(16, 20, 26, 0.55); color: #e8e4da;
    font-size: 20px; line-height: 1; cursor: pointer;
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  `;
  resetButton.addEventListener("click", () => controls.resetCamera());
  app.appendChild(resetButton);
}
