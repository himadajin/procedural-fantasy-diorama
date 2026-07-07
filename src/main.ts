import "./ui/styles.css";
import * as THREE from "three";
import { createViewer } from "./viewer/viewer";
import { OrbitController } from "./viewer/orbit";
import {
  FPS_PROBE_FRAMES,
  FPS_PROBE_WARMUP_FRAMES,
  PRESETS,
  choosePresetByDevice,
  correctPresetByFps,
  type PresetName,
} from "./viewer/preset";
import { createPanel } from "./ui/panel";
import { createIndicator } from "./ui/indicator";
import { createDebugOverlay } from "./ui/debug";
import { renderSummary, type Complexity, type SummaryView } from "./ui/summary";
import { runPipeline } from "./pipeline/run";
import {
  buildWorld,
  disposeWorld,
  type WaterDetailUniform,
  type WaterTimeUniform,
} from "./mesh/build";
import type { VegBudget } from "./mesh/vegetation";
import {
  WATER_SURFACE_Y,
  type Params,
  type WorldModel,
} from "./model/worldmodel";

import { DEFAULT_SEED } from "./defaults";

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

  // 描画プリセット(PHASE 7 commit 22。contracts/pipeline.md
  // 「描画プリセット・LOD・デバッグ表示」)。起動時にデバイス簡易判定で
  // 1回選び、初回生成後に実測補正を1回だけ行う。?preset=high|low で
  // 強制でき、その場合は判定・補正とも行わない(検証用)
  const query = new URLSearchParams(window.location.search);
  const forcedPreset = query.get("preset");
  const presetForced = forcedPreset === "high" || forcedPreset === "low";
  const debugEnabled = query.get("debug") === "1";
  let presetName: PresetName = presetForced
    ? forcedPreset
    : choosePresetByDevice(
        window.devicePixelRatio,
        window.innerWidth,
        window.innerHeight,
      );
  viewer.setRenderPreset(PRESETS[presetName]);

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

  // 開発用デバッグオーバーレイ: 既定非表示。?debug=1 のときのみ生成する
  // (PHASE 7 commit 22 でハッシュ・renderer.info はサマリーへ統合済み。
  // implementation-spec 1.10節)
  const debug = debugEnabled ? createDebugOverlay(app) : null;
  debug?.setPreset(presetName);

  // 複雑度(頂点数・インスタンス数・draw call・triangle)はレンダラー
  // 実測値であり WorldModel には持たない(表示時にサマリー・デバッグ表示へ
  // 埋める。contracts/worldmodel.md Summary 節の設計判断)
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
    return {
      vertices,
      instances,
      drawCalls: info.calls,
      triangles: info.triangles,
    };
  }

  let currentSummary: SummaryView | null = null;
  let debugTimer = 0;
  viewer.onFrame((dt) => {
    debugTimer += dt;
    if (debugTimer < 0.5) return;
    debugTimer = 0;
    const info = viewer.renderer.info.render;
    debug?.setRenderInfo(info.calls, info.triangles);
    currentSummary?.setComplexity(measureComplexity(currentWorld));
  });

  let currentWorld: THREE.Group | null = null;
  let currentAbort: AbortController | null = null;
  let stopFade: (() => void) | null = null;
  let firstGeneration = true;

  // プリセットの表示側適用(生成物へ): 植生の表示個体数上限
  // (InstancedMesh の count を vegBudget の prefix 表で絞る。決定論的)と
  // 水面シェーダーの簡略度 uniform。再生成なしでライブに切り替わる
  function applyPresetToWorld(group: THREE.Group | null): void {
    if (!group) return;
    const preset = PRESETS[presetName];
    const detail = group.userData.waterDetail as
      | WaterDetailUniform
      | undefined;
    if (detail) detail.value = preset.waterDetail;
    group.traverse((obj) => {
      if (!(obj instanceof THREE.InstancedMesh)) return;
      const budget = obj.userData.vegBudget as VegBudget | undefined;
      if (!budget) return;
      const keep = Math.min(budget.individuals, preset.vegetationMax);
      const count = budget.prefix[keep];
      if (count !== undefined) obj.count = count;
    });
  }

  // プリセット切替(実測補正)一式: viewer(pixelRatio・影)+生成物
  function setPreset(next: PresetName, label: string): void {
    presetName = next;
    viewer!.setRenderPreset(PRESETS[next]);
    applyPresetToWorld(currentWorld);
    debug?.setPreset(label);
  }

  // 初回生成後の実測補正(1回だけ。強制指定時は行わない)。
  // ウォームアップ後の平均 fps で起動時判定を修正する(contracts/pipeline.md)
  function startFpsCorrection(): void {
    let warmup = FPS_PROBE_WARMUP_FRAMES;
    let frames = 0;
    let time = 0;
    const stop = viewer!.onFrame((dt) => {
      if (warmup > 0) {
        warmup--;
        return;
      }
      frames++;
      time += dt;
      if (frames < FPS_PROBE_FRAMES) return;
      stop();
      const fps = frames / Math.max(time, 1e-6);
      const corrected = correctPresetByFps(presetName, fps);
      if (corrected !== presetName) {
        setPreset(corrected, `${corrected} (fps補正 ${fps.toFixed(0)})`);
      }
    });
  }

  // 水面の揺らぎ・発光の明滅・浮遊の上下動はビューワー側の時間 uniform で
  // 行う(WorldModel に時間を持ち込まない。contracts/pipeline.md)。
  // reduced-motion では静止させ、低プリセットでは更新間隔を間引く
  let lastTimePush = -Infinity;
  viewer.onFrame((_dt, elapsed) => {
    if (reducedMotion) return;
    const uniform = currentWorld?.userData.waterTime as
      | WaterTimeUniform
      | undefined;
    if (!uniform) return;
    if (elapsed - lastTimePush < PRESETS[presetName].timeUpdateInterval) return;
    lastTimePush = elapsed;
    uniform.value = elapsed;
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
    // プリセットの表示側適用(植生 count・水面簡略度)。WorldModel は不変
    applyPresetToWorld(group);

    debug?.setHash(model.summary.hash);
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
    if (firstGeneration && !presetForced) startFpsCorrection();
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

  // 開発用: 連続再生成でメモリが単調増加しないことの検証手段
  // (?debug=1 のとき console から window.pfdSoak(n) を呼ぶ。
  // contracts/pipeline.md「描画プリセット・LOD・デバッグ表示」)
  if (debugEnabled) {
    (
      window as unknown as { pfdSoak?: (runs?: number) => Promise<void> }
    ).pfdSoak = async (runs = 10) => {
      for (let i = 0; i < runs; i++) {
        await generate(panel.getSeed(), panel.getParams());
        const mem = viewer!.renderer.info.memory;
        const programs = viewer!.renderer.info.programs?.length ?? 0;
        console.log(
          `pfdSoak ${i + 1}/${runs}: geometries=${mem.geometries} textures=${mem.textures} programs=${programs}`,
        );
      }
    };
  }

  // 初回ロードで自動生成(設定画面ファーストにしない)
  void generate(panel.getSeed(), panel.getParams());
}
