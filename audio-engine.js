function clamp(x,a,b){return Math.max(a,Math.min(b,x));}

export class AudioEngine {
  constructor(){this.ctx=null;this.master=null;this.ambient=null;this.current=null;}
  async init(){
    if(this.ctx){if(this.ctx.state==='suspended') await this.ctx.resume();return;}
    const C=window.AudioContext||window.webkitAudioContext;
    if(!C)throw new Error('Web Audio is not supported on this browser.');
    this.ctx=new C();
    this.master=this.ctx.createGain(); this.master.gain.value=.72; this.master.connect(this.ctx.destination);
  }
  stereoTest(){
    if(!this.ctx)throw new Error('Audio not initialized');
    this._tone(-1,480,0.45,0.28); setTimeout(()=>this._tone(1,760,0.45,0.28),700);
  }
  _tone(pan,freq,dur,gain){
    const t=this.ctx.currentTime;
    const osc=this.ctx.createOscillator(), g=this.ctx.createGain(), p=this.ctx.createStereoPanner();
    osc.frequency.value=freq; g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(gain,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+dur);
    p.pan.value=pan; osc.connect(g).connect(p).connect(this.master);osc.start(t);osc.stop(t+dur+.03);
  }
  ballApproach(side,duration=1900){
    this.stopApproach();
    const t=this.ctx.currentTime, p=this.ctx.createStereoPanner(), g=this.ctx.createGain(), filter=this.ctx.createBiquadFilter(), osc=this.ctx.createOscillator();
    p.pan.value=side==='left'?-0.88:0.88; filter.type='bandpass';filter.frequency.value=1500;filter.Q.value=.75;
    g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.035,t+.18);g.gain.exponentialRampToValueAtTime(.18,t+duration/1000*.72);g.gain.exponentialRampToValueAtTime(.8,t+duration/1000);
    osc.type='sawtooth';osc.frequency.setValueAtTime(95,t);osc.frequency.exponentialRampToValueAtTime(340,t+duration/1000); osc.detune.value=side==='left'?-4:4;
    const noise=this.ctx.createBufferSource(); const buf=this.ctx.createBuffer(1,this.ctx.sampleRate*.8,this.ctx.sampleRate); const data=buf.getChannelData(0);
    for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/data.length,1.4);
    noise.buffer=buf; const ng=this.ctx.createGain();ng.gain.setValueAtTime(.0001,t);ng.gain.exponentialRampToValueAtTime(.05,t+duration/1000*.65);ng.gain.exponentialRampToValueAtTime(.52,t+duration/1000);
    noise.connect(ng).connect(filter);
    osc.connect(filter).connect(g).connect(p).connect(this.master); noise.start(t); osc.start(t); osc.stop(t+duration/1000+.03);
    this.current={stop:()=>{try{noise.stop()}catch{} try{osc.stop()}catch{}}};
    return duration;
  }
  stopApproach(){if(this.current){this.current.stop();this.current=null;}}
  hit(side,quality=0.7){
    this.stopApproach();
    const t=this.ctx.currentTime, pan=side==='left'?-0.84:0.84;
    // Tennis-ball strike: short noisy felt contact + low resonant body thump.
    const noise=this.ctx.createBufferSource();const buf=this.ctx.createBuffer(1,this.ctx.sampleRate*.15,this.ctx.sampleRate);const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.exp(-i/this.ctx.sampleRate/.032); noise.buffer=buf;
    const ng=this.ctx.createGain(), np=this.ctx.createStereoPanner();np.pan.value=pan;ng.gain.setValueAtTime(.45+.45*quality,t);ng.gain.exponentialRampToValueAtTime(.0001,t+.11);
    noise.connect(ng).connect(np).connect(this.master);noise.start(t);
    const o=this.ctx.createOscillator(),og=this.ctx.createGain(),op=this.ctx.createStereoPanner();op.pan.value=pan; o.type='sine';o.frequency.setValueAtTime(145,t);o.frequency.exponentialRampToValueAtTime(72,t+.16);og.gain.setValueAtTime(.12+.12*quality,t);og.gain.exponentialRampToValueAtTime(.0001,t+.18);o.connect(og).connect(op).connect(this.master);o.start(t);o.stop(t+.2);
  }
  miss(){ this._tone(0,130,0.18,.12); }
}
