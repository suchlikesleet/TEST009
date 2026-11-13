import * as THREE from 'three';
import { waveHeight } from './water.js';

// Small seeded RNG so the map is the same every time.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORLD = 420; // islands spread over [-WORLD, WORLD]

export class World {
  constructor(scene) {
    this.scene = scene;
    this.islands = [];
    this.rings = [];
    this.buoys = [];
    this.rand = mulberry32(1337);

    this.mats = {
      sand: new THREE.MeshStandardMaterial({ color: '#e9d39a', flatShading: true }),
      grass: new THREE.MeshStandardMaterial({ color: '#4caf50', flatShading: true }),
      rock: new THREE.MeshStandardMaterial({ color: '#8a8f94', flatShading: true }),
      trunk: new THREE.MeshStandardMaterial({ color: '#8b5a2b', flatShading: true }),
      leaf: new THREE.MeshStandardMaterial({ color: '#2e8b3e', flatShading: true }),
      gold: new THREE.MeshStandardMaterial({ color: '#ffc531', emissive: '#a86b00', emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.3 }),
      buoyRed: new THREE.MeshStandardMaterial({ color: '#e53935', flatShading: true }),
      buoyWhite: new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true }),
    };

    this.#makeIslands(45);
    this.#makeBuoys(80);
    this.#makeRings(30);
  }

  #freeSpot(minClear) {
    for (let i = 0; i < 200; i++) {
      const x = (this.rand() * 2 - 1) * WORLD;
      const z = (this.rand() * 2 - 1) * WORLD;
      if (Math.hypot(x, z) < 25) continue; // keep spawn clear
      if (this.islands.every((s) => Math.hypot(s.x - x, s.z - z) > s.r + minClear)) return [x, z];
    }
    return [(this.rand() * 2 - 1) * WORLD, (this.rand() * 2 - 1) * WORLD];
  }

  #makeIslands(n) {
    for (let i = 0; i < n; i++) {
      const r = 4 + this.rand() * 9;
      const [x, z] = this.#freeSpot(r + 10);
      const g = new THREE.Group();
      g.position.set(x, 0, z);

      const sand = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, 1.6, 9), this.mats.sand);
      sand.position.y = 0;
      sand.rotation.y = this.rand() * Math.PI;
      g.add(sand);

      const rocky = this.rand() < 0.3;
      const hill = new THREE.Mesh(
        new THREE.ConeGeometry(r * 0.75, r * (rocky ? 0.9 : 0.5), 7),
        rocky ? this.mats.rock : this.mats.grass
      );
      hill.position.y = 0.8 + r * (rocky ? 0.45 : 0.25);
      hill.rotation.y = this.rand() * Math.PI;
      g.add(hill);

      if (!rocky) {
        const trees = 1 + Math.floor(this.rand() * 4);
        for (let t = 0; t < trees; t++) {
          const a = this.rand() * Math.PI * 2;
          const d = r * (0.3 + this.rand() * 0.45);
          g.add(this.#palm(Math.cos(a) * d, Math.sin(a) * d, 0.8 + r * 0.12));
        }
      }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(g);
      this.islands.push({ x, z, r: r * 1.1 });
    }
  }

  #palm(x, z, y) {
    const p = new THREE.Group();
    const h = 2.5 + this.rand() * 1.5;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, h, 5), this.mats.trunk);
    trunk.position.y = h / 2;
    p.add(trunk);
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.2, 4), this.mats.leaf);
      leaf.position.y = h;
      leaf.rotation.set(Math.PI / 2.6, (i / 5) * Math.PI * 2, 0, 'YXZ');
      leaf.translateY(1);
      p.add(leaf);
    }
    p.position.set(x, y, z);
    p.rotation.z = (this.rand() - 0.5) * 0.3;
    return p;
  }

  #makeBuoys(n) {
    const body = new THREE.CylinderGeometry(0.45, 0.6, 1.2, 8);
    const cap = new THREE.ConeGeometry(0.45, 0.6, 8);
    for (let i = 0; i < n; i++) {
      const [x, z] = this.#freeSpot(4);
      const g = new THREE.Group();
      const b = new THREE.Mesh(body, i % 2 ? this.mats.buoyRed : this.mats.buoyWhite);
      const c = new THREE.Mesh(cap, i % 2 ? this.mats.buoyWhite : this.mats.buoyRed);
      c.position.y = 0.9;
      g.add(b, c);
      g.position.set(x, 0, z);
      this.scene.add(g);
      this.buoys.push({ mesh: g, x, z, phase: this.rand() * 10 });
    }
  }

  #makeRings(n) {
    const geo = new THREE.TorusGeometry(1.3, 0.28, 8, 20);
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(geo, this.mats.gold);
      mesh.castShadow = true;
      this.scene.add(mesh);
      const ring = { mesh, x: 0, z: 0 };
      this.#placeRing(ring, 0, 0);
      this.rings.push(ring);
    }
  }

  #placeRing(ring, avoidX, avoidZ) {
    let x, z;
    do { [x, z] = this.#freeSpot(5); } while (Math.hypot(x - avoidX, z - avoidZ) < 40);
    ring.x = x; ring.z = z;
  }

  /** Animate props and return how many rings the boat collected this frame. */
  update(t, boat) {
    for (const b of this.buoys) {
      b.mesh.position.y = waveHeight(b.x, b.z, t) - 0.2;
      b.mesh.rotation.z = Math.sin(t * 1.3 + b.phase) * 0.15;
      b.mesh.rotation.x = Math.cos(t * 1.1 + b.phase) * 0.15;
    }

    let collected = 0;
    for (const r of this.rings) {
      r.mesh.position.set(r.x, waveHeight(r.x, r.z, t) + 1.6 + Math.sin(t * 2 + r.x) * 0.25, r.z);
      r.mesh.rotation.y = t * 1.5 + r.z;
      if (Math.hypot(boat.pos.x - r.x, boat.pos.y - r.z) < 2.8) {
        collected++;
        this.#placeRing(r, boat.pos.x, boat.pos.y);
      }
    }

    for (const s of this.islands) boat.collide(s.x, s.z, s.r);
    for (const b of this.buoys) boat.collide(b.x, b.z, 0.6);

    // Soft world edge: push the boat back toward the middle.
    const lim = WORLD + 40;
    const d = Math.hypot(boat.pos.x, boat.pos.y);
    if (d > lim) boat.pos.multiplyScalar(lim / d);
    return collected;
  }

  nearestRing(x, z) {
    let best = null, bd = Infinity;
    for (const r of this.rings) {
      const d = Math.hypot(r.x - x, r.z - z);
      if (d < bd) { bd = d; best = r; }
    }
    return best ? { ring: best, dist: bd } : null;
  }
}
