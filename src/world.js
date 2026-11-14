import * as THREE from 'three';
import { waveHeight, withCaustics } from './water.js';
import { toon, addOutline } from './style.js';

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
const SEABED_Y = -7;
const SHELF_TOP_Y = -0.8; // where the beach meets the underwater slope

const std = (color, extra = {}) => toon(color, extra);

// Flat facets (one normal per triangle) for a chiselled, low-poly rock look.
function faceted(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.islands = []; // solid, with collision
    this.reserved = []; // areas kept free (sandbar), no collision
    this.rings = [];
    this.buoys = [];
    this.schools = [];
    this.rand = mulberry32(1337);

    this.mats = {
      sand: withCaustics(std('#f6dfa4')),
      wetSand: withCaustics(std('#d4b983')),
      seabed: withCaustics(std('#d4b983'), 0.7),
      grass: std('#62d05a'),
      rock: withCaustics(std('#a08670')),
      reef: withCaustics(std('#6f7a73')),
      trunk: std('#8b5a2b'),
      leaf: std('#36b04f'),
      wood: withCaustics(std('#6b4a2e')),
      gold: toon('#ffcc33', { emissive: '#8a5a00', emissiveIntensity: 0.45 }),
      buoyRed: std('#e53935'),
      buoyWhite: std('#ffffff'),
      coral: ['#ff6f61', '#ff9f43', '#c56cf0', '#f368e0', '#ffd32a'].map((c) => withCaustics(std(c))),
      weed: withCaustics(std('#3d8b37')),
    };

    this.#makeSeabed();
    this.#makeSandbarWithWreck(0, -38);
    this.#makeIslands(45);
    this.#makeReefs(30);
    this.#makeBuoys(80);
    this.#makeRings(30);
  }

  #blocked(x, z, clear) {
    return [...this.islands, ...this.reserved].some((s) => Math.hypot(s.x - x, s.z - z) < s.r + clear);
  }

  #freeSpot(minClear) {
    for (let i = 0; i < 200; i++) {
      const x = (this.rand() * 2 - 1) * WORLD;
      const z = (this.rand() * 2 - 1) * WORLD;
      if (Math.hypot(x, z) < 25) continue; // keep spawn clear
      if (!this.#blocked(x, z, minClear)) return [x, z];
    }
    return [(this.rand() * 2 - 1) * WORLD, (this.rand() * 2 - 1) * WORLD];
  }

  #add(obj) {
    obj.traverse((o) => { if (o.isMesh && !o.userData.isOutline) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(obj);
    return obj;
  }

  // ---- Seabed: a sandy floor that follows the boat ----
  #makeSeabed() {
    const geo = new THREE.PlaneGeometry(320, 320, 40, 40);
    geo.rotateX(-Math.PI / 2);
    // Gentle dunes so it isn't perfectly flat.
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, (this.rand() - 0.5) * 0.8);
    geo.computeVertexNormals();
    this.seabed = new THREE.Mesh(geo, this.mats.seabed);
    this.seabed.position.y = SEABED_Y;
    this.seabed.receiveShadow = true;
    this.scene.add(this.seabed);
  }

  // ---- A shallow sandbar near the start with a sunken boat on it ----
  #makeSandbarWithWreck(x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(7, 17, -1.7 - SEABED_Y, 10), this.mats.wetSand);
    bar.position.y = (-1.7 + SEABED_Y) / 2;
    bar.scale.set(1, 1, 0.7);
    g.add(bar);

    const wreck = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 8), this.mats.wood);
    wreck.add(hull);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.6, 4), this.mats.wood);
    bow.rotation.set(Math.PI / 2, Math.PI / 4, 0);
    bow.scale.set(1, 1, 0.45);
    bow.position.z = 5.2;
    wreck.add(bow);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.18, 6, 5), this.mats.wood);
    mast.rotation.set(0.2, 0, Math.PI / 2.3);
    mast.position.set(2.2, 0.5, 0.5);
    wreck.add(mast);
    for (let i = 0; i < 3; i++) {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), this.mats.wood);
      crate.position.set(-3 + i * 0.9, -0.2, -3.5 + i * 1.3);
      crate.rotation.y = i;
      wreck.add(crate);
    }
    wreck.position.set(0, -1.9, 0);
    wreck.rotation.set(0.12, 0.6, 0.25);
    g.add(wreck);

    for (let i = 0; i < 6; i++) g.add(this.#weed((this.rand() - 0.5) * 10, -1.7, (this.rand() - 0.5) * 7));
    this.#add(g);
    this.reserved.push({ x, z, r: 17 });
    this.schools.push(this.#school(x + 3, z, -1.5, 5, 14));
  }

  // ---- Islands with an underwater shelf, coral and fish ----
  #makeIslands(n) {
    for (let i = 0; i < n; i++) {
      const r = 4 + this.rand() * 9;
      const shelfR = r * 2.6;
      const [x, z] = this.#freeSpot(shelfR + 6);
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      const spin = this.rand() * Math.PI;

      // Beach (above and just below the waterline).
      const beach = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 1.15, 1.6, 12), this.mats.sand);
      beach.rotation.y = spin;
      addOutline(beach, 0.16);
      g.add(beach);
      // Underwater slope down to the seabed — this is what makes the shallow turquoise ring.
      const shelf = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 1.15, shelfR, SHELF_TOP_Y - SEABED_Y, 12),
        this.mats.wetSand
      );
      shelf.position.y = (SHELF_TOP_Y + SEABED_Y) / 2;
      shelf.rotation.y = spin;
      g.add(shelf);

      const rocky = this.rand() < 0.3;
      const hill = new THREE.Mesh(
        faceted(new THREE.ConeGeometry(r * 0.75, r * (rocky ? 0.9 : 0.5), 7, rocky ? 2 : 1)),
        rocky ? this.mats.rock : this.mats.grass
      );
      hill.position.y = 0.8 + r * (rocky ? 0.45 : 0.25);
      hill.rotation.y = this.rand() * Math.PI;
      addOutline(hill, 0.12);
      g.add(hill);

      if (!rocky) {
        const trees = 1 + Math.floor(this.rand() * 4);
        for (let t = 0; t < trees; t++) {
          const a = this.rand() * Math.PI * 2;
          const d = r * (0.3 + this.rand() * 0.45);
          g.add(this.#palm(Math.cos(a) * d, Math.sin(a) * d, 0.8 + r * 0.12));
        }
      }

      // Coral, weed and boulders on the shelf.
      const shelfY = (d) => SHELF_TOP_Y - ((d - r * 1.15) / (shelfR - r * 1.15)) * (SHELF_TOP_Y - SEABED_Y);
      const decor = 6 + Math.floor(this.rand() * 8);
      for (let k = 0; k < decor; k++) {
        const a = this.rand() * Math.PI * 2;
        const d = r * 1.25 + this.rand() * (shelfR - r * 1.25) * 0.45;
        const cx = Math.cos(a) * d, cz = Math.sin(a) * d, cy = shelfY(d) * 0.95;
        const pick = this.rand();
        if (pick < 0.55) g.add(this.#coral(cx, cy, cz));
        else if (pick < 0.8) g.add(this.#weed(cx, cy, cz));
        else g.add(this.#boulder(cx, cy, cz, 0.6 + this.rand() * 0.8));
      }

      this.#add(g);
      this.islands.push({ x, z, r: r * 1.1, shelfR });

      if (this.rand() < 0.5) {
        this.schools.push(this.#school(x, z, -1.3 - this.rand() * 0.8, r * 1.55, 8 + Math.floor(this.rand() * 8)));
      }
    }
  }

  // ---- Reefs: rock pillars that rise to just under the surface in open water ----
  #makeReefs(n) {
    for (let i = 0; i < n; i++) {
      const [x, z] = this.#freeSpot(8);
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      const top = -1.4 - this.rand() * 1.4;
      const h = top - SEABED_Y;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5 + this.rand(), 4 + this.rand() * 2, h, 7), this.mats.reef);
      base.position.y = SEABED_Y + h / 2;
      base.rotation.y = this.rand() * 3;
      g.add(base);
      for (let k = 0; k < 4; k++) {
        const a = this.rand() * Math.PI * 2;
        g.add(this.#coral(Math.cos(a) * 1.2, top, Math.sin(a) * 1.2));
      }
      this.#add(g);
      this.reserved.push({ x, z, r: 5 });
    }
  }

  #coral(x, y, z) {
    const g = new THREE.Group();
    const mat = this.mats.coral[Math.floor(this.rand() * this.mats.coral.length)];
    const branches = 2 + Math.floor(this.rand() * 4);
    for (let i = 0; i < branches; i++) {
      const s = 0.3 + this.rand() * 0.45;
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat);
      m.position.set((this.rand() - 0.5) * 0.9, s * 0.8 + this.rand() * 0.4, (this.rand() - 0.5) * 0.9);
      m.scale.y = 1.2 + this.rand();
      g.add(m);
    }
    g.position.set(x, y, z);
    return g;
  }

  #weed(x, y, z) {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const h = 0.8 + this.rand() * 1.2;
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.12, h, 4), this.mats.weed);
      m.position.set((this.rand() - 0.5) * 0.6, h / 2, (this.rand() - 0.5) * 0.6);
      m.rotation.z = (this.rand() - 0.5) * 0.5;
      g.add(m);
    }
    g.position.set(x, y, z);
    return g;
  }

  #boulder(x, y, z, s) {
    const m = new THREE.Mesh(faceted(new THREE.DodecahedronGeometry(s, 0)), this.mats.rock);
    m.position.set(x, y + s * 0.4, z);
    m.rotation.set(this.rand() * 3, this.rand() * 3, 0);
    return m;
  }

  #school(cx, cz, y, radius, count) {
    const geo = new THREE.ConeGeometry(0.16, 0.6, 4).rotateX(Math.PI / 2); // points +Z
    const colors = ['#ff9f1c', '#ffd23f', '#3bceac', '#ee4266'];
    const mat = toon(colors[Math.floor(this.rand() * colors.length)]);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const fish = [];
    for (let i = 0; i < count; i++) {
      fish.push({ a: this.rand() * 0.9, r: (this.rand() - 0.5) * 2.2, y: (this.rand() - 0.5) * 0.6, w: this.rand() * 10 });
    }
    return { mesh, cx, cz, y, radius, fish, speed: (0.25 + this.rand() * 0.2) * (this.rand() < 0.5 ? 1 : -1), phase: this.rand() * 6, scare: 0 };
  }

  #palm(x, z, y) {
    const p = new THREE.Group();
    const h = 2.5 + this.rand() * 1.5;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, h, 5), this.mats.trunk);
    trunk.position.y = h / 2;
    addOutline(trunk, 0.06);
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
    const chain = new THREE.CylinderGeometry(0.04, 0.04, 6, 3);
    for (let i = 0; i < n; i++) {
      const [x, z] = this.#freeSpot(4);
      const g = new THREE.Group();
      const b = new THREE.Mesh(body, i % 2 ? this.mats.buoyRed : this.mats.buoyWhite);
      const c = new THREE.Mesh(cap, i % 2 ? this.mats.buoyWhite : this.mats.buoyRed);
      c.position.y = 0.9;
      addOutline(b, 0.07); addOutline(c, 0.07);
      const ch = new THREE.Mesh(chain, this.mats.reef); // anchor chain, visible under water
      ch.position.y = -3.4;
      g.add(b, c, ch);
      g.position.set(x, 0, z);
      this.#add(g);
      this.buoys.push({ mesh: g, x, z, phase: this.rand() * 10 });
    }
  }

  #makeRings(n) {
    const geo = new THREE.TorusGeometry(1.3, 0.28, 8, 20);
    for (let i = 0; i < n; i++) {
      const mesh = addOutline(new THREE.Mesh(geo, this.mats.gold), 0.07);
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

  #updateSchools(t, dt, boat) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    for (const s of this.schools) {
      // Fish scatter when the boat roars past.
      const near = Math.hypot(boat.pos.x - s.cx, boat.pos.y - s.cz) < s.radius + 6 && boat.speed > 6;
      s.scare += ((near ? 1 : 0) - s.scare) * Math.min(1, dt * (near ? 4 : 0.6));
      const speed = s.speed * (1 + s.scare * 2.5);
      s.phase += speed * dt;
      for (let i = 0; i < s.fish.length; i++) {
        const f = s.fish[i];
        const a = s.phase + f.a;
        const r = s.radius + f.r * (1 + s.scare * 2.2);
        pos.set(s.cx + Math.cos(a) * r, s.y + f.y + Math.sin(t * 3 + f.w) * 0.08, s.cz + Math.sin(a) * r);
        // Heading = tangent of the circle, plus a tail wiggle.
        const dir = Math.sign(s.speed);
        e.set(0, Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir) + Math.sin(t * 9 + f.w) * 0.25, 0);
        q.setFromEuler(e);
        m.compose(pos, q, one);
        s.mesh.setMatrixAt(i, m);
      }
      s.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Animate props and return how many rings the boat collected this frame. */
  update(t, dt, boat) {
    this.seabed.position.x = Math.round(boat.pos.x / 8) * 8;
    this.seabed.position.z = Math.round(boat.pos.y / 8) * 8;

    for (const b of this.buoys) {
      b.mesh.position.y = waveHeight(b.x, b.z, t) - 0.2;
      b.mesh.rotation.z = Math.sin(t * 1.3 + b.phase) * 0.15;
      b.mesh.rotation.x = Math.cos(t * 1.1 + b.phase) * 0.15;
    }
    this.#updateSchools(t, dt, boat);

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

