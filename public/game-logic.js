export const SCORE_NAMES = ['LOVE', '15', '30', '40'];

export function pointLabel(points) {
  if (points < 4) return SCORE_NAMES[points];
  if (points === 4) return 'AD';
  return '40';
}

export function formatGameScore(pointsA, pointsB) {
  if (pointsA >= 3 && pointsB >= 3) {
    if (pointsA === pointsB) return 'DEUCE';
    if (pointsA === pointsB + 1) return 'ADV';
    if (pointsB === pointsA + 1) return 'ADV';
  }
  return `${pointLabel(pointsA)} - ${pointLabel(pointsB)}`;
}

export function registerPoint(state, winnerIndex) {
  if (winnerIndex !== 0 && winnerIndex !== 1) throw new Error('winnerIndex must be 0 or 1');
  const next = structuredClone(state);
  const loser = winnerIndex === 0 ? 1 : 0;
  next.points[winnerIndex] += 1;
  next.pointCount += 1;

  const winsGame = next.points[winnerIndex] >= 4 && next.points[winnerIndex] - next.points[loser] >= 2;
  if (winsGame) {
    next.games[winnerIndex] += 1;
    next.points = [0, 0];
    next.server = next.server === 0 ? 1 : 0;
    // A new game starts on the deuce/service-right side.
    next.serviceSide = 0;

    const a = next.games[0];
    const b = next.games[1];
    if ((a >= 6 || b >= 6) && Math.abs(a - b) >= 2) next.matchWinner = a > b ? 0 : 1;
  } else {
    // Service court alternates after every point.
    next.serviceSide = next.serviceSide === 0 ? 1 : 0;
  }
  return next;
}

export function newMatchState() {
  return {
    points: [0, 0],
    games: [0, 0],
    server: 0,
    serviceSide: 0,
    pointCount: 0,
    matchWinner: null
  };
}

export function nextServiceSide(side) {
  return side === 0 ? 1 : 0;
}
