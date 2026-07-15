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
import { createPanel, type GalleryTarget, type TabKey } from "./ui/panel";
import { createIndicator } from "./ui/indicator";
import { createDebugOverlay } from "./ui/debug";
import {
  galleryTargetLabel,
  renderGallerySummary,
  renderSummary,
  type Complexity,
  type SummaryView,
} from "./ui/summary";
import { parseGalleryUrl, serializeGalleryUrl } from "./ui/gallery-url";
import { runPipeline } from "./pipeline/run";
import { buildGalleryWorld, GALLERY_TARGET_IDS } from "./pipeline/gallery";
import {
  buildWorld,
  disposeWorld,
  type WaterDetailUniform,
  type WaterTimeUniform,
} from "./mesh/build";
import type { VegBudget } from "./mesh/vegetation";
import {
  computeGalleryFraming,
  type GalleryFraming,
} from "./viewer/framing";
import { CAMERA_INITIAL_AZIMUTH } from "./viewer/constants";
import { updateSpinners } from "./viewer/spin";
import {
  DEFAULT_PARAMS,
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

  // 描画プリセット(contracts/pipeline.md
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

  // ギャラリー起動URL(implementation-spec 1.11節「ギャラリー」)。
  // `?gallery=<対象id>` が既知の対象idを指すときのみギャラリータブを開く。
  // 箱庭側のURL状態化はスコープ外(?gallery の有無によらず箱庭は
  // 従来どおり自動生成する。下記「初回ロード」参照)
  const galleryUrlState = parseGalleryUrl(
    window.location.search,
    GALLERY_TARGET_IDS,
    DEFAULT_SEED,
  );
  const initialTab: TabKey = galleryUrlState ? "gallery" : "world";

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

  // 開発用デバッグオーバーレイ: 既定非表示。?debug=1 のときのみ生成する
  // (ハッシュ・renderer.info はサマリーへ統合済み。
  // implementation-spec 1.10節)。`applyActiveTab`(下記)が参照するため
  // `createPanel` より前に定義する(TDZ 対策)
  const debug = debugEnabled ? createDebugOverlay(app) : null;
  debug?.setPreset(presetName);

  const galleryTargets: GalleryTarget[] = GALLERY_TARGET_IDS.map((id) => ({
    id,
    label: galleryTargetLabel(id),
  }));
  const defaultGalleryTargetId =
    galleryUrlState?.targetId ?? GALLERY_TARGET_IDS[0] ?? "";
  const defaultGallerySeed = galleryUrlState?.seed ?? DEFAULT_SEED;
  const defaultGalleryParams = galleryUrlState?.params ?? DEFAULT_PARAMS;

  // 箱庭(ワールド)とギャラリーの生成状態(現在の3Dグループ・モデル・
  // カメラ基準)を互いに独立に保持する(design.md「UI とサマリー」節
  // 「タブはビューの表示切り替えのみを行い、生成は行わない」)。
  // 同じ viewer・同じ camera・同じ orbit controls を共有しつつ、
  // 非アクティブ側のグループは
  // `visible = false` で温存する(タブ切替のたびに再生成しない)。
  // `createPanel` の onTabChange(初期タブ反映のため構築中に同期的に
  // 呼ばれる)より前に定義する必要がある(TDZ 対策)
  interface SceneState {
    group: THREE.Group | null;
    model: WorldModel | null;
    firstGeneration: boolean;
    stopFade: (() => void) | null;
    summaryView: SummaryView | null;
    /**
     * OrbitController.configure に渡す初期構図(カメラ基準寸法・注視点・
     * 方位)。ワールドは ground.size 基準・原点・既定方位、ギャラリーは
     * 対象寸法から導出(viewer/framing.ts)。
     * 生成直後・タブ切替時に毎回評価する(画面アスペクト比に追従)
     */
    framingFor: (model: WorldModel) => GalleryFraming;
  }
  const worldScene: SceneState = {
    group: null,
    model: null,
    firstGeneration: true,
    stopFade: null,
    summaryView: null,
    framingFor: (m) => ({
      size: m.ground.size,
      target: { x: 0, y: 0, z: 0 },
      azimuth: CAMERA_INITIAL_AZIMUTH,
    }),
  };
  const galleryScene: SceneState = {
    group: null,
    model: null,
    firstGeneration: true,
    stopFade: null,
    summaryView: null,
    framingFor: (m) =>
      computeGalleryFraming(m, viewer!.camera.fov, viewer!.camera.aspect),
  };
  let activeTab: TabKey = initialTab;

  /** scene の初期構図を orbit へ適用する(生成直後・タブ切替時) */
  function applyFraming(scene: SceneState, model: WorldModel): void {
    const framing = scene.framingFor(model);
    controls.configure(
      framing.size,
      WATER_SURFACE_Y,
      framing.target,
      framing.azimuth,
    );
  }

  /** タブ切替(表示のみ。生成状態には触れない。panel の onTabChange から呼ばれる) */
  function applyActiveTab(tab: TabKey): void {
    activeTab = tab;
    if (worldScene.group) worldScene.group.visible = tab === "world";
    if (galleryScene.group) galleryScene.group.visible = tab === "gallery";
    const scene = tab === "world" ? worldScene : galleryScene;
    if (scene.model) {
      viewer!.setWorldSize(scene.model.ground.size);
      applyFraming(scene, scene.model);
      controls.resetCamera(true);
      debug?.setHash(scene.model.summary.hash);
    }
  }

  const panel = createPanel(
    app,
    DEFAULT_SEED,
    (seed, params) => {
      void generateWorld(seed, params);
    },
    {
      targets: galleryTargets,
      defaultTargetId: defaultGalleryTargetId,
      defaultSeed: defaultGallerySeed,
      defaultParams: defaultGalleryParams,
      onGenerate: (targetId, seed, params) => {
        generateGallery(targetId, seed, params);
      },
    },
    initialTab,
    (tab) => applyActiveTab(tab),
  );

  // 複雑度(頂点数・インスタンス数・draw call・triangle)はレンダラー
  // 実測値であり WorldModel には持たない(表示時にサマリー・デバッグ表示へ
  // 埋める。contracts/vegetation-summary.md Summary 節の設計判断)
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

  /** プリセットの表示側適用(植生 count・水面簡略度)。両シーンに適用する */
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

  // プリセット切替(実測補正)一式: viewer(pixelRatio・影)+両シーンの生成物
  function setPreset(next: PresetName, label: string): void {
    presetName = next;
    viewer!.setRenderPreset(PRESETS[next]);
    applyPresetToWorld(worldScene.group);
    applyPresetToWorld(galleryScene.group);
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

  // 水面の揺らぎ・発光の明滅・浮遊の上下動・風車/水車の回転はビューワー側の
  // 時間で行う(WorldModel に時間を持ち込まない。contracts/pipeline.md、
  // contracts/facilities.md「表示演出」)。reduced-motion では静止させ
  // (回転部品は初期角のまま)、低プリセットでは更新間隔を間引く。
  // 非アクティブ側も含め両シーンを更新する(タブ切替時に位相が飛ばないため)
  let lastTimePush = -Infinity;
  viewer.onFrame((_dt, elapsed) => {
    if (reducedMotion) return;
    if (elapsed - lastTimePush < PRESETS[presetName].timeUpdateInterval) return;
    lastTimePush = elapsed;
    for (const scene of [worldScene, galleryScene]) {
      const uniform = scene.group?.userData.waterTime as
        | WaterTimeUniform
        | undefined;
      if (uniform) uniform.value = elapsed;
      const spinners = scene.group?.userData.spinners as
        | THREE.Object3D[]
        | undefined;
      if (spinners) updateSpinners(spinners, elapsed);
    }
  });

  let debugTimer = 0;
  viewer.onFrame((dt) => {
    debugTimer += dt;
    if (debugTimer < 0.5) return;
    debugTimer = 0;
    const info = viewer.renderer.info.render;
    debug?.setRenderInfo(info.calls, info.triangles);
    if (activeTab === "world") {
      worldScene.summaryView?.setComplexity(measureComplexity(worldScene.group));
    }
    // ギャラリーの簡易サマリーは複雑度行を持たない(design.md「ギャラリー」節)
  });

  /** 生成完了時のフェードイン(表示演出。WorldModel には影響しない) */
  function fadeIn(group: THREE.Group): () => void {
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
    const unsubscribe = viewer!.onFrame((dt) => {
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
    };
    return finish;
  }

  /**
   * 生成結果(WorldModel)をシーンへ差し替える。対象シーンが現在アクティブな
   * タブのものであればカメラ・霧・フェードなど表示側の適用まで行い、
   * 非アクティブ側(バックグラウンド生成)ならグループを温存するだけに留める
   * (design.md「UI とサマリー」節「タブを切り替えるたびに各側の最後の
   * 生成結果を表示し直す」)。
   */
  function swapScene(scene: SceneState, model: WorldModel, tab: TabKey): void {
    scene.stopFade?.();
    scene.stopFade = null;
    if (scene.group) disposeWorld(scene.group);
    const group = buildWorld(model);
    viewer!.worldGroup.add(group);
    group.visible = tab === activeTab;
    scene.group = group;
    scene.model = model;
    applyPresetToWorld(group);

    if (tab === activeTab) {
      viewer!.setWorldSize(model.ground.size);
      applyFraming(scene, model);
      controls.resetCamera(scene.firstGeneration);
      debug?.setHash(model.summary.hash);
      if (!reducedMotion) scene.stopFade = fadeIn(group);
      if (tab === "world" && scene.firstGeneration && !presetForced) {
        startFpsCorrection();
      }
    }
    scene.firstGeneration = false;
  }

  let currentAbort: AbortController | null = null;

  async function generateWorld(seed: string, params: Params): Promise<void> {
    // 再入: 実行中の生成を破棄して最後の要求だけを実行(contracts/pipeline.md)
    currentAbort?.abort();
    const abort = new AbortController();
    currentAbort = abort;
    try {
      const model = await runPipeline(seed, params, {
        signal: abort.signal,
        onProgress: (name) => indicator.show(name),
      });
      swapScene(worldScene, model, "world");
      worldScene.summaryView = renderSummary(
        panel.summaryElement,
        model,
        measureComplexity(worldScene.group),
      );
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

  /**
   * ギャラリーの生成(contracts/pipeline.md「ギャラリー生成エントリ」)。
   * `buildGalleryWorld` は乱数消費こそすれど同期・高速な純関数のため、
   * 箱庭側のような AbortController による再入制御は不要(呼び出しは
   * 呼び出し順に完了する)。生成のたびに URL を更新する
   * (implementation-spec 1.11節。`history.replaceState` で履歴を汚さない)
   */
  function generateGallery(targetId: string, seed: string, params: Params): void {
    let model: WorldModel;
    try {
      model = buildGalleryWorld(targetId, seed, params);
    } catch (e) {
      console.error("gallery generation failed:", e);
      return;
    }
    swapScene(galleryScene, model, "gallery");
    renderGallerySummary(panel.gallery.summaryElement, targetId, model);
    history.replaceState(null, "", serializeGalleryUrl(targetId, seed, params));
  }

  // 開発用: 連続再生成でメモリが単調増加しないことの検証手段
  // (?debug=1 のとき console から window.pfdSoak(n) を呼ぶ。
  // contracts/pipeline.md「描画プリセット・LOD・デバッグ表示」。箱庭のみ対象)
  if (debugEnabled) {
    (
      window as unknown as { pfdSoak?: (runs?: number) => Promise<void> }
    ).pfdSoak = async (runs = 10) => {
      for (let i = 0; i < runs; i++) {
        await generateWorld(panel.getSeed(), panel.getParams());
        const mem = viewer!.renderer.info.memory;
        const programs = viewer!.renderer.info.programs?.length ?? 0;
        console.log(
          `pfdSoak ${i + 1}/${runs}: geometries=${mem.geometries} textures=${mem.textures} programs=${programs}`,
        );
      }
    };
  }

  // 初回ロード: 箱庭は ?gallery の有無によらず常に自動生成する
  // (design.md「成立条件」: 初回起動時に設定画面を挟まずデフォルト箱庭が
  // 自動生成される、は無条件の不変条件のため)。?gallery が有効なら、
  // 加えてギャラリー側も即時生成し、ギャラリータブを開いた状態で起動する
  // (implementation-spec 1.11節)
  void generateWorld(panel.getSeed(), panel.getParams());
  if (galleryUrlState) {
    generateGallery(
      galleryUrlState.targetId,
      galleryUrlState.seed,
      galleryUrlState.params,
    );
  }
}
