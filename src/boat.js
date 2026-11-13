import * as THREE from 'three';
import { waveHeight } from './water.js';

const MAX_SPEED = 22; // units / s (cruise)
const BOOST_MULT = 1.6;
const ACCEL = 16;
const REVERSE_ACCEL = 7;
const FORWARD_DRAG = 0.55;
const LATERAL_GRIP = 2.4; // lower = more drift
const TURN_RATE = 2.3; // rad / s at speed

function buildModel() {
  const model = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: '#f4f4f4', flatShading: true, roughness: 0.5 });
  const red = new THREE.MeshStandardMaterial({ color: '#e8462f', flatShading: true, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: '#1f2a33', flatShading: true, roughness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: '#7fd4ff', flatShading: true, roughness: 0.1, metalness: 0.2 });

  // Hull: a pointed shape extruded downward.
  const shape = new THREE.Shape();
  shape.moveTo(0, 3.2);
  shape.quadraticCurveTo(1.25, 1.4, 1.2, -1.6);
  shape.lineTo(1.0, -2.2);
  shape.lineTo(-1.0, -2.2);
  shape.lineTo(-1.2, -1.6);
  shape.quadraticCurveTo(-1.25, 1.4, 0, 3.2);
  const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.7, bevelEnabled: true, bevelSize: 0.15, bevelThickness: 0.15, bevelSegments: 1, curveSegments: 6 });
  hullGeo.rotateX(Math.PI / 2); // shape Y -> local +Z (bow), extrusion -> downward
  hullGeo.translate(0, 0.55, 0);
  const hull = new THREE.Mesh(hullGeo, white);
  model.add(hull);

  // Red stripe along the deck edge.
  const stripeGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false, curveSegments: 6 });
  stripeGeo.rotateX(Math.PI / 2);
  stripeGeo.scale(1.16, 1, 1.07);
  stripeGeo.translate(0, 0.55, 0);
  model.add(new THREE.Mesh(stripeGeo, red));

  // Cockpit + windshield.
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 1.6), dark);
  cockpit.position.set(0, 0.75, -0.6);
  model.add(cockpit);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 0.08), glass);
  shield.position.set(0, 0.95, 0.3);
  shield.rotation.x = -0.5;
  model.add(shield);

  // Engine at the stern.
  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.5), dark);
  engine.position.set(0, 0.6, -2.35);
  model.add(engine);

  model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return model;
}

export class Boat {
  constructor(scene) {
    this.root = new THREE.Group(); // position + yaw
    this.tilt = new THREE.Group(); // pitch + roll
    this.root.add(this.tilt);
    this.tilt.add(buildModel());
    scene.add(this.root);

    this.pos = new THREE.Vector2(0, 0);
    this.vel = new THREE.Vector2(0, 0);
    this.heading = Math.PI; // facing "up" the screen (-Z)
    this.roll = 0;
    this.pitch = 0;
    this.prevForward = 0;
    this.radius = 1.6;
  }

  get forward() { return new THREE.Vector2(Math.sin(this.heading), Math.cos(this.heading)); }
  get right() { return new THREE.Vector2(-Math.cos(this.heading), Math.sin(this.heading)); }
  get speed() { return this.vel.length(); }

  update(dt, input, t) {
    const f = this.forward;
    const r = this.right;
    let vf = this.vel.dot(f);
    let vl = this.vel.dot(r);

    const maxSpeed = MAX_SPEED * (input.boost ? BOOST_MULT : 1);

    // Throttle.
    if (input.throttle > 0) {
      vf += input.throttle * ACCEL * (input.boost ? 1.5 : 1) * dt;
    } else if (input.throttle < 0) {
      vf += input.throttle * REVERSE_ACCEL * dt;
    }
    // Drag, with an extra soft cap above max speed.
    vf -= vf * FORWARD_DRAG * dt;
    if (vf > maxSpeed) vf += (maxSpeed - vf) * 3 * dt;
    if (vf < -maxSpeed * 0.3) vf = -maxSpeed * 0.3;

    // Lateral grip: water resists sideways sliding, but not perfectly -> drift.
    vl *= Math.exp(-LATERAL_GRIP * dt);

    // Steering needs water flowing past the rudder.
    const steerAuthority = Math.min(Math.abs(vf) / 6, 1) * Math.sign(vf || 1);
    const turn = input.steer * TURN_RATE * steerAuthority * (input.boost ? 0.85 : 1);
    this.heading -= turn * dt;

    // Rebuild velocity in the new frame.
    const nf = this.forward;
    const nr = this.right;
    this.vel.set(nf.x * vf + nr.x * vl, nf.y * vf + nr.y * vl);
    this.pos.addScaledVector(this.vel, dt);

    // --- Visual tilt ---
    const speedFactor = Math.min(Math.abs(vf) / MAX_SPEED, 1.4);
    const accelForward = (vf - this.prevForward) / Math.max(dt, 1e-4);
    this.prevForward = vf;

    // Bank into the turn, plus a little lean from sideways sliding.
    const targetRoll = input.steer * speedFactor * 0.32 - (vl / MAX_SPEED) * 0.5;
    // Bow lifts with speed and when accelerating hard.
    const targetPitch = -(speedFactor * 0.1 + THREE.MathUtils.clamp(accelForward / 60, -0.08, 0.12));

    // Wave slope under the boat.
    const bx = this.pos.x, bz = this.pos.y;
    const L = 2.2, W = 1.0;
    const hBow = waveHeight(bx + nf.x * L, bz + nf.y * L, t);
    const hStern = waveHeight(bx - nf.x * L, bz - nf.y * L, t);
    const hRight = waveHeight(bx + nr.x * W, bz + nr.y * W, t);
    const hLeft = waveHeight(bx - nr.x * W, bz - nr.y * W, t);
    const wavePitch = -Math.atan2(hBow - hStern, 2 * L) * 0.8;
    const waveRoll = Math.atan2(hLeft - hRight, 2 * W) * 0.8;

    const k = 1 - Math.exp(-6 * dt);
    this.roll += (targetRoll + waveRoll - this.roll) * k;
    this.pitch += (targetPitch + wavePitch - this.pitch) * k;

    const h = (hBow + hStern + hLeft + hRight) / 4;
    // Planing: the hull rides higher at speed.
    this.root.position.set(bx, h - 0.25 + speedFactor * 0.15, bz);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this.pitch, 0, this.roll, 'YXZ');
  }

  collide(cx, cz, radius) {
    const dx = this.pos.x - cx;
    const dz = this.pos.y - cz;
    const dist = Math.hypot(dx, dz);
    const min = radius + this.radius;
    if (dist >= min || dist === 0) return 0;
    const nx = dx / dist, nz = dz / dist;
    this.pos.set(cx + nx * min, cz + nz * min);
    const vn = this.vel.x * nx + this.vel.y * nz;
    if (vn < 0) {
      // Bounce off and lose speed.
      this.vel.x -= 1.4 * vn * nx;
      this.vel.y -= 1.4 * vn * nz;
      this.vel.multiplyScalar(0.6);
      return -vn;
    }
    return 0;
  }
}
