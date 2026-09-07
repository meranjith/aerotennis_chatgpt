# AeroTennis

A mobile-first blind tennis prototype: no ball or direction is rendered during play. The phone is treated as the racket handle, and the player reacts to stereo audio plus motion sensing.

## Physical convention implemented

- Hold the phone horizontally in the **right hand**.
- **Ball from the right** → forehand → the **screen (Side A)** must face forward while the hand pushes the phone forward.
- **Ball from the left** → backhand → the wrist flips naturally, the **screen faces the player**, the **back panel (Side B)** faces forward, and the player pushes forward.
- The sensor engine calibrates the player's neutral **screen-forward** direction and then evaluates both the phone face orientation and forward acceleration at the swing peak.
- A hit is accepted only inside a timed impact window and only when the correct face is forward. Wrong face = `MISS - WRONG SIDE`.

## Architecture

- `public/motion-engine.js`: device orientation + motion fusion, calibration, face classification, acceleration peak detection.
- `public/game-logic.js`: tennis point/game scoring and server switching.
- `public/app.js`: spatial audio, gameplay state, WebRTC data channel, lobby flow, practice wall mode.
- `server.js`: only signaling/matchmaking. Game state travels peer-to-peer after WebRTC connects.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000` on two mobile devices. For actual mobile sensor permissions, deploy the same app behind **HTTPS**. Safari/iOS and other browsers may require the motion permission request to be triggered by a user gesture.

## Important reality checks

1. WebRTC gives the game a peer-to-peer data path, but **zero latency cannot be guaranteed**. Internet RTT still exists, and some networks require TURN relay. This prototype uses STUN and falls back to the WebRTC connection machinery; production deployment should add a TURN service.
2. Browsers do not expose a universally reliable "headphones physically connected" flag. AeroTennis therefore uses a left/right listening test and blocks game controls until the player confirms stereo separation.
3. The Web Audio ball sound is generated procedurally, so there are no copyrighted sample files bundled. For a production release, replace the generated layer with properly licensed real tennis-ball recordings while keeping the same panning/envelope logic.
4. Mobile sensor hardware and browser coordinate conventions vary. The calibration step is mandatory because the game cares about the **player's chosen forward direction**, not magnetic north.
