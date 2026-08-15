'use strict';

// 2人対戦 PONG(サーバー権威)

const W = 800;
const H = 500;
const PADDLE_W = 12;
const PADDLE_H = 100;
const PADDLE_SPEED = 720; // px/s
const LEFT_X = 30;
const RIGHT_X = W - 30 - PADDLE_W;
const BALL_R = 8;
const BALL_BASE_SPEED = 380;
const BALL_MAX_SPEED = 700;
const WIN_SCORE = 7;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

class PongGame {
  constructor(players, settings = {}) {
    this.t = 0;
    this.winScore = Number.isFinite(Number(settings.win))
      ? Math.max(3, Math.min(15, Math.round(Number(settings.win))))
      : WIN_SCORE;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.sides = [null, null]; // [左のplayerId, 右のplayerId]
    this.ball = null;
    this.serveAt = 1.5;
    this.serveDir = Math.random() < 0.5 ? -1 : 1;
    this.rng = Math.random;
    for (const p of players) this.addPlayer(p);
  }

  get playerCount() {
    return this.players.size;
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    let side = this.sides[0] == null ? 0 : this.sides[1] == null ? 1 : -1;
    if (side === -1) return; // 3人目以降は参加不可(ルーム側で観戦扱い)
    this.sides[side] = id;
    this.players.set(id, {
      id,
      name,
      side,
      score: 0,
      y: (H - PADDLE_H) / 2,
      targetY: H / 2,
    });
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    // 退出者のスコアも結果に残すため、削除前に集計する
    const rows = [...this.players.values()]
      .map((q) => ({ name: q.name, score: q.score }))
      .sort((a, b) => b.score - a.score);
    this.players.delete(id);
    this.sides[p.side] = null;
    if (!this.finished) {
      const other = [...this.players.values()][0];
      this.finished = true;
      this.result = {
        title: other ? `${other.name} の勝ち!(相手が退出)` : '対戦相手がいなくなりました',
        rows,
      };
    }
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || !data || typeof data.y !== 'number' || !Number.isFinite(data.y)) return;
    p.targetY = clamp(data.y, 0, H);
  }

  spawnBall() {
    const angle = (this.rng() * 50 - 25) * (Math.PI / 180);
    this.ball = {
      x: W / 2,
      y: H / 2,
      prevX: W / 2,
      prevY: H / 2,
      vx: Math.cos(angle) * BALL_BASE_SPEED * this.serveDir,
      vy: Math.sin(angle) * BALL_BASE_SPEED,
      speed: BALL_BASE_SPEED,
    };
  }

  scorePoint(side) {
    const id = this.sides[side];
    const p = id != null ? this.players.get(id) : null;
    if (p) p.score++;
    this.ball = null;
    if (p && p.score >= this.winScore) {
      this.finished = true;
      this.result = {
        title: `${p.name} の勝ち!`,
        rows: [...this.players.values()]
          .sort((a, b) => b.score - a.score)
          .map((q) => ({ name: q.name, score: q.score })),
      };
      return;
    }
    // 失点した側に向けてサーブ
    this.serveDir = side === 0 ? 1 : -1;
    this.serveAt = this.t + 1.2;
  }

  paddleFor(side) {
    const id = this.sides[side];
    return id != null ? this.players.get(id) : null;
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;

    for (const p of this.players.values()) {
      const target = clamp(p.targetY - PADDLE_H / 2, 0, H - PADDLE_H);
      const maxMove = PADDLE_SPEED * dt;
      p.y += clamp(target - p.y, -maxMove, maxMove);
    }

    if (!this.ball) {
      if (this.serveAt != null && this.t >= this.serveAt) {
        this.spawnBall();
        this.serveAt = null;
      }
      return;
    }

    const ball = this.ball;
    ball.prevX = ball.x;
    ball.prevY = ball.y;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // 上下の壁
    if (ball.y - BALL_R < 0) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy);
    } else if (ball.y + BALL_R > H) {
      ball.y = H - BALL_R;
      ball.vy = -Math.abs(ball.vy);
    }

    // パドル
    if (ball.vx < 0) {
      const p = this.paddleFor(0);
      if (
        p &&
        ball.x - BALL_R <= LEFT_X + PADDLE_W &&
        ball.prevX - BALL_R > LEFT_X + PADDLE_W - 20 &&
        ball.y + BALL_R >= p.y &&
        ball.y - BALL_R <= p.y + PADDLE_H
      ) {
        this.bounceOff(p, LEFT_X + PADDLE_W + BALL_R, 1);
      }
    } else {
      const p = this.paddleFor(1);
      if (
        p &&
        ball.x + BALL_R >= RIGHT_X &&
        ball.prevX + BALL_R < RIGHT_X + 20 &&
        ball.y + BALL_R >= p.y &&
        ball.y - BALL_R <= p.y + PADDLE_H
      ) {
        this.bounceOff(p, RIGHT_X - BALL_R, -1);
      }
    }

    // 得点
    if (ball.x < -30) {
      this.scorePoint(1);
    } else if (ball.x > W + 30) {
      this.scorePoint(0);
    }
  }

  bounceOff(p, newX, dir) {
    const ball = this.ball;
    const rel = clamp((ball.y - (p.y + PADDLE_H / 2)) / (PADDLE_H / 2), -1, 1);
    const angle = rel * ((60 * Math.PI) / 180);
    ball.speed = Math.min(ball.speed + 18, BALL_MAX_SPEED);
    ball.vx = Math.cos(angle) * ball.speed * dir;
    ball.vy = Math.sin(angle) * ball.speed;
    ball.x = newX;
  }

  serialize() {
    const paddles = [0, 1].map((side) => {
      const p = this.paddleFor(side);
      return p
        ? {
            id: p.id,
            name: p.name,
            score: p.score,
            side,
            x: side === 0 ? LEFT_X : RIGHT_X,
            y: round1(p.y),
            w: PADDLE_W,
            h: PADDLE_H,
          }
        : null;
    });
    return {
      w: W,
      h: H,
      serveIn: this.serveAt != null ? round1(Math.max(0, this.serveAt - this.t)) : 0,
      paddles,
      ball: this.ball ? { x: round1(this.ball.x), y: round1(this.ball.y), r: BALL_R } : null,
      winScore: this.winScore,
    };
  }
}

/** CPU: 自分側に向かってくるボールを追う。離れていくときは中央へ戻る */
function botAct(game, id) {
  const p = game.players.get(id);
  if (!p) return;
  let target = H / 2;
  const ball = game.ball;
  if (ball) {
    const comingToMe = p.side === 0 ? ball.vx < 0 : ball.vx > 0;
    if (comingToMe) {
      target = ball.y + Math.sin(game.t * 2.3) * 22;
    } else {
      target = H / 2 + (ball.y - H / 2) * 0.3;
    }
  }
  game.handleInput(id, { y: target });
}

const settingsDef = [
  { key: 'win', label: '勝利点数', type: 'number', min: 3, max: 15, step: 1, default: 7 },
];

module.exports = {
  botAct,
  settingsDef,
  meta: {
    id: 'pong',
    name: '対戦 PONG',
    description: '2人対戦の元祖ラケットゲーム。先に7点取ったほうが勝ち。3人目以降は観戦できます。',
    minPlayers: 2,
    maxPlayers: 2,
    allowJoinInProgress: false,
    path: '/pong/',
  },
  Game: PongGame,
};
