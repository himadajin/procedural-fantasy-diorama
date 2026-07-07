import "./ui/styles.css";
import * as THREE from "three";
import { createViewer } from "./viewer/viewer";
import { OrbitController } from "./viewer/orbit";
import { createPanel } from "./ui/panel";
import { createIndicator } from "./ui/indicator";
import { createDebugOverlay } from "./ui/debug";
import { renderSummary, type Complexity, type SummaryView } from "./ui/summary";
import { runPipeline } from "./pipeline/run";
import { buildWorld, disposeWorld, type WaterTimeUniform } from "./mesh/build";
import {
  WATER_SURFACE_Y,
  type Params,
  type WorldModel,
} from "./model/worldmodel";

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
  controls.configure(400, WATER_SURFACE_Y);
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

  // 開発用デバッグ表示: ハッシュと renderer.info(implementation-spec 1.10節)
  const debug = createDebugOverlay(app);

  // 複雑度(頂点数・インスタンス数・draw call)はレンダラー実測値であり
  // WorldModel には持たない(表示時にサマリー・デバッグ表示へ埋める。
  // contracts/worldmodel.md Summary 節の設計判断)
  function measureComplexity(group: THREE.Group | null): Complexity {
    const info = viewer!.renderer.info.render;
    let vertices = 0;
    let instances = 0;
    group?.traverse((obj) => {
      const geom = (obj as THREE.Mesh).geometry as
        | THREE.BufferGeometry
        | undefined;
      if (geom?.attributes.position) vertices += geom.attributes.position.count;
      if (obj instanceof THREE.InstancedMesh) instances += obj.count;
    });
    return { vertices, instances, drawCalls: info.calls };
  }

  let currentSummary: SummaryView | null = null;
  let debugTimer = 0;
  viewer.onFrame((dt) => {
    debugTimer += dt;
    if (debugTimer < 0.5) return;
    debugTimer = 0;
    const info = viewer.renderer.info.render;
    debug.setRenderInfo(info.calls, info.triangles);
    currentSummary?.setComplexity(measureComplexity(currentWorld));
  });

  let currentWorld: THREE.Group | null = null;
  let currentAbort: AbortController | null = null;
  let stopFade: (() => void) | null = null;
  let firstGeneration = true;

  // 水面の揺らぎはビューワー側の時間 uniform で行う(WorldModel に時間を
  // 持ち込まない。contracts/pipeline.md)。reduced-motion では静止させる
  viewer.onFrame((_dt, elapsed) => {
    if (reducedMotion) return;
    const uniform = currentWorld?.userData.waterTime as
      | WaterTimeUniform
      | undefined;
    if (uniform) uniform.value = elapsed;
  });

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

    debug.setHash(model.summary.hash);
    // 生成結果サマリーを描画(複雑度はレンダラー実測を随時埋める)
    currentSummary = renderSummary(
      panel.summaryElement,
      model,
      measureComplexity(group),
    );
    viewer.setWorldSize(model.ground.size);
    // パン範囲をワールド境界に、極角制限の基準を水面高さに接続する
    controls.configure(model.ground.size, WATER_SURFACE_Y);
    controls.resetCamera(firstGeneration);
    if (!reducedMotion) fadeIn(group);
    firstGeneration = false;
  }

  /** 生成完了時のフェードイン(表示演出。WorldModel には影響しない) */
  function fadeIn(group: THREE.Group): void {
    if (!viewer) return;
    const materials: THREE.Material[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
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
