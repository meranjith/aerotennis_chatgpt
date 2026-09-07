const RAD = Math.PI / 180;
const GRAVITY = 9.80665;
const EPS = 1e-8;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = v => Math.hypot(v.x, v.y, v.z);
const normalize = v => {
  const n = length(v);
  return n > EPS ? {x: v.x / n, y: v.y / n, z: v.z / n} : {x: 0, y: 0, z: 0};
};
const sub = (a, b) => ({x: a.x - b.x, y: a.y - b.y, z: a.z - b.z});
const scale = (v, s) => ({x: v.x * s, y: v.y * s, z: v.z * s});

function qNormalize(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return {x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n};
}
function qMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
  };
}
function qInverse(q) { return {x: -q.x, y: -q.y, z: -q.z, w: q.w}; }
function qRotate(q, v) {
  const p = {x: v.x, y: v.y, z: v.z, w: 0};
  const r = qMul(qMul(q, p), qInverse(q));
  return {x: r.x, y: r.y, z: r.z};
}
function qFromAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2), c = Math.cos(angle / 2);
  return qNormalize({x: ax * s, y: ay * s, z: az * s, w: c});
}
function qAngle(q) {
  return 2 * Math.acos(clamp(Math.abs(q.w), -1, 1));
}

// Standard DeviceOrientation -> quaternion conversion.  We only use it
// comparatively: current orientation is compared to the calibrated pose.
function quatFromDeviceOrientation(alpha, beta, gamma, screenAngleDeg) {
  const a = (alpha || 0) * RAD / 2;
  const b = (beta || 0) * RAD / 2;
  const g = (gamma || 0) * RAD / 2;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  let q = {
    x: sB * cG,
    y: cB * sG,
    z: sA * cB * cG - cA * sB * sG,
    w: cA * cB * cG + sA * sB * sG
  };

  q = qNormalize(qMul(qFromAxisAngle(0, 0, 1, -screenAngleDeg * RAD), q));
  q = qNormalize(qMul(qFromAxisAngle(1, 0, 0, -Math.PI / 2), q));
  return q;
}

export class MotionEngine {
  constructor() {
    this.listeners = new Set();
    this.state = {
      ready: false,
      calibrated: false,
      face: 'unknown',
      faceDot: 0,
      forwardAccel: 0,
      rawForwardAccel: 0,
      lateralAccel: 0,
      rotRate: 0,
      confidence: 0,
      swing: false,
      hitQuality: 0,
      orientation: {},
      accel: {x: 0, y: 0, z: 0},
      source: 'none'
    };

    this.currentQ = null;
    this.referenceQ = null;
    this.lastOrientationQ = null;
    this.lastOrientationT = 0;
    this.lastMotionT = 0;
    this.lastSwingT = -Infinity;
    this.gravityEstimate = {x: 0, y: 0, z: 0};
    this.filteredForward = 0;
    this.previousForward = 0;
    this.screenAngle = 0;
    this.running = false;

    // Deliberately tolerant: different phones report materially different peak
    // accelerations.  We detect a forward-thrust envelope, not one magic sample.
    this.triggerAccel = 4.2;       // m/s^2
    this.strongTriggerAccel = 6.0; // m/s^2
    this.triggerSlope = 7.0;       // m/s^3
    this.minCooldownMs = 260;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.state); }

  static supports() {
    return typeof window !== 'undefined' &&
      'DeviceOrientationEvent' in window &&
      'DeviceMotionEvent' in window;
  }

  async requestPermission() {
    const requests = [];
    if (typeof DeviceMotionEvent?.requestPermission === 'function') requests.push(DeviceMotionEvent.requestPermission());
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') requests.push(DeviceOrientationEvent.requestPermission());
    if (requests.length) {
      const results = await Promise.all(requests);
      if (results.some(v => v !== 'granted')) throw new Error('Motion/orientation permission was denied.');
    }
    await this.start();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.updateScreenAngle();
    window.addEventListener('orientationchange', this.updateScreenAngle, {passive: true});
    window.addEventListener('deviceorientation', this.onOrientation, {passive: true});
    window.addEventListener('devicemotion', this.onMotion, {passive: true});
    this.state.ready = true;
    this.emit();
  }

  stop() {
    this.running = false;
    window.removeEventListener('orientationchange', this.updateScreenAngle);
    window.removeEventListener('deviceorientation', this.onOrientation);
    window.removeEventListener('devicemotion', this.onMotion);
  }

  updateScreenAngle = () => {
    this.screenAngle = Number(window.screen?.orientation?.angle ?? window.orientation ?? 0) || 0;
  };

  onOrientation = (e) => {
    this.updateScreenAngle();
    const q = quatFromDeviceOrientation(e.alpha, e.beta, e.gamma, this.screenAngle);
    const now = performance.now();

    if (this.lastOrientationQ && this.lastOrientationT) {
      const dt = Math.max(0.005, (now - this.lastOrientationT) / 1000);
      const delta = qMul(qInverse(this.lastOrientationQ), q);
      this.state.rotRate = qAngle(delta) / dt;
    }

    this.currentQ = q;
    this.lastOrientationQ = q;
    this.lastOrientationT = now;
    this.state.orientation = {
      alpha: Number(e.alpha) || 0,
      beta: Number(e.beta) || 0,
      gamma: Number(e.gamma) || 0
    };

    this.updateRelativeOrientation();
    this.emit();
  };

  updateRelativeOrientation() {
    if (!this.referenceQ || !this.currentQ) return;
    const relative = qMul(qInverse(this.referenceQ), this.currentQ);
    const screenNormal = qRotate(relative, {x: 0, y: 0, z: 1});
    const d = clamp(screenNormal.z, -1, 1);
    this.state.faceDot = d;

    // Hysteresis prevents tiny hand/wrist movements from changing face state.
    if (this.state.face === 'screen') {
      if (d < 0.35) this.state.face = d <= -0.35 ? 'back' : 'edge';
    } else if (this.state.face === 'back') {
      if (d > -0.35) this.state.face = d >= 0.35 ? 'screen' : 'edge';
    } else {
      if (d >= 0.55) this.state.face = 'screen';
      else if (d <= -0.55) this.state.face = 'back';
      else this.state.face = 'edge';
    }

    this.state.confidence = Math.round(Math.abs(d) * 100);
  }

  getLinearAcceleration(e, dt) {
    const direct = e.acceleration;
    const directFinite = direct && [direct.x, direct.y, direct.z].every(Number.isFinite);
    if (directFinite && length(direct) > 0.15) {
      this.state.source = 'linear';
      return {x: Number(direct.x), y: Number(direct.y), z: Number(direct.z)};
    }

    const raw = e.accelerationIncludingGravity;
    if (!raw || ![raw.x, raw.y, raw.z].every(Number.isFinite)) return null;

    this.state.source = 'gravity-subtracted';
    const v = {x: Number(raw.x), y: Number(raw.y), z: Number(raw.z)};
    const alpha = clamp(dt / 0.45, 0.015, 0.18);
    this.gravityEstimate = {
      x: this.gravityEstimate.x + alpha * (v.x - this.gravityEstimate.x),
      y: this.gravityEstimate.y + alpha * (v.y - this.gravityEstimate.y),
      z: this.gravityEstimate.z + alpha * (v.z - this.gravityEstimate.z)
    };
    return sub(v, this.gravityEstimate);
  }

  onMotion = (e) => {
    if (!this.currentQ || !this.referenceQ) return;

    const now = performance.now();
    const dt = this.lastMotionT ? Math.max(0.008, Math.min(0.08, (now - this.lastMotionT) / 1000)) : 0.016;
    this.lastMotionT = now;

    const local = e.acceleration || e.accelerationIncludingGravity;
    if (local && [local.x, local.y, local.z].every(Number.isFinite)) {
      this.state.accel = {x: Number(local.x), y: Number(local.y), z: Number(local.z)};
    }

    const linear = this.getLinearAcceleration(e, dt);
    if (!linear) return;

    // Transform current acceleration into the calibrated device frame.
    // This is the key fix: we never assume that browser/world axes are the same
    // on every phone. At calibration, +Z is defined as racket-forward.
    const relative = qMul(qInverse(this.referenceQ), this.currentQ);
    const inCalibrationFrame = qRotate(relative, linear);
    const rawForward = inCalibrationFrame.z;
    const lateralVector = {x: inCalibrationFrame.x, y: inCalibrationFrame.y, z: 0};
    const lateral = length(lateralVector);

    // A small low-pass filter keeps noisy phone samples from creating phantom hits,
    // while preserving the short thrust peak of a real swing.
    const filterAlpha = clamp(dt / 0.035, 0.12, 0.65);
    this.filteredForward += filterAlpha * (rawForward - this.filteredForward);
    const slope = (rawForward - this.previousForward) / dt;
    this.previousForward = rawForward;

    this.state.forwardAccel = this.filteredForward;
    this.state.rawForwardAccel = rawForward;
    this.state.lateralAccel = lateral;
    this.updateRelativeOrientation();

    const rising = slope >= this.triggerSlope;
    const strong = rawForward >= this.strongTriggerAccel;
    const normal = this.filteredForward >= this.triggerAccel && rising;
    const nowSinceLast = now - this.lastSwingT;

    if ((strong || normal) && nowSinceLast >= this.minCooldownMs) {
      this.lastSwingT = now;
      this.state.swing = true;
      const magnitudeScore = clamp((Math.max(rawForward, this.filteredForward) - 3.0) / 8.0, 0, 1);
      const faceScore = Math.abs(this.state.faceDot);
      const rotationScore = clamp(this.state.rotRate / 3.0, 0, 1);
      this.state.hitQuality = clamp(0.65 * magnitudeScore + 0.25 * faceScore + 0.10 * rotationScore, 0, 1);
      this.emit();
      setTimeout(() => {
        if (performance.now() - this.lastSwingT > 90) {
          this.state.swing = false;
          this.emit();
        }
      }, 100);
    }

    this.emit();
  };

  calibrate() {
    if (!this.currentQ) throw new Error('No orientation sample yet. Hold the phone still and try again.');
    this.referenceQ = this.currentQ;
    this.state.calibrated = true;
    this.state.face = 'screen';
    this.state.faceDot = 1;
    this.state.confidence = 100;
    this.filteredForward = 0;
    this.previousForward = 0;
    this.gravityEstimate = {x: 0, y: 0, z: 0};
    this.lastSwingT = -Infinity;
    this.emit();
  }

  consumeSwing() {
    if (!this.state.swing) return null;
    this.state.swing = false;
    return {
      face: this.state.face,
      faceDot: this.state.faceDot,
      forwardAccel: Math.max(this.state.forwardAccel, this.state.rawForwardAccel),
      quality: this.state.hitQuality,
      rotRate: this.state.rotRate,
      t: performance.now()
    };
  }
}
