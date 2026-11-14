import * as THREE from 'three';
import { waveHeight, rollerAt, ROLLER } from './water.js';

const MAX_SPEED = 22; // units / s (cruise)
const BOOST_MULT = 1.6;
const ACCEL = 16;
const REVERSE_ACCEL = 7;
const FORWARD_DRAG = 0.55;
const LATERAL_GRIP = 2.4; // lower = more drift
const TURN_RATE = 2.3; // rad / s at speed
const GRAVITY = 14; // a bit stronger than real for snappy hops
const BUOY_K = 70; // how stiffly the hull floats back to the surface
const BUOY_DAMP = 9;
const LAUNCH = 0.75; // how hard a rolling swell throws the hull (multiplied by how fast it rises under you)
const LAUNCH_MIN_RISE = 3; // the swell must rise under the hull at least this fast (units/s) -> hit it at speed
const JUMP_COOLDOWN = 1; // short guard so one swell can't launch you twice

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
    // Vertical motion (bouncing).
    this.y = 0;
    this.vy = 0;
    this.prevRest = null;
    this.prevSwell = 0;
    this.airborne = false;
    this.airTime = 0;
    this.jumpCooldown = 0;
    this.steer = 0;
    this.boosting = false;
    this.events = []; // 'land' / 'hit' events for spray + camera shake, drained by main.js
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

    // In the air the propeller and rudder bite nothing.
    const grip = this.airborne ? 0.3 : 1;

    // Throttle.
    if (input.throttle > 0) {
      vf += input.throttle * ACCEL * (input.boost ? 1.5 : 1) * grip * dt;
    } else if (input.throttle < 0) {
      vf += input.throttle * REVERSE_ACCEL * grip * dt;
    }
    // Drag, with an extra soft cap above max speed.
    vf -= vf * FORWARD_DRAG * (this.airborne ? 0.3 : 1) * dt;
    if (vf > maxSpeed) vf += (maxSpeed - vf) * 3 * dt;
    if (vf < -maxSpeed * 0.3) vf = -maxSpeed * 0.3;

    // Lateral grip: water resists sideways sliding, but not perfectly -> drift.
    vl *= Math.exp(-LATERAL_GRIP * grip * dt);

    // Steering needs water flowing past the rudder.
    const steerAuthority = Math.min(Math.abs(vf) / 6, 1) * Math.sign(vf || 1);
    const turn = input.steer * TURN_RATE * steerAuthority * (input.boost ? 0.85 : 1) * (this.airborne ? 0.6 : 1);
    this.heading -= turn * dt;
    this.steer = input.steer;
    this.boosting = input.boost && input.throttle > 0;

    // Rebuild velocity in the new frame.
    const nf = this.forward;
    const nr = this.right;
    this.vel.set(nf.x * vf + nr.x * vl, nf.y * vf + nr.y * vl);
    this.pos.addScaledVector(this.vel, dt);

    const speedFactor = Math.min(Math.abs(vf) / MAX_SPEED, 1.4);
    const accelForward = (vf - this.prevForward) / Math.max(dt, 1e-4);
    this.prevForward = vf;

    // --- Water surface under the hull ---
    const bx = this.pos.x, bz = this.pos.y;
    const L = 2.2, W = 1.0;
    const hBow = waveHeight(bx + nf.x * L, bz + nf.y * L, t);
    const hStern = waveHeight(bx - nf.x * L, bz - nf.y * L, t);
    const hRight = waveHeight(bx + nr.x * W, bz + nr.y * W, t);
    const hLeft = waveHeight(bx - nr.x * W, bz - nr.y * W, t);
    const h = (hBow + hStern + hLeft + hRight) / 4;
    // Planing: the hull rides higher at speed.
    const rest = h - 0.25 + speedFactor * 0.15;
    if (this.prevRest === null) { this.prevRest = rest; this.y = rest; }
    const surfaceVel = (rest - this.prevRest) / Math.max(dt, 1e-4);
    this.prevRest = rest;
    // How fast the rolling swell (the visible whitecapped ridges) is rising under the hull.
    const swell = ROLLER.amp * (rollerAt(bx + nf.x * L, bz + nf.y * L, t) + rollerAt(bx, bz, t)) / 2;
    const swellRise = (swell - this.prevSwell) / Math.max(dt, 1e-4);
    this.prevSwell = swell;

    // --- Vertical physics ---
    // Normally the hull just floats on the surface (a stiff spring). A jump only happens when
    // you hit one of the visible rolling swells head-on at speed.
    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    if (!this.airborne && swellRise > LAUNCH_MIN_RISE && speedFactor > 0.55 && this.jumpCooldown === 0) {
      this.vy = THREE.MathUtils.clamp(swellRise * LAUNCH, 4.5, 8.5);
      this.y = Math.max(this.y, rest) + 0.2;
      this.airborne = true;
    }

    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      if (this.y <= rest && this.vy < 0) {
        // Touchdown.
        const impact = -this.vy;
        if (impact > 1.5) {
          this.events.push({ type: 'land', strength: impact });
          this.pitch += Math.min(impact * 0.035, 0.25); // nose slaps down
          this.roll += (Math.random() - 0.5) * impact * 0.04;
          vf *= 1 - Math.min(impact * 0.012, 0.12);
          this.vel.set(nf.x * vf + nr.x * vl, nf.y * vf + nr.y * vl);
        }
        this.vy *= 0.3; // water soaks up the hit; the spring makes the hull settle with a bob
        this.airborne = false;
        this.airTime = 0;
        this.jumpCooldown = JUMP_COOLDOWN;
      }
    } else {
      // Buoyancy spring + damping, following the moving surface.
      this.vy += (BUOY_K * (rest - this.y) - BUOY_DAMP * (this.vy - surfaceVel)) * dt;
      this.y += this.vy * dt;
      if (this.y < rest - 0.8) { this.y = rest - 0.8; this.vy = Math.max(this.vy, 0); }
    }

    // --- Visual tilt ---
    // Bank into the turn, plus a little lean from sideways sliding.
    let targetRoll = input.steer * speedFactor * 0.32 - (vl / MAX_SPEED) * 0.5;
    // Bow lifts with speed and when accelerating hard.
    let targetPitch = -(speedFactor * 0.1 + THREE.MathUtils.clamp(accelForward / 60, -0.08, 0.12));

    if (this.airborne) {
      // Nose follows the flight path: up while rising, dipping as it falls.
      targetPitch += THREE.MathUtils.clamp(-this.vy * 0.06, -0.35, 0.3);
      targetRoll *= 0.5;
    } else {
      targetPitch += -Math.atan2(hBow - hStern, 2 * L) * 0.8;
      targetRoll += Math.atan2(hLeft - hRight, 2 * W) * 0.8;
    }

    const k = 1 - Math.exp(-(this.airborne ? 3 : 6) * dt);
    this.roll += (targetRoll - this.roll) * k;
    this.pitch += (targetPitch - this.pitch) * k;

    this.root.position.set(bx, this.y, bz);
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
      if (-vn > 3) this.events.push({ type: 'hit', strength: -vn, x: cx + nx * radius, z: cz + nz * radius });
      return -vn;
    }
    return 0;
  }
}
