const RAD = Math.PI / 180;
const EPS = 1e-9;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const length = v => Math.hypot(v.x, v.y, v.z);
const normalize = v => {
  const n = length(v);
  return n > EPS ? {x:v.x/n,y:v.y/n,z:v.z/n} : {x:0,y:0,z:0};
};
const sub = (a,b) => ({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});

function qNormalize(q){
  const n=Math.hypot(q.x,q.y,q.z,q.w)||1;
  return {x:q.x/n,y:q.y/n,z:q.z/n,w:q.w/n};
}
function qMul(a,b){
  return {
    w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z,
    x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
    y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w
  };
}
function qInverse(q){return {x:-q.x,y:-q.y,z:-q.z,w:q.w};}
function qRotate(q,v){
  const p={x:v.x,y:v.y,z:v.z,w:0};
  const r=qMul(qMul(q,p),qInverse(q));
  return {x:r.x,y:r.y,z:r.z};
}
function qFromAxisAngle(ax,ay,az,angle){
  const s=Math.sin(angle/2),c=Math.cos(angle/2);
  return qNormalize({x:ax*s,y:ay*s,z:az*s,w:c});
}

// DeviceOrientation's alpha/beta/gamma angles are intrinsic rotations.
// This follows the well-tested DeviceOrientationControls ordering used by
// three.js: YXZ + device-to-screen correction + screen orientation correction.
function qFromDeviceOrientation(alphaDeg,betaDeg,gammaDeg,screenAngleDeg){
  const x=(betaDeg||0)*RAD;
  const y=(alphaDeg||0)*RAD;
  const z=-(gammaDeg||0)*RAD;

  // Quaternion for Euler order YXZ.
  const cy=Math.cos(y/2), sy=Math.sin(y/2);
  const cx=Math.cos(x/2), sx=Math.sin(x/2);
  const cz=Math.cos(z/2), sz=Math.sin(z/2);
  let q={
    w:cy*cx*cz + sy*sx*sz,
    x:cy*sx*cz + sy*cx*sz,
    y:sy*cx*cz - cy*sx*sz,
    z:cy*cx*sz - sy*sx*cz
  };

  // Match the phone/device coordinate convention used by the browser.
  q=qMul(q,qFromAxisAngle(1,0,0,-Math.PI/2));
  q=qMul(q,qFromAxisAngle(0,0,1,-(screenAngleDeg||0)*RAD));
  return qNormalize(q);
}

function qFromAngularVelocity(alphaDeg,betaDeg,gammaDeg,dt){
  // DeviceMotion rotationRate axes: alpha=Z, beta=X, gamma=Y.
  const wx=(betaDeg||0)*RAD*dt;
  const wy=(gammaDeg||0)*RAD*dt;
  const wz=(alphaDeg||0)*RAD*dt;
  const angle=Math.hypot(wx,wy,wz);
  if(angle<EPS)return {x:0,y:0,z:0,w:1};
  const s=Math.sin(angle/2)/angle;
  return qNormalize({x:wx*s,y:wy*s,z:wz*s,w:Math.cos(angle/2)});
}

export class MotionEngine{
  constructor(){
    this.listeners=new Set();
    this.state={
      ready:false, calibrated:false, face:'unknown', faceDot:0,
      forwardAccel:0, rawForwardAccel:0, lateralAccel:0,
      rotRate:0, confidence:0, swing:false, hitQuality:0,
      orientation:{}, accel:{x:0,y:0,z:0}, source:'none', sampleHz:0
    };

    this.currentQ=null;
    this.referenceQ=null;
    this.gyroQ={x:0,y:0,z:0,w:1};
    this.lastGyroT=0;
    this.gyroSamples=0;
    this.lastOrientationQ=null;
    this.lastOrientationT=0;
    this.lastMotionT=0;
    this.lastSwingT=-Infinity;
    this.lastEmitT=0;
    this.screenAngle=0;
    this.referenceScreenAngle=0;
    this.running=false;

    this.gravityEstimate={x:0,y:0,z:0};
    this.filteredForward=0;
    this.filteredLateral=0;
    this.prevForward=0;
    this.prev2Forward=0;
    this.prevT=0;
    this.prev2T=0;
    this.motionBuffer=[];
    this.peakCandidate=null;

    // The detector works on a short physical stroke, not one magic sample.
    this.triggerAccel=2.8;
    this.strongAccel=4.8;
    this.peakDrop=0.65;
    this.maxPeakAgeMs=190;
    this.minCooldownMs=300;
  }

  on(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  emit(){for(const fn of this.listeners) fn(this.state);}

  static supports(){
    return typeof window!=='undefined' &&
      'DeviceOrientationEvent' in window && 'DeviceMotionEvent' in window;
  }

  async requestPermission(){
    const requests=[];
    if(typeof DeviceMotionEvent!=='undefined' && typeof DeviceMotionEvent.requestPermission==='function') requests.push(DeviceMotionEvent.requestPermission());
    if(typeof DeviceOrientationEvent!=='undefined' && typeof DeviceOrientationEvent.requestPermission==='function') requests.push(DeviceOrientationEvent.requestPermission());
    if(requests.length){
      const results=await Promise.all(requests);
      if(results.some(v=>v!=='granted')) throw new Error('Motion/orientation permission was denied.');
    }
    await this.start();
  }

  async start(){
    if(this.running)return;
    this.running=true;
    this.updateScreenAngle();
    window.addEventListener('orientationchange',this.updateScreenAngle,{passive:true});
    window.addEventListener('deviceorientation',this.onOrientation,{passive:true});
    window.addEventListener('deviceorientationabsolute',this.onOrientation,{passive:true});
    window.addEventListener('devicemotion',this.onMotion,{passive:true});
    this.state.ready=true;
    this.emit();
  }

  stop(){
    this.running=false;
    window.removeEventListener('orientationchange',this.updateScreenAngle);
    window.removeEventListener('deviceorientation',this.onOrientation);
    window.removeEventListener('deviceorientationabsolute',this.onOrientation);
    window.removeEventListener('devicemotion',this.onMotion);
  }

  updateScreenAngle=()=>{
    this.screenAngle=Number(window.screen?.orientation?.angle ?? window.orientation ?? 0)||0;
  };

  onOrientation=(e)=>{
    const a=Number(e.alpha),b=Number(e.beta),g=Number(e.gamma);
    if(!Number.isFinite(a)||!Number.isFinite(b)||!Number.isFinite(g))return;
    this.updateScreenAngle();
    const q=qFromDeviceOrientation(a,b,g,this.screenAngle);
    const now=performance.now();
    if(this.lastOrientationQ){
      const dt=Math.max(0.005,(now-this.lastOrientationT)/1000);
      const dq=qMul(qInverse(this.lastOrientationQ),q);
      const angle=2*Math.acos(clamp(Math.abs(dq.w),0,1));
      this.state.rotRate=angle/dt;
    }
    this.currentQ=q;
    this.lastOrientationQ=q;
    this.lastOrientationT=now;
    this.state.orientation={alpha:a,beta:b,gamma:g,absolute:Boolean(e.absolute)};
    this.updateRelativeOrientation();
    this.emit();
  };

  updateRelativeOrientation(){
    if(!this.referenceQ||!this.currentQ)return;
    // Primary pose tracker is the integrated gyroscope. This is intentionally
    // relative to the calibration pose, which makes it behave like a handheld
    // motion controller and avoids relying on compass/world-heading stability.
    const poseQ=this.gyroSamples>2?this.gyroQ:qMul(qInverse(this.referenceQ),this.currentQ);
    const screenNormal=qRotate(poseQ,{x:0,y:0,z:1});
    const d=clamp(screenNormal.z,-1,1);
    this.state.faceDot=d;

    if(this.state.face==='screen'){
      if(d<0.25)this.state.face=d<=-0.25?'back':'edge';
    }else if(this.state.face==='back'){
      if(d>-0.25)this.state.face=d>=0.25?'screen':'edge';
    }else{
      if(d>=0.45)this.state.face='screen';
      else if(d<=-0.45)this.state.face='back';
      else this.state.face='edge';
    }
    this.state.confidence=Math.round(Math.abs(d)*100);
  }

  getLinearAcceleration(e,dt){
    const direct=e.acceleration;
    if(direct&&[direct.x,direct.y,direct.z].every(Number.isFinite)){
      const v={x:Number(direct.x),y:Number(direct.y),z:Number(direct.z)};
      this.state.source='linear';
      return v;
    }

    const raw=e.accelerationIncludingGravity;
    if(!raw||![raw.x,raw.y,raw.z].every(Number.isFinite))return null;
    const v={x:Number(raw.x),y:Number(raw.y),z:Number(raw.z)};
    // Slow gravity estimator: fast enough for posture changes, slow enough not
    // to eat the short impulse of a tennis stroke.
    const alpha=clamp(dt/0.65,0.008,0.09);
    this.gravityEstimate={
      x:this.gravityEstimate.x+alpha*(v.x-this.gravityEstimate.x),
      y:this.gravityEstimate.y+alpha*(v.y-this.gravityEstimate.y),
      z:this.gravityEstimate.z+alpha*(v.z-this.gravityEstimate.z)
    };
    this.state.source='gravity-subtracted';
    return sub(v,this.gravityEstimate);
  }

  onMotion=(e)=>{
    if(!this.currentQ||!this.referenceQ)return;
    const now=performance.now();
    const dt=this.lastMotionT?clamp((now-this.lastMotionT)/1000,0.008,0.08):0.016;
    this.lastMotionT=now;
    this.state.sampleHz=Math.round(1/dt);

    const any=e.acceleration||e.accelerationIncludingGravity;
    if(any&&[any.x,any.y,any.z].every(Number.isFinite))
      this.state.accel={x:Number(any.x),y:Number(any.y),z:Number(any.z)};

    const rr=e.rotationRate;
    if(rr && [rr.alpha,rr.beta,rr.gamma].every(Number.isFinite)){
      const dq=qFromAngularVelocity(rr.alpha,rr.beta,rr.gamma,dt);
      this.gyroQ=qNormalize(qMul(this.gyroQ,dq));
      this.gyroSamples++;
      this.lastGyroT=now;
    }

    const linear=this.getLinearAcceleration(e,dt);
    if(!linear)return;

    const trackerQ=this.gyroSamples>2?this.gyroQ:qMul(qInverse(this.referenceQ),this.currentQ);
    const calAccel=qRotate(trackerQ,linear);
    const rawF=calAccel.z;
    const lateral=Math.hypot(calAccel.x,calAccel.y);

    const fa=clamp(dt/0.04,0.10,0.45);
    this.filteredForward += fa*(rawF-this.filteredForward);
    this.filteredLateral += fa*(lateral-this.filteredLateral);
    this.state.forwardAccel=this.filteredForward;
    this.state.rawForwardAccel=rawF;
    this.state.lateralAccel=this.filteredLateral;
    this.updateRelativeOrientation();

    const sample={t:now,f:this.filteredForward,raw:rawF,lat:this.filteredLateral,faceDot:this.state.faceDot,face:this.state.face,rot:this.state.rotRate};
    this.motionBuffer.push(sample);
    while(this.motionBuffer.length&&now-this.motionBuffer[0].t>280)this.motionBuffer.shift();

    // Detect a peak. We intentionally timestamp the actual peak sample rather
    // than the later threshold-crossing callback, which fixes timing drift.
    const prev=this.prevForward;
    const prev2=this.prev2Forward;
    const isRise=prev>prev2;
    const crossed=prev>=this.triggerAccel || prev>=this.strongAccel;
    const dropped=(prev-this.filteredForward)>=this.peakDrop;

    if(isRise&&crossed){
      this.peakCandidate={t:this.prevT,f:prev,faceDot:this.prevFaceDot,face:this.prevFace,rot:this.prevRot};
    }

    if(this.peakCandidate){
      const age=now-this.peakCandidate.t;
      if(age>=0&&age<=this.maxPeakAgeMs&&dropped){
        this.detectPeak(this.peakCandidate);
        this.peakCandidate=null;
      }else if(age>this.maxPeakAgeMs){
        this.peakCandidate=null;
      }
    }

    this.prev2Forward=prev;
    this.prevForward=this.filteredForward;
    this.prev2T=this.prevT;
    this.prevT=now;
    this.prevFaceDot=this.state.faceDot;
    this.prevFace=this.state.face;
    this.prevRot=this.state.rotRate;

    this.emit();
  };

  detectPeak(peak){
    const now=performance.now();
    if(now-this.lastSwingT<this.minCooldownMs)return;

    // Reject obvious sideways bumps. A real stroke must have a substantial
    // forward component relative to the lateral component.
    const ratio=Math.max(0,peak.f)/(Math.abs(peak.f)+Math.max(0,peak.lat)+0.001);
    if(peak.f<this.triggerAccel&&ratio<0.52)return;

    this.lastSwingT=peak.t;
    this.state.swing=true;
    const magnitude=clamp((peak.f-2.0)/7.0,0,1);
    const faceScore=clamp(Math.abs(peak.faceDot),0,1);
    const rotScore=clamp((peak.rot||0)/2.0,0,1);
    this.state.hitQuality=clamp(0.62*magnitude+0.28*faceScore+0.10*rotScore,0,1);
    this.state.faceDot=peak.faceDot;
    this.state.face=peak.face;
    this.emit();
    setTimeout(()=>{
      if(performance.now()-this.lastSwingT>90){
        this.state.swing=false;
        this.emit();
      }
    },100);
  }

  calibrate(){
    if(!this.currentQ)throw new Error('No orientation sample yet. Hold the phone still and try again.');
    this.referenceQ=qNormalize({...this.currentQ});
    this.gyroQ={x:0,y:0,z:0,w:1};
    this.gyroSamples=0;
    this.lastGyroT=performance.now();
    this.referenceScreenAngle=this.screenAngle;
    this.state.calibrated=true;
    this.state.face='screen';
    this.state.faceDot=1;
    this.state.confidence=100;
    this.filteredForward=0;
    this.filteredLateral=0;
    this.prevForward=0;
    this.prev2Forward=0;
    this.prevT=0;
    this.prevFaceDot=1;
    this.prevFace='screen';
    this.prevRot=0;
    this.peakCandidate=null;
    this.motionBuffer=[];
    this.gravityEstimate={x:0,y:0,z:0};
    this.lastSwingT=-Infinity;
    this.emit();
  }

  consumeSwing(){
    if(!this.state.swing)return null;
    this.state.swing=false;
    return {
      face:this.state.face,
      faceDot:this.state.faceDot,
      forwardAccel:this.state.forwardAccel,
      quality:this.state.hitQuality,
      rotRate:this.state.rotRate,
      t:this.lastSwingT
    };
  }
}
