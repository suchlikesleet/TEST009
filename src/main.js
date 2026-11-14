import * as THREE from 'three';
import { Water, SURFACE_LAYER } from './water.js';
import { Boat } from './boat.js';
import { World } from './world.js';
import { Wake } from './wake.js';
import { Controls } from './controls.js';
import { Spray } from './spray.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // updated once per frame by Water.render

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a5a7a');

const camera = new THREE.PerspectiveCamera(50, 1, 1, 400);
camera.layers.enable(SURFACE_LAYER);

// Lighting.
scene.add(new THREE.HemisphereLight('#cfeeff', '#0a4a63', 1.4));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
scene.add(sun, sun.target);

const water = new Water(scene, renderer);
const boat = new Boat(scene);
const world = new World(scene);
const wake = new Wake(scene);
for (const p of wake.items) p.m.layers.set(SURFACE_LAYER);
const spray = new Spray(scene);
const controls = new Controls(
  document.getElementById('boost'),
  document.getElementById('stick-base'),
  document.getElementById('stick-knob')
);

// Arrow that points to the nearest ring.
const arrow = new THREE.Mesh(
  new THREE.ConeGeometry(0.5, 1.4, 4).rotateX(Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: '#ffc531', transparent: true, opacity: 0.85 })
);
arrow.layers.set(SURFACE_LAYER);
scene.add(arrow);

const speedEl = document.getElementById('speed');
const scoreEl = document.getElementById('score');
let score = 0;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  water.setSize(size.x, size.y);
  spray.setViewport(size.y, camera);
}
window.addEventListener('resize', resize);
resize();

// Camera follows from above, slightly behind (south), and pulls back at speed.
const camPos = new THREE.Vector3(0, 40, 20);
const lookAt = new THREE.Vector3();
let shake = 0;
function updateCamera(dt) {
  const portrait = camera.aspect < 1;
  const speedK = Math.min(boat.speed / 30, 1);
  const height = (portrait ? 42 : 30) + speedK * 12;
  // Look ahead in the direction of travel, but never so far the boat leaves the screen.
  const halfH = height * 1.1 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const halfW = halfH * camera.aspect;
  const tx = boat.pos.x + THREE.MathUtils.clamp(boat.vel.x * 0.7, -halfW * 0.5, halfW * 0.5);
  const tz = boat.pos.y + THREE.MathUtils.clamp(boat.vel.y * 0.7, -halfH * 0.5, halfH * 0.5);
  const k = 1 - Math.exp(-3 * dt);
  lookAt.x += (tx - lookAt.x) * k;
  lookAt.z += (tz - lookAt.z) * k;
  camPos.set(lookAt.x, height, lookAt.z + height * 0.45);
  camera.position.lerp(camPos, k);
  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.z += (Math.random() - 0.5) * shake;
    shake = Math.max(0, shake - dt * 3);
  }
  camera.lookAt(lookAt);
}

const clock = new THREE.Clock();
let t = 0;
let running = false;

function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 30);
  t += dt;

  const input = running ? controls.read(boat) : { throttle: 0, steer: 0, boost: false };
  boat.update(dt, input, t);
  const got = world.update(t, dt, boat);
  for (const e of boat.events) {
    if (e.type === 'land') {
      const p = boat.root.position;
      spray.burst(p.x, p.y, p.z, e.strength, boat.vel.x, boat.vel.y);
      shake = Math.max(shake, Math.min(0.8, e.strength * 0.1));
    } else if (e.type === 'hit') {
      spray.burst(e.x, boat.root.position.y, e.z, e.strength * 0.8);
      shake = Math.max(shake, Math.min(1.5, e.strength * 0.08));
    }
  }
  boat.events.length = 0;
  if (got) { score += got; scoreEl.textContent = score; }
  wake.update(dt, t, boat);
  spray.update(dt, t, boat);
  water.update(t, boat.root.position, camera);

  const near = world.nearestRing(boat.pos.x, boat.pos.y);
  arrow.visible = !!near && near.dist > 18;
  if (arrow.visible) {
    const a = Math.atan2(near.ring.x - boat.pos.x, near.ring.z - boat.pos.y);
    arrow.position.set(boat.pos.x + Math.sin(a) * 5, boat.root.position.y + 1.5, boat.pos.y + Math.cos(a) * 5);
    arrow.rotation.y = a;
  }

  sun.position.set(boat.pos.x + 20, 50, boat.pos.y + 15);
  sun.target.position.set(boat.pos.x, 0, boat.pos.y);

  updateCamera(dt);
  speedEl.textContent = Math.round(boat.speed * 1.6);
  water.render(scene, camera);
  requestAnimationFrame(frame);
}
lookAt.set(boat.pos.x, 0, boat.pos.y);
camera.position.set(0, 40, 18);
requestAnimationFrame(frame);
window.game = { boat, world }; // handy for debugging in the browser console

// Start / fullscreen.
const intro = document.getElementById('intro');
document.getElementById('start').addEventListener('click', () => {
  intro.classList.add('hidden');
  running = true;
  goFullscreen();
});

const fsBtn = document.getElementById('fullscreen');
const canFullscreen = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
if (!canFullscreen) fsBtn.style.display = 'none';
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else goFullscreen();
});

function goFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return;
  Promise.resolve(req.call(el, { navigationUI: 'hide' })).catch(() => {});
}
