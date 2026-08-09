'use strict';

// 協力型マルチプレイヤー・ブロック崩し(サーバー権威)
// 最大4人が同じフィールドでパドルを操作し、共有ライフでブロックを崩す。

const W = 800;
const H = 600;
const PADDLE_Y = 566;
const PADDLE_H = 14;
const PADDLE_BASE_W = 110;
const PADDLE_SPEED = 950; // px/s(ワープ対策の移動上限)
const BALL_R = 8;
const BALL_BASE_SPEED = 320;
const BALL_MAX_SPEED = 640;
const MAX_BALLS = 6;
const BRICK_COLS = 12;
const BRICK_W = 60;
const BRICK_H = 24;
const BRICK_TOP = 70;
const BRICK_LEFT = (W - BRICK_COLS * BRICK_W) / 2;
const POWERUP_R = 12;
const POWERUP_FALL_SPEED = 150;
const START_LIVES = 3;
const MAX_LIVES = 9;

// '.' = なし / '1'〜'3' = 耐久度
const LEVELS = [
  [
    '333333333333',
    '222222222222',
    '111111111111',
    '111111111111',
    '.1111111111.',
  ],
  [
    '3.3.3.3.3.3.',
    '.2.2.2.2.2.2',
    '2.2.2.2.2.2.',
    '.1.1.1.1.1.1',
    '1.1.1.1.1.1.',
    '.1.1.1.1.1.1',
  ],
  [
    '..33333333..',
    '.3222222223.',
    '322111122223',
    '.3221111223.',
    '..32211223..',
    '...322223...',
    '....3223....',
  ],
];

const POWERUP_TYPES = [
  { type: 'multi', weight: 30 },
  { type: 'expand', weight: 30 },
  { type: 'slow', weight: 25 },
  { type: 'life', weight: 15 },
];
const POWERUP_DROP_RATE = 0.16;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

class BreakoutGame {
  constructor(players) {
    this.t = 0;
    this.lives = START_LIVES;
    this.level = 1;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.balls = [];
    this.powerups = [];
    this.slowUntil = 0;
    this.banner = { text: 'LEVEL 1', until: 1.2 };
    this.ballState = 'serving'; // 'serving' | 'live'
    this.serveAt = 1.6;
    this.rng = Math.random;
    this.nextColor = 0;
    for (const p of players) this.addPlayer(p);
    this.buildBricks();
  }

  get playerCount() {
    return this.players.size;
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    const w = PADDLE_BASE_W;
    this.players.set(id, {
      id,
      name,
      score: 0,
      x: (W - w) / 2,
      targetX: W / 2,
      expandUntil: 0,
      color: this.nextColor++ % 8,
    });
  }

  removePlayer(id) {
    this.players.delete(id);
    for (const b of this.balls) {
      if (b.lastHitBy === id) b.lastHitBy = null;
    }
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || !data || typeof data.x !== 'number' || !Number.isFinite(data.x)) return;
    p.targetX = clamp(data.x, 0, W);
  }

  paddleWidth(p) {
    return p.expandUntil > this.t ? Math.round(PADDLE_BASE_W * 1.5) : PADDLE_BASE_W;
  }

  buildBricks() {
    const layout = LEVELS[(this.level - 1) % LEVELS.length];
    this.bricks = [];
    this.remainingBricks = 0;
    for (let row = 0; row < layout.length; row++) {
      const line = layout[row];
      for (let col = 0; col < BRICK_COLS; col++) {
        const ch = line[col];
        if (!ch || ch === '.') continue;
        const hp = Math.min(3, Math.max(1, parseInt(ch, 10) || 1));
        this.bricks.push({
          x: BRICK_LEFT + col * BRICK_W,
          y: BRICK_TOP + row * BRICK_H,
          hp,
          maxHp: hp,
        });
        this.remainingBricks++;
      }
    }
  }

  ballSpeed() {
    return Math.min(BALL_BASE_SPEED + (this.level - 1) * 35, BALL_MAX_SPEED);
  }

  spawnServeBall() {
    const alive = [...this.players.values()];
    let x = W / 2;
    let y = PADDLE_Y - BALL_R - 2;
    if (alive.length > 0) {
      const p = alive[Math.floor(this.rng() * alive.length)];
      x = clamp(p.x + this.paddleWidth(p) / 2, BALL_R, W - BALL_R);
    }
    const angle = (this.rng() * 60 - 30 + (this.rng() < 0.5 ? -25 : 25)) * (Math.PI / 180);
    const speed = this.ballSpeed();
    this.balls.push({
      x,
      y,
      prevX: x,
      prevY: y,
      vx: Math.sin(angle) * speed,
      vy: -Math.cos(angle) * speed,
      lastHitBy: null,
    });
    this.ballState = 'live';
  }

  pickPowerupType() {
    const total = POWERUP_TYPES.reduce((s, p) => s + p.weight, 0);
    let r = this.rng() * total;
    for (const p of POWERUP_TYPES) {
      r -= p.weight;
      if (r <= 0) return p.type;
    }
    return POWERUP_TYPES[0].type;
  }

  applyPowerup(type, catcher, x, y) {
    if (type === 'expand') {
      catcher.expandUntil = this.t + 15;
    } else if (type === 'slow') {
      this.slowUntil = this.t + 10;
    } else if (type === 'life') {
      this.lives = Math.min(MAX_LIVES, this.lives + 1);
    } else if (type === 'multi') {
      if (this.ballState !== 'live') return;
      const speed = this.ballSpeed();
      for (const deg of [-30, 30]) {
        if (this.balls.length >= MAX_BALLS) break;
        const a = (deg * Math.PI) / 180;
        this.balls.push({
          x,
          y: Math.min(y, PADDLE_Y - BALL_R - 2),
          prevX: x,
          prevY: y,
          vx: Math.sin(a) * speed,
          vy: -Math.cos(a) * speed,
          lastHitBy: catcher.id,
        });
      }
    }
  }

  creditScore(playerId, points) {
    if (!playerId) return;
    const p = this.players.get(playerId);
    if (p) p.score += points;
  }

  collideBricks(ball) {
    for (const b of this.bricks) {
      if (b.hp <= 0) continue;
      const cx = clamp(ball.x, b.x, b.x + BRICK_W);
      const cy = clamp(ball.y, b.y, b.y + BRICK_H);
      const dx = ball.x - cx;
      const dy = ball.y - cy;
      if (dx * dx + dy * dy > BALL_R * BALL_R) continue;

      const wasLeft = ball.prevX < b.x;
      const wasRight = ball.prevX > b.x + BRICK_W;
      const wasAbove = ball.prevY < b.y;
      const wasBelow = ball.prevY > b.y + BRICK_H;
      const horiz = wasLeft || wasRight;
      const vert = wasAbove || wasBelow;
      if (horiz && !vert) {
        ball.vx = wasLeft ? -Math.abs(ball.vx) : Math.abs(ball.vx);
      } else if (vert && !horiz) {
        ball.vy = wasAbove ? -Math.abs(ball.vy) : Math.abs(ball.vy);
      } else {
        ball.vx = -ball.vx;
        ball.vy = -ball.vy;
      }
      ball.x = ball.prevX;
      ball.y = ball.prevY;

      b.hp--;
      this.creditScore(ball.lastHitBy, 10);
      if (b.hp <= 0) {
        this.remainingBricks--;
        this.creditScore(ball.lastHitBy, b.maxHp * 20);
        if (this.rng() < POWERUP_DROP_RATE) {
          this.powerups.push({
            x: b.x + BRICK_W / 2,
            y: b.y + BRICK_H / 2,
            type: this.pickPowerupType(),
          });
        }
      }
      return; // 1tick につき 1 ブロックまで
    }
  }

  advanceLevel() {
    this.level++;
    this.buildBricks();
    this.balls = [];
    this.powerups = [];
    this.slowUntil = 0;
    this.banner = { text: `LEVEL ${this.level}`, until: this.t + 1.6 };
    this.ballState = 'serving';
    this.serveAt = this.t + 2.0;
  }

  finish() {
    this.finished = true;
    const rows = [...this.players.values()]
      .map((p) => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    this.result = {
      title: `ゲームオーバー — レベル ${this.level} 到達`,
      rows,
    };
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;
    const slow = this.slowUntil > this.t ? 0.65 : 1;

    // パドル移動(目標位置へ速度制限つきで追従)
    for (const p of this.players.values()) {
      const w = this.paddleWidth(p);
      const target = clamp(p.targetX - w / 2, 0, W - w);
      const maxMove = PADDLE_SPEED * dt;
      p.x += clamp(target - p.x, -maxMove, maxMove);
      p.x = clamp(p.x, 0, W - w);
    }

    // サーブ待ち
    if (this.ballState === 'serving') {
      const bannerDone = !this.banner || this.t >= this.banner.until;
      if (this.serveAt == null) this.serveAt = this.t + 1.4;
      if (bannerDone && this.t >= this.serveAt && this.players.size > 0) {
        this.spawnServeBall();
      }
    }

    // ボール
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];
      ball.prevX = ball.x;
      ball.prevY = ball.y;
      ball.x += ball.vx * slow * dt;
      ball.y += ball.vy * slow * dt;

      // 壁
      if (ball.x - BALL_R < 0) {
        ball.x = BALL_R;
        ball.vx = Math.abs(ball.vx);
      } else if (ball.x + BALL_R > W) {
        ball.x = W - BALL_R;
        ball.vx = -Math.abs(ball.vx);
      }
      if (ball.y - BALL_R < 0) {
        ball.y = BALL_R;
        ball.vy = Math.abs(ball.vy);
      }

      // パドル
      if (ball.vy > 0 && ball.y + BALL_R >= PADDLE_Y && ball.y - BALL_R <= PADDLE_Y + PADDLE_H) {
        for (const p of this.players.values()) {
          const w = this.paddleWidth(p);
          if (ball.x < p.x - BALL_R || ball.x > p.x + w + BALL_R) continue;
          let rel = clamp((ball.x - (p.x + w / 2)) / (w / 2), -1, 1);
          // ど真ん中ヒットの垂直反射は永久ループになり得るため、わずかに乱す
          if (Math.abs(rel) < 0.05) {
            rel += (this.rng() < 0.5 ? -1 : 1) * (0.05 + this.rng() * 0.05);
          }
          const angle = rel * ((65 * Math.PI) / 180);
          const speed = Math.hypot(ball.vx, ball.vy);
          ball.vx = Math.sin(angle) * speed;
          ball.vy = -Math.cos(angle) * speed;
          ball.y = PADDLE_Y - BALL_R - 0.5;
          ball.lastHitBy = p.id;
          break;
        }
      }

      // ブロック
      this.collideBricks(ball);

      // 落下
      if (ball.y - BALL_R > H) {
        this.balls.splice(i, 1);
      }
    }

    // 全ボール喪失 → ライフ減少
    if (this.ballState === 'live' && this.balls.length === 0) {
      this.lives--;
      if (this.lives <= 0) {
        this.finish();
        return;
      }
      this.ballState = 'serving';
      this.serveAt = this.t + 1.4;
    }

    // パワーアップ落下・キャッチ
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];
      pu.y += POWERUP_FALL_SPEED * dt;
      let caught = null;
      if (pu.y + POWERUP_R >= PADDLE_Y && pu.y - POWERUP_R <= PADDLE_Y + PADDLE_H) {
        for (const p of this.players.values()) {
          const w = this.paddleWidth(p);
          if (pu.x >= p.x - POWERUP_R && pu.x <= p.x + w + POWERUP_R) {
            caught = p;
            break;
          }
        }
      }
      if (caught) {
        this.applyPowerup(pu.type, caught, pu.x, pu.y);
        this.powerups.splice(i, 1);
      } else if (pu.y - POWERUP_R > H) {
        this.powerups.splice(i, 1);
      }
    }

    // レベルクリア
    if (this.remainingBricks <= 0) {
      this.advanceLevel();
    }
  }

  serialize() {
    const bannerActive = this.banner && this.t < this.banner.until;
    return {
      w: W,
      h: H,
      lives: this.lives,
      level: this.level,
      banner: bannerActive ? this.banner.text : null,
      serveIn:
        this.ballState === 'serving' && this.serveAt != null
          ? round1(Math.max(0, this.serveAt - this.t))
          : 0,
      slow: this.slowUntil > this.t,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        x: round1(p.x),
        w: this.paddleWidth(p),
        y: PADDLE_Y,
        h: PADDLE_H,
        color: p.color,
        expanded: p.expandUntil > this.t,
      })),
      balls: this.balls.map((b) => ({ x: round1(b.x), y: round1(b.y), r: BALL_R })),
      bricks: this.bricks
        .filter((b) => b.hp > 0)
        .map((b) => ({ x: b.x, y: b.y, w: BRICK_W, h: BRICK_H, hp: b.hp, m: b.maxHp })),
      powerups: this.powerups.map((pu) => ({ x: round1(pu.x), y: round1(pu.y), type: pu.type })),
    };
  }
}

module.exports = {
  meta: {
    id: 'breakout',
    name: 'みんなでブロック崩し',
    description: '最大4人の協力プレイ。パドルを操作してボールを打ち返し、力を合わせて全ブロックを破壊しよう。パワーアップで有利に!',
    minPlayers: 1,
    maxPlayers: 4,
    allowJoinInProgress: true,
    path: '/breakout/',
  },
  Game: BreakoutGame,
};
