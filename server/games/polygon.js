'use strict';

// ポリゴン・ブロック崩し(サーバー権威)
// 中央にブロック群、正n角形の外周に沿ってパドルが周回する全方位型の協力ブロック崩し。
// 外周のどこからでもボールが抜けるとライフを失う。レベルごとに角数 n が変わる。

const W = 700;
const H = 700;
const CX = W / 2;
const CY = H / 2;
const R = 310; // アリーナ(正n角形)の外接円半径
const LEVEL_SIDES = [6, 5, 4, 8, 3];

const PADDLE_HALF = 80; // 周長方向の半幅(px)
const PADDLE_THICK = 16;
const PADDLE_SPEED = 820; // 周長方向 px/s
const BALL_R = 8;
const BALL_BASE_SPEED = 300;
const BALL_MAX_SPEED = 620;
const MAX_BALLS = 6;
const MAX_ANGLE = (55 * Math.PI) / 180; // パドル端で反射が傾く最大角
const LOST_MARGIN = 28; // 辺の外側にこれだけ出たらボール喪失

const BRICK_W = 46;
const BRICK_H = 20;
const BRICK_GAP = 6;
const RING_BASE_RADIUS = 92; // 最内リングの頂点半径
const RING_STEP = BRICK_H + 8;
const RINGS = 3;

const POWERUP_R = 12;
const POWERUP_SPEED = 140;
const POWERUP_DROP_RATE = 0.16;
const POWERUP_TYPES = [
  { type: 'multi', weight: 30 },
  { type: 'expand', weight: 30 },
  { type: 'slow', weight: 25 },
  { type: 'life', weight: 15 },
];

const START_LIVES = 3;
const MAX_LIVES = 9;

const KANJI_NUM = { 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八' };

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** 正n角形の外周ジオメトリ。外周は周長パラメータ s(0..P)で表す */
class PolyGeom {
  constructor(n) {
    this.n = n;
    this.verts = [];
    const phi0 = -Math.PI / 2; // 最初の頂点は真上
    for (let i = 0; i < n; i++) {
      const a = phi0 + (i * 2 * Math.PI) / n;
      this.verts.push({ x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) });
    }
    this.edgeLen = 2 * R * Math.sin(Math.PI / n);
    this.P = this.edgeLen * n;
    this.edges = [];
    for (let i = 0; i < n; i++) {
      const a = this.verts[i];
      const b = this.verts[(i + 1) % n];
      const ux = (b.x - a.x) / this.edgeLen;
      const uy = (b.y - a.y) / this.edgeLen;
      const mx = (a.x + b.x) / 2 - CX;
      const my = (a.y + b.y) / 2 - CY;
      const ml = Math.hypot(mx, my);
      this.edges.push({ a, b, ux, uy, nx: mx / ml, ny: my / ml });
    }
  }

  wrap(s) {
    return ((s % this.P) + this.P) % this.P;
  }

  /** 2つの周長パラメータの符号つき最短差 */
  diff(a, b) {
    return this.wrap(a - b + this.P / 2) - this.P / 2;
  }

  /** 周長パラメータ s の点・辺方向・外向き法線 */
  pointAt(s) {
    s = this.wrap(s);
    let idx = Math.floor(s / this.edgeLen);
    if (idx >= this.n) idx = this.n - 1;
    const t = s - idx * this.edgeLen;
    const e = this.edges[idx];
    return {
      x: e.a.x + e.ux * t,
      y: e.a.y + e.uy * t,
      ux: e.ux,
      uy: e.uy,
      nx: e.nx,
      ny: e.ny,
    };
  }

  /** 中心から角度 θ の方向に伸ばした半直線が外周と交わる点の周長パラメータ */
  angleToS(theta) {
    const phi0 = -Math.PI / 2;
    const span = (2 * Math.PI) / this.n;
    let rel = (theta - phi0) % (2 * Math.PI);
    if (rel < 0) rel += 2 * Math.PI;
    let idx = Math.floor(rel / span);
    if (idx >= this.n) idx = this.n - 1;
    const e = this.edges[idx];
    // center + t*d = a + u*(b-a) を u について解く
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const ex = e.b.x - e.a.x;
    const ey = e.b.y - e.a.y;
    const fx = e.a.x - CX;
    const fy = e.a.y - CY;
    const denom = dx * ey - dy * ex;
    let u = 0.5;
    if (Math.abs(denom) > 1e-9) u = (fx * dy - fy * dx) / denom;
    u = clamp(u, 0, 1);
    return this.wrap(idx * this.edgeLen + u * this.edgeLen);
  }

  /** 凸多角形の辺の外側への最大はみ出し量(内側なら負) */
  outsideBy(x, y) {
    let max = -Infinity;
    for (const e of this.edges) {
      const d = (x - e.a.x) * e.nx + (y - e.a.y) * e.ny;
      if (d > max) max = d;
    }
    return max;
  }
}

class PolygonGame {
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
    this.rng = Math.random;
    this.nextColor = 0;
    this.geom = new PolyGeom(this.sidesForLevel(1));
    this.banner = { text: this.bannerText(1), until: 1.4 };
    this.ballState = 'serving';
    this.serveAt = 1.8;
    for (const p of players) this.addPlayer(p);
    this.buildBricks();
  }

  get playerCount() {
    return this.players.size;
  }

  sidesForLevel(level) {
    return LEVEL_SIDES[(level - 1) % LEVEL_SIDES.length];
  }

  bannerText(level) {
    const n = this.sidesForLevel(level);
    return `LEVEL ${level} — ${KANJI_NUM[n] || n}角形`;
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    const idx = this.players.size;
    this.players.set(id, {
      id,
      name,
      score: 0,
      s: this.geom.wrap(((idx + 0.5) * this.geom.P) / 4),
      targetS: null,
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
    if (!p || !data || typeof data.a !== 'number' || !Number.isFinite(data.a)) return;
    p.targetS = this.geom.angleToS(data.a);
  }

  paddleHalf(p) {
    return p.expandUntil > this.t ? PADDLE_HALF * 1.5 : PADDLE_HALF;
  }

  ballSpeed() {
    return Math.min(BALL_BASE_SPEED + (this.level - 1) * 35, BALL_MAX_SPEED);
  }

  buildBricks() {
    // アリーナと同じ角数のリングを同心状に並べ、各辺に沿ってブロックを敷き詰める
    this.bricks = [];
    this.remainingBricks = 0;
    const n = this.geom.n;
    const phi0 = -Math.PI / 2;
    for (let ring = 0; ring < RINGS; ring++) {
      const rad = RING_BASE_RADIUS + ring * RING_STEP;
      const hp = Math.min(3, RINGS - ring); // 内側ほど硬い
      const sideLen = 2 * rad * Math.sin(Math.PI / n);
      const count = Math.max(1, Math.floor((sideLen - BRICK_GAP) / (BRICK_W + BRICK_GAP)));
      const total = count * BRICK_W + (count - 1) * BRICK_GAP;
      for (let i = 0; i < n; i++) {
        const a1 = phi0 + (i * 2 * Math.PI) / n;
        const a2 = phi0 + ((i + 1) * 2 * Math.PI) / n;
        const v1 = { x: CX + rad * Math.cos(a1), y: CY + rad * Math.sin(a1) };
        const v2 = { x: CX + rad * Math.cos(a2), y: CY + rad * Math.sin(a2) };
        const ux = (v2.x - v1.x) / sideLen;
        const uy = (v2.y - v1.y) / sideLen;
        const start = (sideLen - total) / 2;
        for (let k = 0; k < count; k++) {
          const d = start + k * (BRICK_W + BRICK_GAP) + BRICK_W / 2;
          const cx = v1.x + ux * d;
          const cy = v1.y + uy * d;
          this.bricks.push({
            x: cx,
            y: cy,
            angle: Math.atan2(uy, ux),
            ux,
            uy,
            hp,
            maxHp: hp,
          });
          this.remainingBricks++;
        }
      }
    }
  }

  spawnBallAt(p, spreadDeg) {
    const pt = this.geom.pointAt(p.s);
    const x = pt.x - pt.nx * (PADDLE_THICK + BALL_R + 4);
    const y = pt.y - pt.ny * (PADDLE_THICK + BALL_R + 4);
    const toC = Math.atan2(CY - y, CX - x);
    const a = toC + ((this.rng() * 2 - 1) * spreadDeg * Math.PI) / 180;
    const speed = this.ballSpeed();
    this.balls.push({
      x,
      y,
      prevX: x,
      prevY: y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      lastHitBy: p.id,
    });
  }

  spawnServeBall() {
    const alive = [...this.players.values()];
    if (alive.length === 0) return;
    const p = alive[Math.floor(this.rng() * alive.length)];
    this.spawnBallAt(p, 25);
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

  applyPowerup(type, catcher) {
    if (type === 'expand') {
      catcher.expandUntil = this.t + 15;
    } else if (type === 'slow') {
      this.slowUntil = this.t + 10;
    } else if (type === 'life') {
      this.lives = Math.min(MAX_LIVES, this.lives + 1);
    } else if (type === 'multi') {
      if (this.ballState !== 'live') return;
      for (let i = 0; i < 2 && this.balls.length < MAX_BALLS; i++) {
        this.spawnBallAt(catcher, 35);
      }
    }
  }

  creditScore(playerId, points) {
    if (!playerId) return;
    const p = this.players.get(playerId);
    if (p) p.score += points;
  }

  /** 回転矩形ブロックとの衝突(ローカル座標でAABB判定) */
  collideBricks(ball) {
    for (const b of this.bricks) {
      if (b.hp <= 0) continue;
      const hw = BRICK_W / 2;
      const hh = BRICK_H / 2;
      // 法線方向(リング径方向)は ux,uy を90度回したもの
      const nx = -b.uy;
      const ny = b.ux;
      const rx = ball.x - b.x;
      const ry = ball.y - b.y;
      const lx = rx * b.ux + ry * b.uy;
      const ly = rx * nx + ry * ny;
      const cx = clamp(lx, -hw, hw);
      const cy = clamp(ly, -hh, hh);
      const dx = lx - cx;
      const dy = ly - cy;
      if (dx * dx + dy * dy > BALL_R * BALL_R) continue;

      // 前フレーム位置(ローカル)で反射軸を決める
      const prx = ball.prevX - b.x;
      const pry = ball.prevY - b.y;
      const plx = prx * b.ux + pry * b.uy;
      const ply = prx * nx + pry * ny;
      const fromSide = Math.abs(plx) > hw;
      const fromFace = Math.abs(ply) > hh;
      let ax;
      let ay;
      if (fromSide && !fromFace) {
        ax = b.ux * Math.sign(plx);
        ay = b.uy * Math.sign(plx);
      } else {
        ax = nx * Math.sign(ply || 1);
        ay = ny * Math.sign(ply || 1);
      }
      const dot = ball.vx * ax + ball.vy * ay;
      ball.vx -= 2 * dot * ax;
      ball.vy -= 2 * dot * ay;
      ball.x = ball.prevX;
      ball.y = ball.prevY;

      b.hp--;
      this.creditScore(ball.lastHitBy, 10);
      if (b.hp <= 0) {
        this.remainingBricks--;
        this.creditScore(ball.lastHitBy, b.maxHp * 20);
        if (this.rng() < POWERUP_DROP_RATE) {
          const ox = b.x - CX;
          const oy = b.y - CY;
          const ol = Math.hypot(ox, oy) || 1;
          this.powerups.push({
            x: b.x,
            y: b.y,
            vx: (ox / ol) * POWERUP_SPEED,
            vy: (oy / ol) * POWERUP_SPEED,
            type: this.pickPowerupType(),
          });
        }
      }
      return; // 1tick 1ブロックまで
    }
  }

  /** パドル(外周に沿った円弧状の帯)との衝突。当たった位置で反射角が変わる */
  collidePaddles(ball) {
    const reach = BALL_R + PADDLE_THICK / 2;
    let best = null;
    for (const p of this.players.values()) {
      const half = this.paddleHalf(p);
      // パドルを数本の線分に分割して最近接点を探す
      const steps = Math.max(2, Math.ceil((half * 2) / 24));
      let prev = this.geom.pointAt(p.s - half);
      for (let i = 1; i <= steps; i++) {
        const sSeg = p.s - half + ((half * 2) * i) / steps;
        const cur = this.geom.pointAt(sSeg);
        const ex = cur.x - prev.x;
        const ey = cur.y - prev.y;
        const len2 = ex * ex + ey * ey || 1;
        let u = ((ball.x - prev.x) * ex + (ball.y - prev.y) * ey) / len2;
        u = clamp(u, 0, 1);
        const qx = prev.x + ex * u;
        const qy = prev.y + ey * u;
        const dist = Math.hypot(ball.x - qx, ball.y - qy);
        if (dist <= reach && (!best || dist < best.dist)) {
          const segS = this.geom.wrap(p.s - half + ((half * 2) * (i - 1 + u)) / steps);
          best = { p, dist, qx, qy, segS, nx: cur.nx, ny: cur.ny, ux: cur.ux, uy: cur.uy };
        }
        prev = cur;
      }
    }
    if (!best) return;
    // 外向きに動いているときだけ反射(内側から当たった場合のみ)
    if (ball.vx * best.nx + ball.vy * best.ny <= 0) return;

    const p = best.p;
    const half = this.paddleHalf(p);
    const rel = clamp(this.geom.diff(best.segS, p.s) / half, -1, 1);
    const speed = Math.hypot(ball.vx, ball.vy);
    // 基本は内向き(-法線)、当たった位置に応じて辺方向へ傾ける
    const cosA = Math.cos(rel * MAX_ANGLE);
    const sinA = Math.sin(rel * MAX_ANGLE);
    ball.vx = (-best.nx * cosA + best.ux * sinA) * speed;
    ball.vy = (-best.ny * cosA + best.uy * sinA) * speed;
    ball.x = best.qx - best.nx * (reach + 0.5);
    ball.y = best.qy - best.ny * (reach + 0.5);
    ball.lastHitBy = p.id;
  }

  advanceLevel() {
    this.level++;
    this.geom = new PolyGeom(this.sidesForLevel(this.level));
    for (const p of this.players.values()) {
      p.s = this.geom.wrap(p.s);
      p.targetS = null;
    }
    this.buildBricks();
    this.balls = [];
    this.powerups = [];
    this.slowUntil = 0;
    this.banner = { text: this.bannerText(this.level), until: this.t + 1.8 };
    this.ballState = 'serving';
    this.serveAt = this.t + 2.2;
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

    // パドルを目標位置へ周回移動
    for (const p of this.players.values()) {
      if (p.targetS != null) {
        const d = this.geom.diff(p.targetS, p.s);
        const maxMove = PADDLE_SPEED * dt;
        p.s = this.geom.wrap(p.s + clamp(d, -maxMove, maxMove));
      }
    }

    // サーブ
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

      this.collidePaddles(ball);
      this.collideBricks(ball);

      if (this.geom.outsideBy(ball.x, ball.y) > LOST_MARGIN) {
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

    // パワーアップ(割れた位置から外周へ流れる)
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];
      pu.x += pu.vx * dt;
      pu.y += pu.vy * dt;
      let caught = null;
      for (const p of this.players.values()) {
        const half = this.paddleHalf(p);
        const steps = 5;
        for (let k = 0; k <= steps; k++) {
          const pt = this.geom.pointAt(p.s - half + ((half * 2) * k) / steps);
          if (Math.hypot(pu.x - pt.x, pu.y - pt.y) <= POWERUP_R + PADDLE_THICK) {
            caught = p;
            break;
          }
        }
        if (caught) break;
      }
      if (caught) {
        this.applyPowerup(pu.type, caught);
        this.powerups.splice(i, 1);
      } else if (this.geom.outsideBy(pu.x, pu.y) > LOST_MARGIN) {
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
      cx: CX,
      cy: CY,
      n: this.geom.n,
      r: R,
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
        s: round1(p.s),
        hw: round1(this.paddleHalf(p)),
        color: p.color,
        expanded: p.expandUntil > this.t,
      })),
      balls: this.balls.map((b) => ({ x: round1(b.x), y: round1(b.y), r: BALL_R })),
      bricks: this.bricks
        .filter((b) => b.hp > 0)
        .map((b) => ({
          x: round1(b.x),
          y: round1(b.y),
          a: Math.round(b.angle * 1000) / 1000,
          w: BRICK_W,
          h: BRICK_H,
          hp: b.hp,
          m: b.maxHp,
        })),
      powerups: this.powerups.map((pu) => ({
        x: round1(pu.x),
        y: round1(pu.y),
        type: pu.type,
      })),
    };
  }
}

module.exports = {
  meta: {
    id: 'polygon',
    name: 'ポリゴン・ブロック崩し',
    description:
      '中央のブロックを全方位から狙う協力ブロック崩し。n角形アリーナの外周をパドルで周回し、どこからボールが抜けてもライフを失う。レベルごとにアリーナの形が変化!',
    minPlayers: 1,
    maxPlayers: 4,
    allowJoinInProgress: true,
    path: '/polygon/',
  },
  Game: PolygonGame,
};
