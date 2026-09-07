# AeroTennis — GitHub Pages Test Build

This is the **static/mobile test build** of AeroTennis. It does not require Node.js, npm, Express, or a local server. It is designed for GitHub Pages so the game can be opened directly on a phone over HTTPS.

## What works in this build

- Visionless, audio-first gameplay UI.
- Stereo left/right ball approach sound.
- Motion permission flow for iOS/Android browsers.
- Required calibration of the neutral screen-forward racket position.
- **Right ball → screen-forward forehand.**
- **Left ball → wrist-flip/back-panel-forward backhand.**
- Forward-thrust swing detection uses calibrated phone orientation plus acceleration/jerk gating.
- Wrong phone face produces `MISS — WRONG SIDE`.
- Timing window around the approaching-ball peak.
- Screen Wake Lock when available.
- PWA manifest/service worker.
- Practice / Wall Mode.
- Optional peer-to-peer two-phone test using PeerJS as a signaling broker. The actual game messages use WebRTC data channels after the peers connect.

## Deploy on GitHub Pages

1. Create a new GitHub repository, e.g. `aerotennis`.
2. Upload **all files in this folder** to the repository root.
3. GitHub → Settings → Pages → Deploy from a branch → `main` / `/ (root)` → Save.
4. Open the generated HTTPS Pages URL on the phone.
5. Connect stereo earphones/headphones.
6. Tap **START LEFT / RIGHT TEST** and confirm you hear the tones on the correct sides.
7. Tap **CALIBRATE**. Hold the phone horizontally in the right hand with the **screen-facing side pointing forward** exactly as the racket handle would be held. Keep still and capture.
8. Enter Wall Mode and test the two swing paths.

## Important limitations

A GitHub Pages site cannot itself run the WebSocket matchmaking server used by the Node build. This static build therefore uses the public PeerJS cloud broker only for signaling. After WebRTC negotiation, game messages use a peer-to-peer data channel. Internet latency and NAT/TURN conditions still mean **zero lag cannot be guaranteed**.

The browser also cannot universally prove that a physical headset is connected. The stereo listening test is therefore the compatibility gate.

For production, replace the generated ball sound with properly licensed field recordings if desired, and use a controlled signaling + TURN service.

## Sensor calibration design

Absolute compass/world orientation is intentionally not used. The player establishes a personal racket-forward reference. The current screen normal is compared with that reference:

- screen normal aligned with forward → **screen face / forehand**
- screen normal aligned with reverse forward → **back face / backhand**

The swing event requires a forward acceleration peak and a fast rise (jerk) to reduce false triggers from ordinary movement. The audio impact window is evaluated separately for timing.
