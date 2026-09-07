const RAD = Math.PI / 180;
const EPS = 1e-9;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dot = (a,b) => a.x*b.x + a.y*b.y + a.z*b.z;
const length = v => Math.hypot(v.x,v.y,v.z);
const normalize = v => { const n=length(v)||1; return {x:v.x/n,y:v.y/n,z:v.z/n}; };
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

// DeviceOrientation -> device-to-world quaternion.
// This follows the Y-X-Z convention used by mature browser motion-control
// implementations, then applies the device and screen orientation corrections.
function qFromDeviceOrientation(alphaDeg,betaDeg,gammaDeg,screenAngleDeg){
  const alpha=(alphaDeg||0)*RAD;
  const beta =(betaDeg||0)*RAD;
  const gamma=(gammaDeg||0)*RAD;

  const ca=Math.cos(alpha/2), sa=Math.sin(alpha/2);
  const cb=Math.cos(beta/2),  sb=Math.sin(beta/2);
  const cg=Math.cos(gamma/2), sg=Math.sin(gamma/2);

  // Euler order YXZ.
  let q={
    w:ca*cb*cg + sa*sb*sg,
    x:ca*sb*cg + sa*cb*sg,
    y:sa*cb*cg - ca*sb*sg,
    z:ca*cb*sg - sa*sb*cg
  };

  // Device camera/sensor convention correction.
  q=qMul(q,qFromAxisAngle(1,0,0,-Math.PI/2));

  // CSS screen orientation correction.
  const screen=(Number(screenAngleDeg)||0)*RAD;
  q=qMul(q,qFromAxisAngle(0,0,1,-screen));
  return qNormalize(q);
}

function finite3(v){return v && Number.isFinite(v.x)&&Number.isFinite(v.y)&&Number.isFinite(v.z);}

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
    this.referenceForwardWorld=null;
    this.referenceRightWorld=null;
    this.referenceUpWorld=null;
    this.lastOrientationQ=null;
    this.lastOrientationT=0;
    this.lastMotionT=0;
    this.lastSwingT=-Infinity;
    this.lastEmitT=0;
    this.screenAngle=0;
    this.running=false;
    this.orientationSource='none';
    this.seenAbsoluteOrientation=false;

    this.gravityEstimate={x:0,y:0,z:0};
    this.filteredForward=0;
    this.filteredLateral=0;
    this.prevForward=0;
    this.prev2Forward=0;
    this.prevT=0;
    this.prevFaceDot=1;
    this.motionBuffer=[];
    this.peakCandidate=null;

    // Physical stroke detector. These are deliberately modest because mobile
    // browsers often report different sensor ranges/sample rates.
    this.triggerAccel=1.75;
    this.strongAccel=3.25;
    this.peakDrop=0.30;
    this.maxPeakAgeMs=180;
    this.minCooldownMs=320;
  }

  on(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
  emit(){for(const fn of this.listeners)fn(this.state);}

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
      if(results.some(v=>v!=='granted'))throw new Error('Motion/orientation permission was denied.');
    }
    await this.start();
  }

  async start(){
    if(this.running)return;
    this.running=true;
    this.updateScreenAngle();
    window.addEventListener('orientationchange',this.updateScreenAngle,{passive:true});
    window.addEventListener('deviceorientationabsolute',this.onOrientationAbsolute,{passive:true});
    window.addEventListener('deviceorientation',this.onOrientation,{passive:true});
    window.addEventListener('devicemotion',this.onMotion,{passive:true});
    this.state.ready=true;
    this.emit();
  }

  stop(){
    this.running=false;
    window.removeEventListener('orientationchange',this.updateScreenAngle);
    window.removeEventListener('deviceorientationabsolute',this.onOrientationAbsolute);
    window.removeEventListener('deviceorientation',this.onOrientation);
    window.removeEventListener('devicemotion',this.onMotion);
  }

  updateScreenAngle=()=>{
    this.screenAngle=Number(window.screen?.orientation?.angle ?? window.orientation ?? 0)||0;
  };

  onOrientationAbsolute=(e)=>{
    const ok=this.applyOrientation(e,true);
    if(ok)this.seenAbsoluteOrientation=true;
  };

  onOrientation=(e)=>{
    // Once an absolute stream is available, prefer it and ignore the parallel
    // non-absolute callback so the pose does not jump between coordinate frames.
    if(this.seenAbsoluteOrientation && this.orientationSource==='absolute')return;
    this.applyOrientation(e,false);
  };

  applyOrientation(e,isAbsolute){
    const a=Number(e.alpha),b=Number(e.beta),g=Number(e.gamma);
    if(![a,b,g].every(Number.isFinite))return false;
    if(isAbsolute){
      this.orientationSource='absolute';
    }else if(this.orientationSource==='none'){
      this.orientationSource='relative';
    }else if(this.orientationSource==='absolute'){
      return false;
    }

    this.updateScreenAngle();
    const q=qFromDeviceOrientation(a,b,g,this.screenAngle);
    const now=performance.now();

    if(this.lastOrientationQ){
      const dt=Math.max(0.005,(now-this.lastOrientationT)/1000);
      const dq=qMul(qInverse(this.lastOrientationQ),q);
      const w=clamp(Math.abs(dq.w),0,1);
      this.state.rotRate=(2*Math.acos(w))/dt;
    }
    this.currentQ=q;
    this.lastOrientationQ=q;
    this.lastOrientationT=now;
    this.state.orientation={alpha:a,beta:b,gamma:g,absolute:Boolean(isAbsolute||e.absolute)};
    this.updateRelativeOrientation();
    this.emit();
    return true;
  }

  updateRelativeOrientation(){
    if(!this.referenceForwardWorld||!this.currentQ)return;

    // This is the critical controller calculation:
    // compare the CURRENT phone screen normal in world space with the
    // CALIBRATED racket-forward direction. No gyro integration is used here.
    // Therefore a 180° wrist flip remains a 180° face flip instead of drifting.
    const screenNormalWorld=qRotate(this.currentQ,{x:0,y:0,z:1});
    const d=clamp(dot(screenNormalWorld,this.referenceForwardWorld),-1,1);
    this.state.faceDot=d;

    // Hysteresis prevents noisy sensor readings around the edge from rapidly
    // toggling screen/back/screen while the player is swinging.
    if(this.state.face==='screen'){
      if(d<-0.55)this.state.face='back';
      else if(d<0.18)this.state.face='edge';
    }else if(this.state.face==='back'){
      if(d>0.55)this.state.face='screen';
      else if(d>-0.18)this.state.face='edge';
    }else{
      if(d>=0.38)this.state.face='screen';
      else if(d<=-0.38)this.state.face='back';
      else this.state.face='edge';
    }
    this.state.confidence=Math.round(Math.abs(d)*100);
  }

  getLinearAcceleration(e,dt){
    const direct=e.acceleration;
    if(direct&&[direct.x,direct.y,direct.z].every(Number.isFinite)){
      this.state.source='linear';
      return {x:Number(direct.x),y:Number(direct.y),z:Number(direct.z)};
    }

    const raw=e.accelerationIncludingGravity;
    if(!raw||![raw.x,raw.y,raw.z].every(Number.isFinite))return null;
    const v={x:Number(raw.x),y:Number(raw.y),z:Number(raw.z)};
    const alpha=clamp(dt/0.70,0.006,0.075);
    this.gravityEstimate={
      x:this.gravityEstimate.x+alpha*(v.x-this.gravityEstimate.x),
      y:this.gravityEstimate.y+alpha*(v.y-this.gravityEstimate.y),
      z:this.gravityEstimate.z+alpha*(v.z-this.gravityEstimate.z)
    };
    this.state.source='gravity-subtracted';
    return sub(v,this.gravityEstimate);
  }

  onMotion=(e)=>{
    if(!this.currentQ||!this.referenceQ||!this.referenceForwardWorld)return;
    const now=performance.now();
    const dt=this.lastMotionT?clamp((now-this.lastMotionT)/1000,0.008,0.08):0.016;
    this.lastMotionT=now;
    this.state.sampleHz=Math.round(1/dt);

    const any=e.acceleration||e.accelerationIncludingGravity;
    if(any&&[any.x,any.y,any.z].every(Number.isFinite))
      this.state.accel={x:Number(any.x),y:Number(any.y),z:Number(any.z)};

    const linear=this.getLinearAcceleration(e,dt);
    if(!linear)return;

    // Convert acceleration into the same world frame used for the calibrated
    // racket. Forward thrust remains positive both for forehand and backhand:
    // the FACE decides which stroke it is, while the WORLD thrust decides that
    // the racket actually moved toward the ball.
    const worldAccel=qRotate(this.currentQ,linear);
    const rawF=dot(worldAccel,this.referenceForwardWorld);
    const sideA=dot(worldAccel,this.referenceRightWorld);
    const sideB=dot(worldAccel,this.referenceUpWorld);
    const lateral=Math.hypot(sideA,sideB);

    const fa=clamp(dt/0.045,0.10,0.40);
    this.filteredForward += fa*(rawF-this.filteredForward);
    this.filteredLateral += fa*(lateral-this.filteredLateral);
    this.state.forwardAccel=this.filteredForward;
    this.state.rawForwardAccel=rawF;
    this.state.lateralAccel=this.filteredLateral;
    this.updateRelativeOrientation();

    const sample={
      t:now,
      f:this.filteredForward,
      raw:rawF,
      lat:this.filteredLateral,
      faceDot:this.state.faceDot,
      face:this.state.face,
      rot:this.state.rotRate
    };
    this.motionBuffer.push(sample);
    while(this.motionBuffer.length&&now-this.motionBuffer[0].t>280)this.motionBuffer.shift();

    // A stroke is detected from the SHAPE of the acceleration burst:
    // rising -> peak -> falling. It is not tied to one browser sample.
    const prev=this.prevForward;
    const prev2=this.prev2Forward;
    const isRise=prev>prev2;
    const crossed=prev>=this.triggerAccel;
    const dropped=(prev-this.filteredForward)>=this.peakDrop;

    if(isRise&&crossed){
      this.peakCandidate={
        t:this.prevT,
        f:prev,
        lat:this.prevLateral,
        faceDot:this.prevFaceDot,
        face:this.prevFace,
        rot:this.prevRot
      };
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
    this.prevT=now;
    this.prevFaceDot=this.state.faceDot;
    this.prevFace=this.state.face;
    this.prevRot=this.state.rotRate;
    this.prevLateral=this.filteredLateral;

    this.emit();
  };

  detectPeak(peak){
    const now=performance.now();
    if(now-this.lastSwingT<this.minCooldownMs)return;

    // Do not demand a huge jerk. A tennis stroke is already characterized by
    // a clear forward acceleration burst; lateral acceleration is permitted.
    if(peak.f<this.triggerAccel)return;

    this.lastSwingT=peak.t;
    this.state.swing=true;
    const magnitude=clamp((peak.f-1.5)/5.5,0,1);
    const faceScore=clamp(Math.abs(peak.faceDot),0,1);
    const rotScore=clamp((peak.rot||0)/3.5,0,1);
    this.state.hitQuality=clamp(0.65*magnitude+0.25*faceScore+0.10*rotScore,0,1);
    this.state.faceDot=peak.faceDot;
    this.state.face=peak.face;
    this.state.forwardAccel=peak.f;
    this.state.lateralAccel=peak.lat;
    this.emit();

    setTimeout(()=>{
      if(performance.now()-this.lastSwingT>90){
        this.state.swing=false;
        this.emit();
      }
    },110);
  }

  calibrate(){
    if(!this.currentQ)throw new Error('No orientation sample yet. Hold the phone still and try again.');

    this.referenceQ=qNormalize({...this.currentQ});
    this.referenceForwardWorld=normalize(qRotate(this.referenceQ,{x:0,y:0,z:1}));
    this.referenceRightWorld=normalize(qRotate(this.referenceQ,{x:1,y:0,z:0}));
    this.referenceUpWorld=normalize(qRotate(this.referenceQ,{x:0,y:1,z:0}));

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
    this.prevLateral=0;
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
      lateralAccel:this.state.lateralAccel,
      quality:this.state.hitQuality,
      rotRate:this.state.rotRate,
      t:this.lastSwingT
    };
  }
}
