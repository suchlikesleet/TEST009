// Touch: drag anywhere for a floating joystick. The stick points where you want the
// boat to go (screen up = north) and how far you push sets the throttle.
// Keyboard: W/S or Up/Down = throttle, A/D or Left/Right = steer, Space = boost.

const STICK_RADIUS = 55;

export class Controls {
  constructor(boostBtn, base, knob) {
    this.base = base;
    this.knob = knob;
    this.boostBtn = boostBtn;
    this.stickId = null;
    this.origin = { x: 0, y: 0 };
    this.stick = { x: 0, y: 0 }; // -1..1, y down
    this.touchBoost = false;
    this.keys = new Set();

    const canvas = document.getElementById('game');
    canvas.addEventListener('pointerdown', (e) => this.#down(e));
    window.addEventListener('pointermove', (e) => this.#move(e));
    window.addEventListener('pointerup', (e) => this.#up(e));
    window.addEventListener('pointercancel', (e) => this.#up(e));

    const setBoost = (on) => (e) => {
      e.preventDefault();
      this.touchBoost = on;
      boostBtn.classList.toggle('active', on);
    };
    boostBtn.addEventListener('pointerdown', setBoost(true));
    boostBtn.addEventListener('pointerup', setBoost(false));
    boostBtn.addEventListener('pointercancel', setBoost(false));
    boostBtn.addEventListener('pointerleave', setBoost(false));

    window.addEventListener('keydown', (e) => { this.keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  #down(e) {
    if (this.stickId !== null) return;
    this.stickId = e.pointerId;
    this.origin = { x: e.clientX, y: e.clientY };
    this.stick = { x: 0, y: 0 };
    this.base.style.display = 'block';
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.knob.style.transform = 'translate(0px, 0px)';
  }

  #move(e) {
    if (e.pointerId !== this.stickId) return;
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) { dx *= STICK_RADIUS / len; dy *= STICK_RADIUS / len; }
    this.stick = { x: dx / STICK_RADIUS, y: dy / STICK_RADIUS };
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  #up(e) {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.stick = { x: 0, y: 0 };
    this.base.style.display = 'none';
  }

  /** Returns { throttle, steer, boost } for the boat this frame. */
  read(boat) {
    const k = this.keys;
    const boost = this.touchBoost || k.has('Space') || k.has('ShiftLeft');
    const kbThrottle = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const kbSteer = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    if (kbThrottle || kbSteer) return { throttle: kbThrottle, steer: kbSteer, boost };

    const mag = Math.min(Math.hypot(this.stick.x, this.stick.y), 1);
    if (mag < 0.15) return { throttle: 0, steer: 0, boost };

    // Stick direction -> desired world heading (screen right = +X, screen down = +Z).
    const target = Math.atan2(this.stick.x, this.stick.y);
    let diff = target - boat.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-PI, PI]
    const steer = Math.max(-1, Math.min(1, -diff * 2.2));
    // Ease off a little when asking for a hard turn so the boat swings around.
    const throttle = mag * (Math.abs(diff) > 2 ? 0.55 : 1);
    return { throttle, steer, boost };
  }
}
