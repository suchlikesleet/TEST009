import * as THREE from 'three';

// Wave layers: [dirX, dirZ, frequency, speed, amplitude].
// Shared between the GPU shader and the CPU so the boat floats on the same surface you see.
const WAVES = [
  [1.0, 0.2, 0.16, 1.1, 0.32],
  [-0.3, 1.0, 0.22, 0.9, 0.22],
  [0.7, 0.7, 0.41, 1.9, 0.09],
  [-0.8, 0.5, 0.63, 2.6, 0.05],
];

export function waveHeight(x, z, t) {
  let h = 0;
  for (const [dx, dz, f, s, a] of WAVES) {
    h += Math.sin((x * dx + z * dz) * f + t * s) * a;
  }
  return h;
}

const glslWaves = WAVES.map(
  ([dx, dz, f, s, a]) =>
    `h += sin(dot(p, vec2(${dx.toFixed(3)}, ${dz.toFixed(3)})) * ${f.toFixed(3)} + t * ${s.toFixed(3)}) * ${a.toFixed(3)};`
).join('\n    ');

const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;

  float waveH(vec2 p, float t) {
    float h = 0.0;
    ${glslWaves}
    return h;
  }

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float h = waveH(wp.xz, uTime);
    float e = 0.3;
    float hx = waveH(wp.xz + vec2(e, 0.0), uTime);
    float hz = waveH(wp.xz + vec2(0.0, e), uTime);
    vNormal = normalize(vec3(h - hx, e, h - hz));
    wp.y += h;
    vHeight = h;
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vHeight;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(uCamPos - vWorld);
    float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
    float crest = smoothstep(0.25, 0.6, vHeight);
    vec3 col = mix(uDeep, uShallow, clamp(vHeight * 0.9 + 0.5, 0.0, 1.0));
    col *= 0.75 + 0.35 * diff;
    vec3 h = normalize(uSunDir + v);
    float spec = pow(max(dot(n, h), 0.0), 80.0);
    col += vec3(1.0) * spec * 0.6;
    col = mix(col, vec3(0.85, 0.95, 1.0), crest * 0.35);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Water {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(260, 260, 160, 160);
    geo.rotateX(-Math.PI / 2);
    this.uniforms = {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color('#0a5a7a') },
      uShallow: { value: new THREE.Color('#2fa3c4') },
      uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3).normalize() },
      uCamPos: { value: new THREE.Vector3() },
    };
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader })
    );
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.step = 260 / 160;
  }

  update(t, center, camera) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCamPos.value.copy(camera.position);
    // Follow the boat, snapped to the grid spacing so the waves don't "swim".
    this.mesh.position.x = Math.round(center.x / this.step) * this.step;
    this.mesh.position.z = Math.round(center.z / this.step) * this.step;
  }
}
