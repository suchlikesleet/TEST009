import * as THREE from 'three';
import { waveHeight } from './water.js';

const COUNT = 140;
const LIFE = 1.6;

// Foam puffs dropped behind the stern that spread and fade.
export class Wake {
  constructor(scene) {
    this.geo = new THREE.CircleGeometry(1, 10);
    this.geo.rotateX(-Math.PI / 2);
    this.items = [];
    for (let i = 0; i < COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
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
      const s = 0.3 + speed * 0.018;
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
      p.m.material.opacity = Math.pow(1 - k, 1.5) * 0.32;
    }
  }
}
