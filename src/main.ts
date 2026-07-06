import "./ui/styles.css";
import * as THREE from "three";
import { createViewer } from "./viewer/viewer";
import { OrbitController } from "./viewer/orbit";
import { createPanel } from "./ui/panel";
import { createIndicator } from "./ui/indicator";
import { runPipeline } from "./pipeline/run";
import { buildWorld, disposeWorld } from "./mesh/build";
import type { Params, WorldModel } from "./model/worldmodel";

/** 見栄えの良い既定 seed は PHASE 7 の目視検証で選定し直す */
const DEFAULT_SEED = "everdusk-101";

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
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 初回起動は「世界が生まれる前」: 空と霧だけの状態で自動生成を開始し、
  // 完了時に箱庭がフェードインする(art-direction 9.6節)
  viewer.setWorldSize(400);

  const controls = new OrbitController(
    viewer.camera,
    viewer.renderer.domElement,
  );
  controls.configure(400);
  controls.resetCamera(true);
  viewer.onFrame((dt) => controls.update(dt));

  // Reset Camera: ビューポート左下の円形ゴーストボタン(パネル外)
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "pfd-reset-camera";
  resetButton.title = "Reset Camera";
  resetButton.setAttribute("aria-label", "Reset Camera");
  resetButton.textContent = "⌂";
  resetButton.addEventListener("click", () => controls.resetCamera());
  app.appendChild(resetButton);

  const indicator = createIndicator(app);
  const panel = createPanel(app, DEFAULT_SEED, (seed, params) => {
    void generate(seed, params);
  });

  let currentWorld: THREE.Group | null = null;
  let currentAbort: AbortController | null = null;
  let stopFade: (() => void) | null = null;
  let firstGeneration = true;

  async function generate(seed: string, params: Params): Promise<void> {
    // 再入: 実行中の生成を破棄して最後の要求だけを実行(contracts/pipeline.md)
    currentAbort?.abort();
    const abort = new AbortController();
    currentAbort = abort;
    try {
      const model = await runPipeline(seed, params, {
        signal: abort.signal,
        onProgress: (name) => indicator.show(name),
      });
      swapWorld(model);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("generation failed:", e);
      }
    } finally {
      if (currentAbort === abort) {
        indicator.hide();
        currentAbort = null;
      }
    }
  }

  function swapWorld(model: WorldModel): void {
    stopFade?.();
    if (currentWorld) disposeWorld(currentWorld);
    const group = buildWorld(model);
    if (!viewer) return;
    viewer.worldGroup.add(group);
    currentWorld = group;

    viewer.setWorldSize(model.ground.size);
    controls.configure(model.ground.size);
    controls.resetCamera(firstGeneration);
    if (!reducedMotion) fadeIn(group);
    firstGeneration = false;
  }

  /** 生成完了時のフェードイン(表示演出。WorldModel には影響しない) */
  function fadeIn(group: THREE.Group): void {
    if (!viewer) return;
    const materials: THREE.Material[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material)
          ? obj.material
          : [obj.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = 0;
          materials.push(m);
        }
      }
    });
    const duration = 0.9;
    let t = 0;
    const unsubscribe = viewer.onFrame((dt) => {
      t += dt / duration;
      const k = Math.min(t, 1);
      const eased = 1 - Math.pow(1 - k, 2);
      for (const m of materials) m.opacity = eased;
      if (k >= 1) finish();
    });
    const finish = () => {
      for (const m of materials) {
        m.opacity = 1;
        m.transparent = false;
      }
      unsubscribe();
      stopFade = null;
    };
    stopFade = finish;
  }

  // 初回ロードで自動生成(設定画面ファーストにしない)
  void generate(panel.getSeed(), panel.getParams());
}
