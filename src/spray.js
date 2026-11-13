import * as THREE from 'three';
import { waveHeight, SURFACE_LAYER } from './water.js';

const MAX = 700;
const GRAVITY = 12;

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  uniform float uPxPerUnit;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPxPerUnit / -mv.z;
    vAlpha = aAlpha;
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.15, d);
    gl_FragColor = vec4(vec3(0.93, 0.97, 1.0), vAlpha * soft);
    #include <colorspace_fragment>
  }
`;

/** Water droplets: bow spray, rooster tail, and splash bursts. */
export class Spray {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.alpha = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.age = new Float32Array(MAX).fill(1e9);
    this.baseSize = new Float32Array(MAX);
    this.next = 0;
    this.carry = { bow: 0, tail: 0 };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uPxPerUnit: { value: 800 } };
    this.points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false })
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.layers.set(SURFACE_LAYER);
    scene.add(this.points);
  }

  /** Keep droplet size in world units: call on resize with the drawing-buffer height. */
  setViewport(bufferHeight, camera) {
    this.uniforms.uPxPerUnit.value = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  emit(x, y, z, vx, vy, vz, size, life) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.baseSize[i] = size;
    this.life[i] = life;
    this.age[i] = 0;
  }

  /** A ring of droplets thrown outward, e.g. when the hull slaps down. */
  burst(x, y, z, strength, bvx = 0, bvz = 0) {
    const n = Math.min(120, Math.floor(strength * 14));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const out = 1.5 + Math.random() * strength * 0.7;
      this.emit(
        x + Math.cos(a) * 1.2, y, z + Math.sin(a) * 1.2,
        Math.cos(a) * out + bvx * 0.4, 2 + Math.random() * strength * 0.9, Math.sin(a) * out + bvz * 0.4,
        0.6 + Math.random() * 0.7, 0.6 + Math.random() * 0.5
      );
    }
  }

  update(dt, t, boat) {
    this.#emitFromBoat(dt, boat);

    for (let i = 0; i < MAX; i++) {
      if (this.age[i] >= this.life[i]) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const j = i * 3;
      this.vel[j + 1] -= GRAVITY * dt;
      const drag = Math.exp(-1.2 * dt);
      this.vel[j] *= drag; this.vel[j + 2] *= drag;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      // Droplets vanish when they fall back into the sea.
      if (this.vel[j + 1] < 0 && this.pos[j + 1] < waveHeight(this.pos[j], this.pos[j + 2], t)) {
        this.age[i] = this.life[i];
        this.alpha[i] = 0;
        continue;
      }
      const k = this.age[i] / this.life[i];
      this.alpha[i] = (1 - k) * 0.85;
      this.size[i] = this.baseSize[i] * (1 + k * 1.5);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  #emitFromBoat(dt, boat) {
    if (boat.airborne) return;
    const speed = boat.speed;
    const f = boat.forward, r = boat.right;
    const p = boat.root.position;
    const bvx = boat.vel.x, bvz = boat.vel.y;

    // Bow spray: sheets thrown sideways off both sides, stronger on the outside of a turn.
    if (speed > 7) {
      this.carry.bow += (speed - 7) * 3.5 * dt;
      while (this.carry.bow >= 1) {
        this.carry.bow -= 1;
        for (const side of [-1, 1]) {
          // side +1 = right. Turning right (steer > 0) throws more off the left (outer) side.
          const outer = 1 + Math.max(0, -side * boat.steer) * 1.8;
          const ox = p.x + f.x * 1.3 + r.x * side * 1.0;
          const oz = p.z + f.y * 1.3 + r.y * side * 1.0;
          const out = (1.5 + Math.random() * 2.5) * outer * Math.min(speed / 25, 1.4);
          this.emit(
            ox, p.y + 0.1, oz,
            r.x * side * out + bvx * 0.55, (1.2 + Math.random() * 2.2) * Math.min(outer, 2), r.y * side * out + bvz * 0.55,
            0.45 + Math.random() * 0.45, 0.45 + Math.random() * 0.35
          );
        }
      }
    }

    // Rooster tail behind the engine when boosting.
    if (boat.boosting && speed > 12) {
      this.carry.tail += speed * 2.4 * dt;
      while (this.carry.tail >= 1) {
        this.carry.tail -= 1;
        const back = 3 + Math.random() * 4;
        this.emit(
          p.x - f.x * 2.6 + (Math.random() - 0.5) * 0.4, p.y + 0.2, p.z - f.y * 2.6 + (Math.random() - 0.5) * 0.4,
          bvx * 0.6 - f.x * back + (Math.random() - 0.5) * 1.5, 4 + Math.random() * 3.5, bvz * 0.6 - f.y * back + (Math.random() - 0.5) * 1.5,
          0.7 + Math.random() * 0.6, 0.7 + Math.random() * 0.4
        );
      }
    }
  }
}
