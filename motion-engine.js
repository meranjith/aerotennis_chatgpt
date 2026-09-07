const RAD = Math.PI / 180;
const EPS = 1e-7;

function qNormalize(q) {
  const n = Math.hypot(q.x,q.y,q.z,q.w) || 1;
  return {x:q.x/n,y:q.y/n,z:q.z/n,w:q.w/n};
}
function qMul(a,b) {
  return {
    w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,
    x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
    y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w
  };
}
function qInv(q) { return {x:-q.x,y:-q.y,z:-q.z,w:q.w}; }
function qFromAxisAngle(ax,ay,az,angle) {
  const s=Math.sin(angle/2), c=Math.cos(angle/2);
  return qNormalize({x:ax*s,y:ay*s,z:az*s,w:c});
}
function qRotate(q,v) {
  const p={x:v.x,y:v.y,z:v.z,w:0};
  const r=qMul(qMul(q,p),qInv(q));
  return {x:r.x,y:r.y,z:r.z};
}
function norm(v) { const n=Math.hypot(v.x,v.y,v.z); return n>EPS?{x:v.x/n,y:v.y/n,z:v.z/n}:{x:0,y:0,z:0}; }
function dot(a,b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

// Relative orientation based on DeviceOrientation's alpha/beta/gamma convention.
// Calibration cancels absolute reference differences between devices/browser implementations.
function quatFromDeviceOrientation(alpha,beta,gamma,screenAngleDeg=0) {
  const a=(alpha||0)*RAD/2, b=(beta||0)*RAD/2, g=(gamma||0)*RAD/2;
  const cA=Math.cos(a), sA=Math.sin(a), cB=Math.cos(b), sB=Math.sin(b), cG=Math.cos(g), sG=Math.sin(g);
  let q={
    x:sB*cG,
    y:cB*sG,
    z:sA*cB*cG-cA*sB*sG,
    w:cA*cB*cG+sA*sB*sG
  };
  // DeviceOrientation API uses a camera-like frame; compensate for the display's portrait/landscape twist.
  q=qNormalize(qMul(qFromAxisAngle(0,0,1,-screenAngleDeg*RAD),q));
  // Rotate from device frame to a stable head-up frame.
  q=qNormalize(qMul(qFromAxisAngle(1,0,0,-Math.PI/2),q));
  return q;
}

export class MotionEngine {
  constructor() {
    this.listeners = new Set();
    this.state = { ready:false, calibrated:false, face:'unknown', forwardAccel:0, lateralAccel:0, rotRate:0, confidence:0, swing:false, hitQuality:0, orientation:{}, accel:{x:0,y:0,z:0} };
    this.currentQ=null;
    this.referenceQ=null;
    this.forward={x:0,y:0,z:1};
    this.lastT=0;
    this.lastSwingT=-Infinity;
    this.armedUntil=0;
    this.running=false;
    this.screenAngle=0;
    this.hitThreshold=9.0; // m/s^2 beyond gravity-compensated acceleration.
    this.faceThreshold=0.55;
  }
  on(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
  emit(){for(const fn of this.listeners) fn(this.state);}
  static supports(){ return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window && 'DeviceMotionEvent' in window; }
  async requestPermission(){
    const requests=[];
    if (typeof DeviceMotionEvent?.requestPermission === 'function') requests.push(DeviceMotionEvent.requestPermission());
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') requests.push(DeviceOrientationEvent.requestPermission());
    if (requests.length) {
      const r=await Promise.all(requests);
      if (r.some(v=>v!=='granted')) throw new Error('Motion/orientation permission was denied.');
    }
    await this.start();
  }
  async start(){
    if(this.running)return;
    this.running=true;
    this.screenAngle=Number(window.screen?.orientation?.angle ?? window.orientation ?? 0) || 0;
    window.addEventListener('deviceorientation',this.onOrientation,{passive:true});
    window.addEventListener('devicemotion',this.onMotion,{passive:true});
    this.state.ready=true; this.emit();
  }
  stop(){
    this.running=false;
    window.removeEventListener('deviceorientation',this.onOrientation);
    window.removeEventListener('devicemotion',this.onMotion);
  }
  onOrientation=(e)=>{
    const q=quatFromDeviceOrientation(e.alpha,e.beta,e.gamma,this.screenAngle);
    this.currentQ=q; this.state.orientation={alpha:e.alpha,beta:e.beta,gamma:e.gamma};
    if(this.referenceQ){
      const screenN=qRotate(q,{x:0,y:0,z:1});
      const d=clamp(dot(screenN,this.forward),-1,1);
      if(d>=this.faceThreshold)this.state.face='screen';
      else if(d<=-this.faceThreshold)this.state.face='back';
      else this.state.face='edge';
      this.state.confidence=Math.round(Math.abs(d)*100);
    }
    this.emit();
  };
  onMotion=(e)=>{
    const a=e.acceleration || e.accelerationIncludingGravity;
    if(!a)return;
    const local={x:Number(a.x)||0,y:Number(a.y)||0,z:Number(a.z)||0};
    this.state.accel=local;
    let world=local;
    if(this.currentQ) world=qRotate(this.currentQ,local);
    const f=this.forward;
    const fwd=dot(world,f);
    // Project out the calibrated forward axis so we can report an orthogonal component.
    const lateralVec={x:world.x-f.x*fwd,y:world.y-f.y*fwd,z:world.z-f.z*fwd};
    const lateral=Math.hypot(lateralVec.x,lateralVec.y,lateralVec.z);
    const now=performance.now();
    const dt=this.lastT?Math.max(.001,(now-this.lastT)/1000):.016;
    const prevF=this.state.forwardAccel;
    const jerk=(fwd-prevF)/dt;
    this.lastT=now;
    this.state.forwardAccel=fwd;
    this.state.lateralAccel=lateral;
    // A forward thrust is the primary event. Rotation/face comes from orientation, not a crude axis guess.
    const swingCandidate=fwd>=this.hitThreshold && Math.abs(jerk)>=120;
    if(swingCandidate && now-this.lastSwingT>180){
      this.lastSwingT=now;
      this.armedUntil=now+130;
      this.state.swing=true;
      this.state.hitQuality=clamp((fwd-this.hitThreshold)/8,0,1);
      setTimeout(()=>{if(performance.now()-this.lastSwingT>80){this.state.swing=false;this.emit();}},90);
      this.emit();
    }
    this.emit();
  };
  calibrate(){
    if(!this.currentQ) throw new Error('No orientation sample yet.');
    this.referenceQ=this.currentQ;
    // Screen normal in the calibration pose becomes the only "forward" direction used by hit detection.
    this.forward=norm(qRotate(this.referenceQ,{x:0,y:0,z:1}));
    this.state.calibrated=true;
    this.state.face='screen';
    this.state.confidence=100;
    this.emit();
  }
  consumeSwing(){
    if(!this.state.swing)return null;
    this.state.swing=false;
    return {face:this.state.face,forwardAccel:this.state.forwardAccel,quality:this.state.hitQuality,t:performance.now()};
  }
}
