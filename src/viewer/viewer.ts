import * as THREE from "three";
import {
  CAMERA_FOV,
  EXPOSURE,
  FOG_COLOR,
  FOG_DENSITY_FACTOR,
  HEMI_GROUND_COLOR,
  HEMI_INTENSITY,
  HEMI_SKY_COLOR,
  SUN_COLOR,
  SUN_INTENSITY,
  sunDirection,
} from "./constants";
import { createSky } from "./sky";

export interface Viewer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** 生成物を入れるグループ。再生成時はこのサブツリーを差し替える */
  worldGroup: THREE.Group;
  /** ワールド実寸の変更に追従(霧密度、影カメラ、空の半径) */
  setWorldSize(size: number): void;
  worldSize(): number;
  /** 毎フレーム呼ばれるコールバックを登録し、解除関数を返す(dt: 秒, elapsed: 秒) */
  onFrame(cb: (dt: number, elapsed: number) => void): () => void;
  dispose(): void;
}

/**
 * ビューワー基盤。ライティング・霧・空・トーンマッピングは固定演出
 * (数値は art-direction 3〜4節。constants.ts に集約)。
 * WebGL が利用できない場合は null を返す。
 */
export function createViewer(container: HTMLElement): Viewer | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    if (!renderer.getContext()) throw new Error("no context");
  } catch {
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap は three r185 で非推奨(art-direction 3節)
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG_COLOR);

  // 霧: 密度は setWorldSize で更新
  const fog = new THREE.FogExp2(FOG_COLOR, 0);
  scene.fog = fog;

  // 太陽(平行光・1灯のみ)。低い仰角が長い影と稜線のリムを作る
  const sunDir = sunDirection();
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.5;
  scene.add(sun);
  scene.add(sun.target);

  // 寒色の環境光: 日陰を青く、照り返しをわずかに暖かく
  const hemi = new THREE.HemisphereLight(
    HEMI_SKY_COLOR,
    HEMI_GROUND_COLOR,
    HEMI_INTENSITY,
  );
  scene.add(hemi);

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    container.clientWidth / Math.max(container.clientHeight, 1),
    0.5,
    5000,
  );

  let sky = createSky(1);
  scene.add(sky);

  const worldGroup = new THREE.Group();
  worldGroup.name = "world";
  scene.add(worldGroup);

  let size = 0;
  const setWorldSize = (next: number) => {
    size = next;
    fog.density = FOG_DENSITY_FACTOR / next;

    // 影カメラをワールド境界にフィットさせる
    const cam = sun.shadow.camera;
    const half = next * 0.62;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = next * 3;
    cam.updateProjectionMatrix();
    sun.position.set(sunDir.x, sunDir.y, sunDir.z).multiplyScalar(next);
    sun.target.position.set(0, 0, 0);

    // 空はワールドより十分大きく、カメラのfarより手前
    scene.remove(sky);
    sky.geometry.dispose();
    (sky.material as THREE.Material).dispose();
    sky = createSky(next * 4);
    scene.add(sky);
  };

  const frameCallbacks: ((dt: number, elapsed: number) => void)[] = [];
  // Clock は three r185 で非推奨のため Timer を使用(dt/elapsed とも秒単位)
  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time: number) => {
    timer.update(time);
    const dt = timer.getDelta();
    const elapsed = timer.getElapsed();
    for (const cb of frameCallbacks) cb(dt, elapsed);
    renderer.render(scene, camera);
  });

  const onResize = () => {
    const w = container.clientWidth;
    const h = Math.max(container.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  return {
    scene,
    camera,
    renderer,
    worldGroup,
    setWorldSize,
    worldSize: () => size,
    onFrame: (cb) => {
      frameCallbacks.push(cb);
      return () => {
        const i = frameCallbacks.indexOf(cb);
        if (i >= 0) frameCallbacks.splice(i, 1);
      };
    },
    dispose: () => {
      window.removeEventListener("resize", onResize);
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
