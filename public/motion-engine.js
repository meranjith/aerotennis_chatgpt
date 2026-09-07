const RAD = Math.PI / 180;
const GRAVITY = 9.80665;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
const norm = a => Math.hypot(a.x, a.y, a.z);
const normalize = a => {
  const n = norm(a);
  if (!Number.isFinite(n) || n < 1e-8) return {x: 0, y: 0, z: 0};
  return {x: a.x/n, y: a.y/n, z: a.z/n};
};
const add = (a,b) => ({x:a.x+b.x, y:a.y+b.y, z:a.z+b.z});
const scale = (a,s) => ({x:a.x*s, y:a.y*s, z:a.z*s});

// DeviceOrientation uses intrinsic z-x'-y'' rotations. We construct a device->earth matrix.
function orientationMatrix(alphaDeg, betaDeg, gammaDeg) {
  const a = (alphaDeg ?? 0) * RAD;
  const b = (betaDeg ?? 0) * RAD;
  const g = (gammaDeg ?? 0) * RAD;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g);

  // This matrix maps device x/y/z to an earth-like frame consistent with the
  // Device Orientation spec convention. We use it only as a local rigid-frame
  // transform after calibration, so north-vs-relative heading is not required.
  return [
    [ca*cg - sa*sb*sg, -sa*cb, ca*sg + sa*sb*cg],
    [sa*cg + ca*sb*sg,  ca*cb, sa*sg - ca*sb*cg],
    [-cb*sg,             sb,    cb*cg]
  ];
}

function mulMatVec(m,v) {
  return {
    x: m[0][0]*v.x + m[0][1]*v.y + m[0][2]*v.z,
    y: m[1][0]*v.x + m[1][1]*v.y + m[1][2]*v.z,
    z: m[2][0]*v.x + m[2][1]*v.y + m[2][2]*v.z
  };
}

function rotateDeviceVector(v, orientation) {
  return mulMatVec(orientation, v);
}

export class RacketSensor {
  constructor({onHit, onStatus, onDebug} = {}) {
    this.onHit = onHit || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onDebug = onDebug || (() => {});
    this.orientation = null;
    this.lastMotion = 0;
    this.forwardAxis = null;
    this.calibrated = false;
    this.enabled = false;
    this.samples = [];
    this.hitLockUntil = 0;
    this.armed = false;
    this.target = null;
    this.config = {
      startAccel: 7.0,
      peakAccel: 11.0,
      minPeak: 10.0,
      impactToleranceMs: 180,
      minSwingMs: 55,
      maxSwingMs: 520,
      faceThreshold: 0.42,
      minRotationRate: 60
    };
    this.handleOrientation = this.handleOrientation.bind(this);
    this.handleMotion = this.handleMotion.bind(this);
  }

  async requestPermission() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') throw new Error('Orientation permission denied.');
      }
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const permission = await DeviceMotionEvent.requestPermission();
        if (permission !== 'granted') throw new Error('Motion permission denied.');
      }
      if (!('DeviceMotionEvent' in window) && !('ondevicemotion' in window)) {
        throw new Error('Device motion is not available on this browser.');
      }
      return true;
    } catch (error) {
      this.onStatus(error?.message || 'Motion permission failed.');
      return false;
    }
  }

  start() {
    if (this.enabled) return;
    window.addEventListener('deviceorientation', this.handleOrientation, {passive: true});
    window.addEventListener('deviceorientationabsolute', this.handleOrientation, {passive: true});
    window.addEventListener('devicemotion', this.handleMotion, {passive: true});
    this.enabled = true;
    this.onStatus('Sensors active. Hold neutral racket position.');
  }

  stop() {
    window.removeEventListener('deviceorientation', this.handleOrientation);
    window.removeEventListener('deviceorientationabsolute', this.handleOrientation);
    window.removeEventListener('devicemotion', this.handleMotion);
    this.enabled = false;
  }

  handleOrientation(e) {
    if (![e.alpha,e.beta,e.gamma].every(Number.isFinite)) return;
    this.orientation = orientationMatrix(e.alpha, e.beta, e.gamma);
  }

  getScreenNormalWorld() {
    if (!this.orientation) return null;
    // Device +z points out of the screen.
    return normalize(rotateDeviceVector({x:0,y:0,z:1}, this.orientation));
  }

  getBackNormalWorld() {
    const s = this.getScreenNormalWorld();
    return s ? scale(s, -1) : null;
  }

  calibrate(sampleMs = 900) {
    return new Promise((resolve, reject) => {
      if (!this.orientation) {
        reject(new Error('No orientation data yet. Hold the phone still for a moment.'));
        return;
      }
      const start = performance.now();
      const samples = [];
      const sample = () => {
        const s = this.getScreenNormalWorld();
        if (s) samples.push(s);
        if (performance.now() - start >= sampleMs) {
          if (samples.length < 8) {
            reject(new Error('Not enough stable sensor samples.'));
            return;
          }
          let avg = samples.reduce((a,v) => add(a,v), {x:0,y:0,z:0});
          avg = normalize(avg);
          // Calibration defines the original screen-facing direction as racket-forward.
          this.forwardAxis = avg;
          this.calibrated = true;
          this.onStatus('Calibration locked. Screen-forward = forehand. Back-panel-forward = backhand.');
          resolve(avg);
          return;
        }
        requestAnimationFrame(sample);
      };
      sample();
    });
  }

  setTarget({side, impactAt}) {
    this.target = {side, impactAt};
    this.armed = true;
  }

  clearTarget() {
    this.target = null;
    this.armed = false;
  }

  getFaceAndAlignment() {
    if (!this.forwardAxis) return {face: 'unknown', alignment: 0};
    const screen = this.getScreenNormalWorld();
    if (!screen) return {face:'unknown', alignment:0};
    const alignment = dot(screen, this.forwardAxis);
    if (alignment >= this.config.faceThreshold) return {face:'screen', alignment};
    if (alignment <= -this.config.faceThreshold) return {face:'back', alignment};
    return {face:'edge', alignment};
  }

  handleMotion(e) {
    if (!this.calibrated || !this.orientation || !this.armed) return;
    const now = performance.now();
    const raw = e.acceleration;
    const rawG = e.accelerationIncludingGravity;
    const local = raw && [raw.x,raw.y,raw.z].every(Number.isFinite)
      ? {x:raw.x,y:raw.y,z:raw.z}
      : (rawG && [rawG.x,rawG.y,rawG.z].every(Number.isFinite)
        ? {x:rawG.x,y:rawG.y,z:rawG.z}
        : null);
    if (!local) return;

    let world = rotateDeviceVector(local, this.orientation);
    if (!(raw && [raw.x,raw.y,raw.z].every(Number.isFinite))) {
      // accelerationIncludingGravity -> remove +up world gravity contribution.
      world = add(world, {x:0,y:0,z:-GRAVITY});
    }

    const forwardAccel = dot(world, this.forwardAxis);
    const magnitude = norm(world);
    const r = e.rotationRate || {};
    const rotationRate = Math.hypot(Number(r.alpha)||0, Number(r.beta)||0, Number(r.gamma)||0);
    const face = this.getFaceAndAlignment();

    this.samples.push({t: now, forwardAccel, magnitude, rotationRate, face: face.face, alignment: face.alignment});
    while (this.samples.length && now - this.samples[0].t > this.config.maxSwingMs) this.samples.shift();

    // Detect an acceleration rise first, then evaluate the actual peak/face at the
    // point of highest forward thrust. This is more stable than one-event thresholds.
    const previous = this.samples.length > 1 ? this.samples[this.samples.length - 2] : null;
    const rising = !previous || forwardAccel >= previous.forwardAccel - 1.0;
    if (forwardAccel < this.config.startAccel || !rising) {
      this.onDebug({forwardAccel, magnitude, rotationRate, face: face.face, alignment: face.alignment});
      return;
    }

    const candidate = this.samples.slice(-Math.min(8, this.samples.length)).reduce((best, sample) =>
      sample.forwardAccel > best.forwardAccel ? sample : best
    , this.samples[this.samples.length - 1]);

    if (candidate.forwardAccel < this.config.minPeak || candidate.rotationRate < this.config.minRotationRate) {
      this.onDebug({forwardAccel, magnitude, rotationRate, face: face.face, alignment: face.alignment});
      return;
    }

    if (now < this.hitLockUntil) return;

    const delta = Math.abs(candidate.t - this.target.impactAt);
    if (delta > this.config.impactToleranceMs) return;

    // Physics meaning:
    // target.side === right -> screen must face forward (forehand).
    // target.side === left  -> back must face forward (backhand).
    const expectedFace = this.target.side === 'right' ? 'screen' : 'back';
    const correctFace = candidate.face === expectedFace;
    const hit = {
      type: correctFace ? 'hit' : 'miss-wrong-side',
      side: this.target.side,
      expectedFace,
      detectedFace: candidate.face,
      alignment: candidate.alignment,
      forwardAccel: candidate.forwardAccel,
      rotationRate: candidate.rotationRate,
      impactDeltaMs: delta,
      at: candidate.t
    };
    this.hitLockUntil = now + 450;
    this.armed = false;
    this.onHit(hit);
    this.onDebug(hit);
  }
}
