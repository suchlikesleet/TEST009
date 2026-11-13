import * as THREE from 'three';
import { Water } from './water.js';
import { Boat } from './boat.js';
import { World } from './world.js';
import { Wake } from './wake.js';
import { Controls } from './controls.js';

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0a5a7a');

const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 400);

// Lighting.
scene.add(new THREE.HemisphereLight('#cfeeff', '#0a4a63', 1.4));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
scene.add(sun, sun.target);

const water = new Water(scene);
const boat = new Boat(scene);
const world = new World(scene);
const wake = new Wake(scene);
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
scene.add(arrow);

const speedEl = document.getElementById('speed');
const scoreEl = document.getElementById('score');
let score = 0;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
  const lead = 0.7; // look ahead in the direction of travel
  const tx = boat.pos.x + boat.vel.x * lead;
  const tz = boat.pos.y + boat.vel.y * lead;
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
  const before = boat.speed;
  const got = world.update(t, boat);
  if (before - boat.speed > 4) shake = Math.min(1.5, (before - boat.speed) * 0.08);
  if (got) { score += got; scoreEl.textContent = score; }
  wake.update(dt, t, boat);
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
  renderer.render(scene, camera);
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
