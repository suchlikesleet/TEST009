import * as THREE from 'three';
import { waveHeight } from './water.js';

const COUNT = 140;

// Foam patch that breaks up into lace as it ages (world-space noise, so neighbouring
// patches join into one continuous lacy trail).
const lacyFoam = new THREE.ShaderMaterial({
  uniforms: { uAge: { value: 1 }, uSeed: { value: 0 } },
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec2 vWorld;
    void main() {
      vUv = uv;
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`,
  fragmentShader: /* glsl */ `
    uniform float uAge;
    uniform float uSeed;
    varying vec2 vUv;
    varying vec2 vWorld;
    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
    }
    void main() {
      float r = length(vUv - 0.5) * 2.0;
      float n = noise(vWorld * 1.7 + uSeed * 0.0) * 0.65 + noise(vWorld * 4.3) * 0.35;
      float v = n * (1.25 - r * r) - (0.2 + uAge * 0.6);
      float w = max(fwidth(v), 1e-4);
      float a = smoothstep(-w, w, v);
      if (a < 0.01) discard;
      gl_FragColor = vec4(vec3(0.95, 0.98, 1.0), a * 0.95);
      #include <colorspace_fragment>
    }`,
});
const LIFE = 2.2;

// Foam puffs dropped behind the stern that spread and fade.
export class Wake {
  constructor(scene) {
    this.geo = new THREE.CircleGeometry(1, 10);
    this.geo.rotateX(-Math.PI / 2);
    this.items = [];
    for (let i = 0; i < COUNT; i++) {
      const mat = lacyFoam.clone();
      mat.uniforms = { uAge: { value: 1 }, uSeed: { value: Math.random() * 100 } };
      const m = new THREE.Mesh(this.geo, mat);
      m.visible = false;
      m.renderOrder = 1;
      scene.add(m);
      this.items.push({ m, age: LIFE, x: 0, z: 0, vx: 0, vz: 0, size: 1 });
    }
    this.next = 0;
    this.timer = 0;
  }

  #spawn(x, z, vx, vz, size) {
    const p = this.items[this.next];
    this.next = (this.next + 1) % COUNT;
    Object.assign(p, { age: 0, x, z, vx, vz, size });
    p.m.visible = true;
  }

  update(dt, t, boat) {
    const speed = boat.speed;
    this.timer += dt;
    const interval = speed > 1 ? THREE.MathUtils.clamp(0.9 / speed, 0.025, 0.12) : Infinity;
    if (this.timer > interval && !boat.airborne) {
      this.timer = 0;
      const f = boat.forward, r = boat.right;
      const sx = boat.pos.x - f.x * 2.4, sz = boat.pos.y - f.y * 2.4;
      const spread = speed * 0.12;
      const s = 0.45 + speed * 0.028;
      // Two puffs pushed outward to form the V-shaped wake, one in the middle.
      this.#spawn(sx + r.x * 0.6, sz + r.y * 0.6, r.x * spread, r.y * spread, s);
      this.#spawn(sx - r.x * 0.6, sz - r.y * 0.6, -r.x * spread, -r.y * spread, s);
      this.#spawn(sx, sz, 0, 0, s * 1.2);
    }

    for (const p of this.items) {
      if (p.age >= LIFE) continue;
      p.age += dt;
      if (p.age >= LIFE) { p.m.visible = false; continue; }
      const k = p.age / LIFE;
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.vx *= 0.97; p.vz *= 0.97;
      const sc = p.size * (1 + k * 2.2);
      p.m.scale.setScalar(sc);
      p.m.position.set(p.x, waveHeight(p.x, p.z, t) + 0.08, p.z);
      // Lacy foam: starts nearly solid, then dissolves into lace as it spreads.
      p.m.material.uniforms.uAge.value = k;
      p.m.scale.setScalar(sc);
    }
  }
}
