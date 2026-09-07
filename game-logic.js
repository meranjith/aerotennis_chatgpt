export class TennisMatch {
  constructor() {
    this.players = [0, 0];
    this.games = [0, 0];
    this.server = 0;
    this.serviceSide = 0; // 0=deuce court, 1=ad court for the starting point only; toggles each point.
    this.pointCount = 0;
    this.gameNumber = 1;
  }

  pointLabel() {
    const [a,b] = this.players;
    if (a >= 3 && b >= 3) {
      if (a === b) return 'DEUCE';
      return a > b ? `ADVANTAGE P1` : `ADVANTAGE P2`;
    }
    const labels = ['LOVE','15','30','40'];
    return `${labels[Math.min(a,3)]} - ${labels[Math.min(b,3)]}`;
  }

  point(winner) {
    if (winner !== 0 && winner !== 1) throw new Error('winner must be 0 or 1');
    const other = winner ^ 1;
    if (this.players[winner] >= 3 && this.players[other] >= 3) {
      if (this.players[winner] === this.players[other]) this.players[winner] += 1;
      else if (this.players[winner] === 4 && this.players[other] === 3) {
        this.players[winner] = 0; this.players[other] = 0;
      } else this.players[winner] += 1;
    } else {
      this.players[winner] += 1;
    }

    this.pointCount += 1;
    this.serviceSide ^= 1;

    if (this.players[winner] >= 4 && this.players[winner] - this.players[other] >= 2) {
      this.games[winner] += 1;
      const gameWinner = winner;
      this.players = [0,0];
      this.server ^= 1;
      this.gameNumber += 1;
      this.serviceSide = 0;
      return { gameWon: true, gameWinner, matchWon: this.games[gameWinner] >= 6 && this.games[gameWinner] - this.games[winner ^ 1] >= 2 };
    }
    return { gameWon:false, gameWinner:null, matchWon:false };
  }

  scoreText() { return `${this.pointLabel()} · GAMES ${this.games[0]} - ${this.games[1]}`; }
}
