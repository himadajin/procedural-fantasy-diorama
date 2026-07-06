import * as THREE from "three";
import {
  SKY_HORIZON_AWAY,
  SKY_HORIZON_SUN,
  SKY_MID,
  SKY_ZENITH,
  SUN_AZIMUTH,
} from "./constants";

/**
 * 内向き球にシェーダーでグラデーションを描く空(art-direction 4節)。
 * 画像テクスチャは使わない。太陽側の地平だけが暖かい。
 * シーンと同じトーンマッピング・色空間変換を通し、霧色との連続性を保つ。
 */
export function createSky(radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 32, 24);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(SKY_ZENITH) },
      mid: { value: new THREE.Color(SKY_MID) },
      horizonSun: { value: new THREE.Color(SKY_HORIZON_SUN) },
      horizonAway: { value: new THREE.Color(SKY_HORIZON_AWAY) },
      sunAzimuthDir: {
        value: new THREE.Vector2(Math.sin(SUN_AZIMUTH), Math.cos(SUN_AZIMUTH)),
      },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith;
      uniform vec3 mid;
      uniform vec3 horizonSun;
      uniform vec3 horizonAway;
      uniform vec2 sunAzimuthDir;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y, 0.0, 1.0);
        float sunward = dot(normalize(dir.xz + vec2(1e-6)), sunAzimuthDir) * 0.5 + 0.5;
        vec3 horizon = mix(horizonAway, horizonSun, pow(sunward, 2.4));
        vec3 upper = mix(mid, zenith, smoothstep(0.30, 0.95, h));
        vec3 col = mix(horizon, upper, smoothstep(0.0, 0.32, h));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sky";
  mesh.frustumCulled = false;
  return mesh;
}
