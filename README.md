# AeroTennis — GitHub Pages Test Build

This is the static/mobile test build. It does **not** require Node.js on the computer.

## GitHub Pages

1. Create a GitHub repository.
2. Upload every file in this folder to the repository root.
3. Settings → Pages → Deploy from branch → `main` → `/ (root)`.
4. Open the resulting HTTPS URL on the phone.

HTTPS matters because motion/orientation and Wake Lock are secure-context browser features.

## Controls

The player holds the phone horizontally in the right hand like a racket handle.

- Ball on RIGHT → forehand → screen faces forward → forward thrust.
- Ball on LEFT → cross the right hand across the body → naturally flip the wrist → screen faces the player / back panel faces forward → forward thrust.

Calibration is relative: the current phone pose becomes the racket's neutral forward direction. Current motion is transformed back into that calibrated frame, so the game does not assume a universal browser/world axis.

## Sensor requirements

Use stereo earphones/headphones. Give the page motion/orientation permission when requested. Calibrate while holding the phone still in your normal ready pose.

The detector uses a short forward-thrust envelope instead of requiring one exact acceleration sample. Phones report different sensor noise and peak acceleration, so this is deliberately tolerant.

## Multiplayer

The static build uses PeerJS/WebRTC for browser-to-browser connectivity. The PeerJS service is only used for signaling; game messages are sent over WebRTC when the peers are connected. It is not possible to guarantee literal zero Internet latency.
