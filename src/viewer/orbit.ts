import * as THREE from "three";
import { CAMERA_INITIAL_AZIMUTH, CAMERA_INITIAL_PITCH } from "./constants";

/**
 * 自前 orbit カメラコントローラー(implementation-spec PHASE 1)。
 * - タッチ: 1本指スワイプ=回転、ピンチ=ズーム、2本指ドラッグ=パン
 * - マウス: ドラッグ=回転、ホイール=ズーム、右ドラッグ/Shift+ドラッグ=パン
 * - 慣性(軽い減衰)、極角制限(地面下に潜らない)、ズーム距離制限、
 *   パン範囲制限(箱庭を見失わない)、Reset Camera
 * prefers-reduced-motion では慣性とリセットのトゥイーンを無効化する。
 */

const ROTATE_SPEED = 2.2; // 画面高さぶんのドラッグ ≒ ROTATE_SPEED*π ラジアン
const DAMPING = 6; // 慣性の減衰率 [1/s]
const MIN_PITCH = 0.08; // 水面(地面より低い)に潜らない極角下限
const MAX_PITCH = 1.45;
const RESET_DURATION = 0.45; // [s]

interface Pose {
  azimuth: number;
  pitch: number;
  distance: number;
  target: THREE.Vector3;
}

export class OrbitController {
  private pose: Pose = {
    azimuth: CAMERA_INITIAL_AZIMUTH,
    pitch: CAMERA_INITIAL_PITCH,
    distance: 300,
    target: new THREE.Vector3(0, 0, 0),
  };
  private home: Pose = {
    azimuth: CAMERA_INITIAL_AZIMUTH,
    pitch: CAMERA_INITIAL_PITCH,
    distance: 300,
    target: new THREE.Vector3(0, 0, 0),
  };
  private minDistance = 20;
  private maxDistance = 700;
  private panBound = 220;

  private velAzimuth = 0;
  private velPitch = 0;
  private velPan = new THREE.Vector2(0, 0); // 地面平面上(right, forward)

  private pointers = new Map<number, { x: number; y: number }>();
  private panning = false;
  private lastMoveTime = 0;
  private reset: { from: Pose; t: number } | null = null;
  private readonly reducedMotion: boolean;
  private readonly abort = new AbortController();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {
    this.reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dom.style.touchAction = "none";
    const opts = { signal: this.abort.signal } as AddEventListenerOptions;
    dom.addEventListener("pointerdown", this.onPointerDown, opts);
    dom.addEventListener("pointermove", this.onPointerMove, opts);
    dom.addEventListener("pointerup", this.onPointerEnd, opts);
    dom.addEventListener("pointercancel", this.onPointerEnd, opts);
    dom.addEventListener("wheel", this.onWheel, {
      ...opts,
      passive: false,
    });
    dom.addEventListener("contextmenu", (e) => e.preventDefault(), opts);
    this.applyToCamera();
  }

  /**
   * ワールド実寸に応じて距離・パンの制限と初期構図(home)を設定する。
   * 視点は動かさない。構図へ戻すには resetCamera を呼ぶ。
   */
  configure(worldSize: number): void {
    this.minDistance = worldSize * 0.06;
    this.maxDistance = worldSize * 1.5;
    this.panBound = worldSize * 0.55;
    this.home = {
      azimuth: CAMERA_INITIAL_AZIMUTH,
      pitch: CAMERA_INITIAL_PITCH,
      distance: worldSize * 0.75,
      target: new THREE.Vector3(0, 0, 0),
    };
  }

  /** 初期構図(art-direction 8節)へ戻る */
  resetCamera(immediate = false): void {
    this.velAzimuth = 0;
    this.velPitch = 0;
    this.velPan.set(0, 0);
    if (immediate || this.reducedMotion) {
      this.pose = {
        ...this.home,
        target: this.home.target.clone(),
      };
      this.reset = null;
      this.applyToCamera();
    } else {
      this.reset = { from: this.clonePose(this.pose), t: 0 };
    }
  }

  update(dt: number): void {
    if (this.reset) {
      this.reset.t += dt / RESET_DURATION;
      const k = Math.min(this.reset.t, 1);
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      const f = this.reset.from;
      this.pose.azimuth = THREE.MathUtils.lerp(f.azimuth, this.home.azimuth, e);
      this.pose.pitch = THREE.MathUtils.lerp(f.pitch, this.home.pitch, e);
      this.pose.distance = THREE.MathUtils.lerp(
        f.distance,
        this.home.distance,
        e,
      );
      this.pose.target.lerpVectors(f.target, this.home.target, e);
      if (k >= 1) this.reset = null;
      this.applyToCamera();
      return;
    }

    // 慣性
    if (!this.reducedMotion && this.pointers.size === 0) {
      const decay = Math.exp(-DAMPING * dt);
      if (
        Math.abs(this.velAzimuth) > 1e-4 ||
        Math.abs(this.velPitch) > 1e-4 ||
        this.velPan.lengthSq() > 1e-6
      ) {
        this.rotateBy(this.velAzimuth * dt, this.velPitch * dt);
        this.panBy(this.velPan.x * dt, this.velPan.y * dt);
        this.velAzimuth *= decay;
        this.velPitch *= decay;
        this.velPan.multiplyScalar(decay);
      }
    }
    this.applyToCamera();
  }

  dispose(): void {
    this.abort.abort();
  }

  private clonePose(p: Pose): Pose {
    return { ...p, target: p.target.clone() };
  }

  private rotateBy(dAz: number, dPitch: number): void {
    this.pose.azimuth += dAz;
    this.pose.pitch = THREE.MathUtils.clamp(
      this.pose.pitch + dPitch,
      MIN_PITCH,
      MAX_PITCH,
    );
  }

  private zoomBy(factor: number): void {
    this.pose.distance = THREE.MathUtils.clamp(
      this.pose.distance * factor,
      this.minDistance,
      this.maxDistance,
    );
  }

  /** 地面平面上のパン(right, forward はワールド単位) */
  private panBy(right: number, forward: number): void {
    const sinA = Math.sin(this.pose.azimuth);
    const cosA = Math.cos(this.pose.azimuth);
    // カメラは azimuth 方向から target を見る。画面右 = (cosA, -sinA)
    this.pose.target.x += cosA * right - sinA * forward;
    this.pose.target.z += -sinA * right - cosA * forward;
    this.pose.target.x = THREE.MathUtils.clamp(
      this.pose.target.x,
      -this.panBound,
      this.panBound,
    );
    this.pose.target.z = THREE.MathUtils.clamp(
      this.pose.target.z,
      -this.panBound,
      this.panBound,
    );
  }

  /** 1pxのドラッグが動かすワールド距離(target 平面上) */
  private worldPerPixel(): number {
    const h = Math.max(this.dom.clientHeight, 1);
    return (
      (2 * this.pose.distance * Math.tan((this.camera.fov * Math.PI) / 360)) /
      h
    );
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.dom.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.reset = null;
    this.velAzimuth = 0;
    this.velPitch = 0;
    this.velPan.set(0, 0);
    this.panning =
      e.pointerType === "mouse" && (e.button === 2 || e.shiftKey);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const moved = { x: e.clientX, y: e.clientY };
    const now = e.timeStamp / 1000;
    const dt = Math.max(now - this.lastMoveTime, 1 / 240);
    this.lastMoveTime = now;

    if (this.pointers.size === 1) {
      const dx = moved.x - prev.x;
      const dy = moved.y - prev.y;
      const h = Math.max(this.dom.clientHeight, 1);
      if (this.panning) {
        const wpp = this.worldPerPixel();
        this.panBy(-dx * wpp, dy * wpp);
        this.velPan.set((-dx * wpp) / dt, (dy * wpp) / dt);
      } else {
        const dAz = (-dx / h) * Math.PI * ROTATE_SPEED;
        const dPitch = (dy / h) * Math.PI * ROTATE_SPEED;
        this.rotateBy(dAz, dPitch);
        this.velAzimuth = dAz / dt;
        this.velPitch = dPitch / dt;
      }
      this.pointers.set(e.pointerId, moved);
      return;
    }

    if (this.pointers.size === 2) {
      // other = 動いていない方の指
      let other: { x: number; y: number } | undefined;
      for (const [id, p] of this.pointers) {
        if (id !== e.pointerId) other = p;
      }
      if (!other) return;

      // ピンチ: 2点間距離の比でズーム
      const distBefore = Math.hypot(prev.x - other.x, prev.y - other.y);
      const distAfter = Math.hypot(moved.x - other.x, moved.y - other.y);
      if (distBefore > 1 && distAfter > 1) {
        this.zoomBy(distBefore / distAfter);
      }

      // 2本指ドラッグ: 重心移動でパン
      const wpp = this.worldPerPixel();
      this.panBy(
        (-(moved.x - prev.x) / 2) * wpp,
        ((moved.y - prev.y) / 2) * wpp,
      );

      this.pointers.set(e.pointerId, moved);
    }
  };

  private onPointerEnd = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.panning = false;
    if (this.reducedMotion) {
      this.velAzimuth = 0;
      this.velPitch = 0;
      this.velPan.set(0, 0);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.zoomBy(Math.exp(e.deltaY * 0.0012));
  };

  private applyToCamera(): void {
    const { azimuth, pitch, distance, target } = this.pose;
    this.camera.position.set(
      target.x + Math.sin(azimuth) * Math.cos(pitch) * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(azimuth) * Math.cos(pitch) * distance,
    );
    this.camera.lookAt(target);
  }
}
