import { RacketSensor } from './motion-engine.js';
import { formatGameScore, newMatchState, registerPoint, nextServiceSide } from './game-logic.js';

const $ = id => document.getElementById(id);
const screens = ['home','lobby','calibrate','game','result'].reduce((o,id) => (o[id] = $(id), o), {});

const state = {
  ws: null,
  pc: null,
  dc: null,
  role: null,
  roomCode: null,
  connected: false,
  audioReady: false,
  calibrationReady: false,
  match: newMatchState(),
  pointSerial: 0,
  currentTarget: null,
  wallMode: false,
  matchActive: false,
  wakeLock: null,
  gameClock: performance.now(),
  netClockOffset: 0,
  reconnectTimer: null,
  audioCtx: null,
  audioBus: null,
  panner: null,
  lastAnnounce: 0,
  userActive: false,
  sensorPermissionReady: false,
  remoteReady: false,
  localReady: false,
  started: false,
  handledPointEnds: new Set()
};

let sensor = null;

function show(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function setMicroStatus(text) {
  $('audioTestStatus').textContent = text;
}

function safeDecodeJson(data) {
  try { return JSON.parse(data); } catch { return null; }
}

function randomId() {
  return crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function nowMs() {
  return performance.now() + state.netClockOffset;
}

async function keepScreenAwake() {
  if (!('wakeLock' in navigator)) return false;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    return true;
  } catch {
    return false;
  }
}

async function tryReacquireWakeLock() {
  if (state.matchActive && document.visibilityState === 'visible' && !state.wakeLock) {
    await keepScreenAwake();
  }
}

document.addEventListener('visibilitychange', tryReacquireWakeLock);

async function lockLandscape() {
  try { await screen.orientation?.lock?.('landscape'); } catch { /* browser may disallow */ }
}

function createAudioContext() {
  if (state.audioCtx) return state.audioCtx;
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  state.audioCtx = ctx;
  state.audioBus = ctx.createGain();
  state.audioBus.gain.value = 0.84;
  state.panner = ctx.createStereoPanner();
  state.panner.pan.value = 0;
  state.audioBus.connect(state.panner).connect(ctx.destination);
  return ctx;
}

function noiseBuffer(ctx, duration = 1.0) {
  const len = Math.floor(ctx.sampleRate * duration);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    // Slightly correlated noise has more "air" than raw white noise.
    const white = Math.random() * 2 - 1;
    last = last * 0.93 + white * 0.07;
    ch[i] = last * 5;
  }
  return buf;
}

function playTone(time, freq, duration, gain, pan = 0, type='sine') {
  const ctx = state.audioCtx;
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const p = ctx.createStereoPanner();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  osc.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.48), time + duration);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(gain, time + Math.min(0.008, duration * 0.14));
  g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  p.pan.setValueAtTime(pan, time);
  osc.connect(g).connect(p).connect(state.audioBus);
  osc.start(time);
  osc.stop(time + duration + .02);
}

function playBallApproach(side, durationMs = 1450) {
  const ctx = createAudioContext();
  const start = ctx.currentTime + 0.015;
  const duration = durationMs / 1000;
  const pan = side === 'left' ? -0.95 : 0.95;

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, duration + 0.08);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.setValueAtTime(500, start);
  band.frequency.exponentialRampToValueAtTime(2600, start + duration);
  band.Q.value = 0.65;
  const high = ctx.createBiquadFilter();
  high.type = 'highpass';
  high.frequency.value = 180;
  const gain = ctx.createGain();
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.13, start + duration * 0.45);
  gain.gain.exponentialRampToValueAtTime(0.95, start + duration * 0.88);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(high).connect(band).connect(gain).connect(p).connect(state.audioBus);
  src.start(start);
  src.stop(start + duration + .02);

  // The ball itself: a sequence of tiny pressure/impact pulses, accelerating near the listener.
  for (let i = 0; i < 4; i += 1) {
    const progress = 0.32 + i * 0.17;
    const pulseAt = start + duration * progress;
    playTone(pulseAt, 280 + i*42, 0.045, 0.018 + i*0.007, pan, 'triangle');
  }
  return start + duration;
}

function playImpact(side, quality = 'hit') {
  const ctx = createAudioContext();
  const t = ctx.currentTime + 0.005;
  const pan = side === 'left' ? -0.95 : 0.95;
  const click = ctx.createOscillator();
  const body = ctx.createOscillator();
  const clickG = ctx.createGain();
  const bodyG = ctx.createGain();
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  click.type = 'square';
  click.frequency.setValueAtTime(1600, t);
  click.frequency.exponentialRampToValueAtTime(520, t + .035);
  clickG.gain.setValueAtTime(quality === 'hit' ? .22 : .13, t);
  clickG.gain.exponentialRampToValueAtTime(.0001, t + .055);
  body.type = 'sine';
  body.frequency.setValueAtTime(210, t);
  body.frequency.exponentialRampToValueAtTime(95, t + .12);
  bodyG.gain.setValueAtTime(quality === 'hit' ? .38 : .22, t);
  bodyG.gain.exponentialRampToValueAtTime(.0001, t + .16);
  click.connect(clickG).connect(p);
  body.connect(bodyG).connect(p);
  p.connect(state.audioBus);
  click.start(t); body.start(t);
  click.stop(t + .07); body.stop(t + .17);
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.06;
  utterance.pitch = 0.92;
  utterance.volume = 0.72;
  speechSynthesis.speak(utterance);
}

async function audioEnable() {
  const ctx = createAudioContext();
  await ctx.resume();
  // Request motion/orientation permission from the same explicit user gesture.
  if (!sensor) {
    sensor = new RacketSensor({
      onStatus: text => $('sensorStatus').textContent = text,
      onHit: result => onLocalSensorResult(result),
      onDebug: d => {
        if (!$('debugReadout').classList.contains('hidden')) $('debugReadout').textContent = JSON.stringify(d);
      }
    });
  }
  const motionAllowed = await sensor.requestPermission();
  if (!motionAllowed) {
    setMicroStatus('Motion permission is required for racket control.');
    return;
  }
  state.sensorPermissionReady = true;
  // Listening test. Browser APIs cannot universally and reliably prove a physical headset is connected.
  setMicroStatus('Listen: LEFT tone → RIGHT tone. Both must be clearly separated.');
  playTone(ctx.currentTime + .05, 540, .28, .22, -1, 'sine');
  playTone(ctx.currentTime + .44, 540, .28, .22, 1, 'sine');
  const passed = window.confirm('Did you hear the first tone in the LEFT ear and the second in the RIGHT ear?');
  if (!passed) {
    state.audioReady = false;
    setMicroStatus('Stereo test failed. Use stereo earphones/headphones.');
    return;
  }
  state.audioReady = true;
  setMicroStatus('Stereo audio verified.');
  $('createBtn').disabled = false;
  $('joinBtn').disabled = false;
  $('practiceBtn').disabled = false;
  await lockLandscape();
}

function connectSignal() {
  if (state.ws && state.ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/signal`);
  state.ws.onopen = () => { setLobbyStatus('Connected to match service.'); };
  state.ws.onclose = () => {
    state.ws = null;
    if (state.matchActive) setConnection('● SIGNAL LOST');
  };
  state.ws.onerror = () => { setLobbyStatus('Cannot reach match service.'); };
  state.ws.onmessage = event => {
    const msg = safeDecodeJson(event.data);
    if (!msg) return;
    handleSignalMessage(msg);
  };
}

function wsSend(message) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
}

function setLobbyStatus(text) { $('lobbyStatus').textContent = text; }
function setConnection(text) { $('gameConnection').textContent = text; }

function makePeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: [
      {urls: ['stun:stun.l.google.com:19302']},
      {urls: ['stun:stun.cloudflare.com:3478']}
    ],
    bundlePolicy: 'max-bundle'
  });
  state.pc = pc;
  pc.onicecandidate = e => { if (e.candidate) wsSend({type:'signal', data:{kind:'ice', candidate:e.candidate}}); };
  pc.onconnectionstatechange = () => {
    const status = pc.connectionState;
    setConnection(`● ${status.toUpperCase()}`);
    if (status === 'connected') {
      state.connected = true;
      syncClock();
    }
    if (['failed','closed'].includes(status)) state.connected = false;
  };
  pc.ondatachannel = e => setupDataChannel(e.channel);
  return pc;
}

function setupDataChannel(dc) {
  state.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    state.connected = true;
    setConnection('● PEER CONNECTED');
    if (state.role === 'guest') {
      sendGameHello();
      if (!state.matchActive) { state.matchActive = true; beginCalibrationFlow(); }
    }
  };
  dc.onclose = () => { state.connected = false; setConnection('● PEER DISCONNECTED'); };
  dc.onerror = () => { setConnection('● DATA ERROR'); };
  dc.onmessage = e => {
    const msg = safeDecodeJson(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
    if (msg) handleGameMessage(msg);
  };
}

function sendDC(message) {
  if (state.dc?.readyState === 'open') state.dc.send(JSON.stringify(message));
}

async function handleSignalMessage(msg) {
  switch (msg.type) {
    case 'room-created':
      state.roomCode = msg.code;
      state.role = 'host';
      $('roomCode').textContent = msg.code;
      show('lobby');
      break;
    case 'room-joined':
      state.roomCode = msg.code;
      state.role = 'guest';
      $('roomCode').textContent = msg.code;
      show('lobby');
      setLobbyStatus('Joined. Waiting for host connection…');
      break;
    case 'peer-joined':
      await makeOffer();
      break;
    case 'signal':
      await handleRTCSignal(msg.data);
      break;
    case 'peer-left':
      setLobbyStatus('Opponent disconnected.');
      state.connected = false;
      if (state.matchActive) endMatch('OPPONENT LEFT');
      break;
    case 'error':
      alert(msg.message || 'Match service error');
      break;
  }
}

async function makeOffer() {
  const pc = makePeerConnection();
  const dc = pc.createDataChannel('game', {ordered: false, maxRetransmits: 0});
  setupDataChannel(dc);
  const offer = await pc.createOffer({offerToReceiveAudio:false, offerToReceiveVideo:false});
  await pc.setLocalDescription(offer);
  wsSend({type:'signal', data:{kind:'offer', sdp:pc.localDescription}});
  setLobbyStatus('Opponent invited. Establishing direct connection…');
}

async function handleRTCSignal(data) {
  let pc = state.pc;
  if (data.kind === 'offer') {
    pc = state.pc || makePeerConnection();
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({type:'signal', data:{kind:'answer', sdp:pc.localDescription}});
    setLobbyStatus('Connection answer sent.');
  } else if (data.kind === 'answer') {
    if (!pc) return;
    await pc.setRemoteDescription(data.sdp);
    setLobbyStatus('Direct connection negotiated.');
  } else if (data.kind === 'ice') {
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch { /* candidate may race on older browsers */ }
    }
  }
}

function sendGameHello() {
  sendDC({type:'hello', id:randomId(), role:state.role});
}

async function syncClock() {
  // Small application-level clock exchange. It is only used to align point-start audio,
  // not to pretend the Internet has zero latency.
  for (let i = 0; i < 4; i += 1) {
    const id = randomId();
    const t0 = performance.now();
    sendDC({type:'ping', id, t0});
    await new Promise(resolve => setTimeout(resolve, 90));
  }
}

function handleGameMessage(msg) {
  if (msg.type === 'hello') {
    if (state.role === 'host' && !state.matchActive) {
      state.remoteReady = false;
      state.matchActive = true;
      beginCalibrationFlow();
    }
  } else if (msg.type === 'ready') {
    state.remoteReady = true;
    maybeStartAfterCalibration();
  } else if (msg.type === 'ping') {
    sendDC({type:'pong', id:msg.id, t0:msg.t0, remoteNow:performance.now()});
  } else if (msg.type === 'pong') {
    const rtt = performance.now() - msg.t0;
    const estimate = msg.remoteNow + rtt / 2 - performance.now();
    state.netClockOffset = state.netClockOffset * .75 + estimate * .25;
  } else if (msg.type === 'start-point') {
    startPoint(msg);
  } else if (msg.type === 'hit-result') {
    applyRemoteHitResult(msg);
  } else if (msg.type === 'point-end') {
    if (state.handledPointEnds.has(msg.pointId)) return;
    state.handledPointEnds.add(msg.pointId);
    finishPoint(msg.winner, msg.reason, false);
  } else if (msg.type === 'match-end') {
    endMatch(msg.winner === state.localPlayer ? 'YOU WIN' : 'YOU LOSE');
  }
}

function localPlayer() {
  return state.role === 'host' ? 0 : 1;
}
Object.defineProperty(state, 'localPlayer', { get: localPlayer });

function startMatchSoon() {
  if (state.matchActive) return;
  state.matchActive = true;
  beginCalibrationFlow();
}

async function beginCalibrationFlow() {
  show('game');
  await lockLandscape();
  await keepScreenAwake();
  state.gameClock = performance.now();
  const ok = await ensureSensor();
  if (!ok) return;
  if (!state.calibrationReady) show('calibrate');
  else {
    state.localReady = true;
    sendDC({type:'ready'});
    maybeStartAfterCalibration();
  }
}

function maybeStartAfterCalibration() {
  if (!state.matchActive || !state.calibrationReady || !state.connected || state.wallMode) return;
  if (!state.localReady) return;
  // Host is authoritative for the first point. Guest waits for the host's point packet.
  if (state.role === 'host' && state.remoteReady && !state.started) {
    state.started = true;
    speak(`${scoreAnnouncement()}. ${serverAnnouncement()}`);
    schedulePointAfter(850);
  }
}

async function ensureSensor() {
  if (!sensor) {
    sensor = new RacketSensor({
      onStatus: text => $('sensorStatus').textContent = text,
      onHit: result => onLocalSensorResult(result),
      onDebug: d => {
        if (!$('debugReadout').classList.contains('hidden')) $('debugReadout').textContent = JSON.stringify(d);
      }
    });
  }
  if (!state.sensorPermissionReady) {
    const allowed = await sensor.requestPermission();
    if (!allowed) {
      alert('Motion sensors are required for AeroTennis. Use a modern mobile browser over HTTPS.');
      return false;
    }
    state.sensorPermissionReady = true;
  }
  sensor.start();
  return true;
}

async function calibrateAndStart() {
  try {
    await sensor.calibrate();
    state.calibrationReady = true;
    state.localReady = true;
    show('game');
    updateScoreUI();
    await keepScreenAwake();
    sendDC({type:'ready'});
    maybeStartAfterCalibration();
    if (state.wallMode && !state.started) {
      state.started = true;
      setTimeout(practicePoint, 700);
    }
  } catch (error) {
    $('sensorStatus').textContent = error.message || 'Calibration failed.';
  }
}

function schedulePointAfter(delay) {
  setTimeout(() => {
    if (state.matchActive) beginPoint();
  }, delay);
}

function serverAnnouncement() {
  const service = state.match.serviceSide === 0 ? 'deuce side' : 'ad side';
  return `Player ${state.match.server + 1} to serve from the ${service}`;
}

function scoreAnnouncement() {
  const a = state.match.points[0];
  const b = state.match.points[1];
  if (a >= 3 && b >= 3) {
    if (a === b) return 'Deuce';
    return `Advantage Player ${a > b ? 1 : 2}`;
  }
  const words = n => ['Love','15','30','40'][Math.min(n,3)];
  return `${words(a)} - ${words(b)}`;
}

function beginPoint() {
  if (!state.matchActive || !state.calibrationReady || !state.connected) return;
  const pointId = ++state.pointSerial;
  const side = Math.random() < 0.5 ? 'left' : 'right';
  // Give both clients the trajectory well before impact.  Each client renders its own sound locally.
  const impactDelayMs = 1650;
  const startAt = nowMs() + 300;
  const msg = {
    type:'start-point',
    pointId,
    side,
    startAt,
    impactAt:startAt + impactDelayMs,
    impactDelayMs,
    server:state.match.server,
    serviceSide:state.match.serviceSide,
    score:state.match.points,
    games:state.match.games
  };
  sendDC(msg);
  startPoint(msg);
}

function startPoint(msg) {
  state.currentTarget = msg;
  $('serverCall').textContent = msg.pointId === 1 && state.pointSerial === 1 ? `${serverAnnouncement()}` : 'RALLY';
  if (sensor) sensor.setTarget({side:msg.side, impactAt:performance.now() + (msg.impactAt - nowMs())});

  const delay = Math.max(0, msg.startAt - nowMs());
  setTimeout(() => {
    if (!state.matchActive || state.currentTarget?.pointId !== msg.pointId) return;
    playBallApproach(msg.side, msg.impactDelayMs);
  }, delay);

  setTimeout(() => {
    if (!state.matchActive || state.currentTarget?.pointId !== msg.pointId) return;
    playImpact(msg.side, 'miss');
    // If no swing was detected by the impact window, local player loses the point on this side.
    sensor?.clearTarget();
    const elapsedSide = msg.side === 'left' ? 'BACKHAND' : 'FOREHAND';
    onLocalSensorResult({type:'miss-timeout', side:msg.side, expectedFace:msg.side === 'left' ? 'back':'screen', detectedFace:'none', reason:`MISSED ${elapsedSide} TIMING`});
  }, delay + msg.impactDelayMs + 200);
}

function onLocalSensorResult(result) {
  if (!state.matchActive || !state.currentTarget) return;
  const target = state.currentTarget;
  if (result.type === 'hit') {
    playImpact(target.side, 'hit');
    showFeedback(result.side === 'left' ? 'BACKHAND' : 'FOREHAND');
    sensor?.clearTarget();
    if (state.wallMode) {
      setTimeout(practicePoint, 350);
      return;
    }
    sendDC({type:'hit-result', pointId:target.pointId, from:state.localPlayer, side:target.side, result});
    // The hitter becomes the trajectory source for the opponent after impact.
    const nextSide = Math.random() < 0.5 ? 'left' : 'right';
    const next = {type:'start-point', pointId:target.pointId + 0.5, side:nextSide, startAt:nowMs()+300, impactAt:nowMs()+1950, impactDelayMs:1650, server:state.match.server, serviceSide:state.match.serviceSide};
    sendDC(next);
    return;
  }

  if (result.type === 'miss-wrong-side') {
    playImpact(target.side, 'miss');
    showFeedback('MISS · WRONG SIDE', true);
    sensor?.clearTarget();
    if (state.wallMode) { setTimeout(practicePoint, 500); return; }
    state.handledPointEnds.add(target.pointId);
    sendDC({type:'point-end', winner:1-state.localPlayer, reason:'WRONG SIDE', pointId:target.pointId});
    finishPoint(1-state.localPlayer, 'WRONG SIDE', true);
    return;
  }

  if (result.type === 'miss-timeout') {
    showFeedback('MISS · TOO LATE', true);
    if (state.wallMode) { setTimeout(practicePoint, 500); return; }
    state.handledPointEnds.add(target.pointId);
    sendDC({type:'point-end', winner:1-state.localPlayer, reason:'TOO LATE', pointId:target.pointId});
    finishPoint(1-state.localPlayer, 'TOO LATE', true);
  }
}

function applyRemoteHitResult(msg) {
  if (msg.pointId !== state.currentTarget?.pointId) return;
  // Sender confirms it physically hit. Receiver should expect the returned ball but must not score yet.
  showFeedback('RALLY', false);
}

function finishPoint(winner, reason, localAuthority) {
  if (!state.matchActive) return;
  if (state.currentTarget) sensor?.clearTarget();
  state.currentTarget = null;
  showFeedback(winner === state.localPlayer ? 'POINT WON' : `POINT LOST · ${reason}`, winner !== state.localPlayer);

  const beforeGames = [...state.match.games];
  state.match = registerPoint(state.match, winner);
  updateScoreUI();

  if (state.match.matchWinner !== null) {
    if (localAuthority) sendDC({type:'match-end', winner:state.match.matchWinner});
    endMatch(state.match.matchWinner === state.localPlayer ? 'YOU WIN' : 'YOU LOSE');
    return;
  }

  const gameEnded = beforeGames[0] !== state.match.games[0] || beforeGames[1] !== state.match.games[1];
  if (gameEnded) {
    speak(`Game Player ${state.match.games[0] > beforeGames[0] ? 1 : 2}. ${serverAnnouncement()}`);
  } else {
    speak(`${scoreAnnouncement()}. ${serverAnnouncement()}`);
  }

  if (localAuthority) schedulePointAfter(1100);
}

function showFeedback(text, danger = false) {
  const el = $('hitFeedback');
  el.textContent = text;
  el.style.color = danger ? 'var(--danger)' : 'var(--green)';
  clearTimeout(showFeedback.timer);
  showFeedback.timer = setTimeout(() => { el.textContent = ''; }, 550);
}

function updateScoreUI() {
  $('p1Score').textContent = scoreText(state.match.points[0]);
  $('p2Score').textContent = scoreText(state.match.points[1]);
  $('player1Label').textContent = `PLAYER 1 · ${state.match.games[0]}`;
  $('player2Label').textContent = `PLAYER 2 · ${state.match.games[1]}`;
  $('serverCall').textContent = serverAnnouncement();
}

function scoreText(n) {
  const a = state.match.points[0], b = state.match.points[1];
  if (a >= 3 && b >= 3) {
    if (a === b) return 'DEUCE';
    if (n === Math.max(a,b)) return 'ADV';
    return '40';
  }
  return ['LOVE','15','30','40'][Math.min(n,3)];
}

function endMatch(text) {
  state.matchActive = false;
  sensor?.clearTarget();
  if (state.wakeLock) state.wakeLock.release().catch(()=>{});
  state.wakeLock = null;
  $('winnerText').textContent = text;
  $('finalScore').textContent = `${state.match.games[0]} — ${state.match.games[1]}`;
  show('result');
}

function startPractice() {
  state.wallMode = true;
  state.role = 'host';
  state.roomCode = null;
  state.connected = true;
  state.matchActive = true;
  show('calibrate');
  ensureSensor().then(() => {
    $('sensorStatus').textContent = 'Practice mode: calibrate once, then the wall will throw random sides.';
    if (state.calibrationReady) { state.localReady = true; state.started = true; setTimeout(practicePoint, 700); }
  });
}

function practicePoint() {
  if (!state.matchActive || !state.wallMode) return;
  const side = Math.random() < 0.5 ? 'left' : 'right';
  const msg = {pointId:++state.pointSerial, side, startAt:nowMs()+250, impactAt:nowMs()+1900, impactDelayMs:1650};
  startPoint(msg);
  setTimeout(() => {
    if (state.matchActive && state.wallMode && !state.currentTarget) practicePoint();
  }, 2600);
}

function createMatch() {
  connectSignal();
  const wait = () => {
    if (state.ws?.readyState === WebSocket.OPEN) wsSend({type:'create-room'});
    else setTimeout(wait, 80);
  };
  wait();
}

function joinMatch() {
  const code = $('roomInput').value.trim();
  if (!/^\d{6}$/.test(code)) { alert('Enter the 6-digit match code.'); return; }
  connectSignal();
  const wait = () => {
    if (state.ws?.readyState === WebSocket.OPEN) wsSend({type:'join-room', code});
    else setTimeout(wait, 80);
  };
  wait();
}

function resetForAgain() {
  state.match = newMatchState();
  state.pointSerial = 0;
  state.matchActive = false;
  state.localReady = false;
  state.remoteReady = false;
  state.started = false;
  state.handledPointEnds.clear();
  state.calibrationReady = !!state.wallMode ? state.calibrationReady : false;
  show('home');
}

$('audioTestBtn').addEventListener('click', audioEnable);
$('createBtn').addEventListener('click', createMatch);
$('joinBtn').addEventListener('click', () => $('joinRow').classList.toggle('hidden'));
$('confirmJoinBtn').addEventListener('click', joinMatch);
$('practiceBtn').addEventListener('click', startPractice);
$('calibrateBtn').addEventListener('click', async () => { await calibrateAndStart(); });
$('copyCodeBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.roomCode); setLobbyStatus('Code copied.'); } catch { setLobbyStatus('Copy failed — read the code above.'); }
});
$('endMatchBtn').addEventListener('click', () => {
  state.matchActive = false;
  sensor?.clearTarget();
  wsSend({type:'leave'});
  endMatch('MATCH ENDED');
});
$('againBtn').addEventListener('click', resetForAgain);

window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'd') $('debugReadout').classList.toggle('hidden');
});

// Handle the user's requested physical convention explicitly in visible copy.
document.querySelector('.calibration-steps').innerHTML = '1 · SCREEN FORWARD &nbsp;&nbsp; 2 · HOLD STILL &nbsp;&nbsp; 3 · CALIBRATE';

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
