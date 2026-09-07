import test from 'node:test';
import assert from 'node:assert/strict';
import { newMatchState, registerPoint, formatGameScore } from '../public/game-logic.js';

test('normal scoring reaches 15, 30, 40', () => {
  let s = newMatchState();
  s = registerPoint(s, 0);
  assert.deepEqual(s.points, [1,0]);
  s = registerPoint(s, 0);
  assert.deepEqual(s.points, [2,0]);
  s = registerPoint(s, 0);
  assert.deepEqual(s.points, [3,0]);
  assert.equal(formatGameScore(3,0), '40 - LOVE');
});

test('deuce and advantage resolve correctly', () => {
  let s = newMatchState();
  for (let i=0;i<3;i++) { s = registerPoint(s,0); s = registerPoint(s,1); }
  assert.deepEqual(s.points, [3,3]);
  assert.equal(formatGameScore(3,3), 'DEUCE');
  s = registerPoint(s,0);
  assert.deepEqual(s.points, [4,3]);
  assert.equal(formatGameScore(4,3), 'ADV');
  s = registerPoint(s,1);
  assert.deepEqual(s.points, [4,4]);
});

test('game is won by two points after 40', () => {
  let s = newMatchState();
  for (let i=0;i<3;i++) { s = registerPoint(s,0); s = registerPoint(s,1); }
  s = registerPoint(s,0);
  s = registerPoint(s,0);
  assert.deepEqual(s.points, [0,0]);
  assert.deepEqual(s.games, [1,0]);
  assert.equal(s.server, 1);
});

test('six games is not a match unless lead is at least two', () => {
  let s = newMatchState();
  for (let game=0; game<6; game++) {
    for (let p=0; p<4; p++) s = registerPoint(s,0);
  }
  assert.equal(s.matchWinner, 0);
});


test('service court alternates each point and resets at a new game', () => {
  let s = newMatchState();
  assert.equal(s.serviceSide, 0);
  s = registerPoint(s, 0);
  assert.equal(s.serviceSide, 1);
  s = registerPoint(s, 0);
  assert.equal(s.serviceSide, 0);
  for (let i=0;i<2;i++) s = registerPoint(s,0);
  assert.deepEqual(s.points, [0,0]);
  assert.equal(s.serviceSide, 0);
  assert.equal(s.server, 1);
});
