'use strict';

// エッジ・ディフェンス(サーバー権威)
// 各プレイヤーが正n角形の1辺を受け持つ協力ブロック崩し。中央のブロックを崩しつつ、
// 自分の辺からボールを抜かれると共有ライフが減る。担当者のいない辺は壁として反射する。
// アリーナは人数で決まる: 1人=三角形(底辺担当) / 2人=正方形(上下担当) / 3人=三角形 / 4人=正方形

const W = 700;
const H = 700;
const CX = W / 2;
const CY = H / 2;
const R = 310;

const PADDLE_HALF = 70; // 辺方向の半幅(px)
const PADDLE_THICK = 16;
const PADDLE_SPEED = 820; // 辺方向 px/s
const BALL_R = 8;
const BALL_BASE_SPEED = 300;
const BALL_MAX_SPEED = 620;
const MAX_BALLS = 6;
const MAX_ANGLE = (55 * Math.PI) / 180;
const LOST_MARGIN = 28;

const BRICK_W = 46;
const BRICK_H = 20;
const BRICK_GAP = 6;
const RING_BASE_RADIUS = 92;
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

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** 人数 → アリーナの角数 */
function sidesForPlayers(count) {
  if (count <= 1) return 3;
  if (count === 2) return 4;
  return count; // 3人=三角形, 4人=正方形
}

/** 人数 → 担当する辺のインデックス(辺0が画面下の水平辺) */
function edgeAssignment(count, n) {
  if (count === 1) return [0]; // 底辺のみ、残りは壁
  if (count === 2) return [0, 2]; // 正方形の下と上、左右は壁
  return Array.from({ length: count }, (_, i) => i); // 全辺
}

/** 辺0の中点が画面の真下(角度+90°)に来る正n角形 */
function buildArena(n) {
  const phi0 = Math.PI / 2 - Math.PI / n;
  const verts = [];
  for (let i = 0; i < n; i++) {
    const a = phi0 + (i * 2 * Math.PI) / n;
    verts.push({ x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) });
  }
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const mx = (a.x + b.x) / 2 - CX;
    const my = (a.y + b.y) / 2 - CY;
    const ml = Math.hypot(mx, my);
    edges.push({ a, b, len, ux, uy, nx: mx / ml, ny: my / ml });
  }
  return { n, phi0, verts, edges };
}

class EdgesGame {
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

    const count = Math.max(1, players.length);
    this.arena = buildArena(sidesForPlayers(count));
    const assign = edgeAssignment(count, this.arena.n);
    players.forEach((p, i) => {
      const edgeIdx = assign[i];
      const edge = this.arena.edges[edgeIdx];
      this.players.set(p.id, {
        id: p.id,
        name: p.name,
        score: 0,
        edgeIdx,
        t: edge.len / 2, // 辺に沿った中心位置(px)
        targetT: null,
        expandUntil: 0,
        color: i % 8,
      });
    });

    this.banner = { text: 'LEVEL 1', until: 1.4 };
    this.ballState = 'serving';
    this.serveAt = 1.8;
    this.buildBricks();
  }

  get playerCount() {
    return this.players.size;
  }

  addPlayer() {
    // アリーナ形状が人数で固定されるため途中参加は不可(観戦のみ)
  }

  removePlayer(id) {
    // 抜けたプレイヤーの辺は壁になる
    this.players.delete(id);
    for (const b of this.balls) {
      if (b.lastHitBy === id) b.lastHitBy = null;
    }
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || !data || typeof data.t !== 'number' || !Number.isFinite(data.t)) return;
    const edge = this.arena.edges[p.edgeIdx];
    p.targetT = clamp(data.t, 0, 1) * edge.len;
  }

  paddleHalf(p) {
    const edge = this.arena.edges[p.edgeIdx];
    const half = p.expandUntil > this.t ? PADDLE_HALF * 1.4 : PADDLE_HALF;
    return Math.min(half, edge.len / 2 - 4);
  }

  ballSpeed() {
    return Math.min(BALL_BASE_SPEED + (this.level - 1) * 35, BALL_MAX_SPEED);
  }

  wallEdges() {
    const owned = new Set([...this.players.values()].map((p) => p.edgeIdx));
    const walls = [];
    for (let i = 0; i < this.arena.n; i++) {
      if (!owned.has(i)) walls.push(i);
    }
    return walls;
  }

  buildBricks() {
    // アリーナと同じ角数・向きのリングを同心状に敷き詰める
    this.bricks = [];
    this.remainingBricks = 0;
    const { n, phi0 } = this.arena;
    for (let ring = 0; ring < RINGS; ring++) {
      const rad = RING_BASE_RADIUS + ring * RING_STEP;
      const hp = Math.min(3, RINGS - ring);
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
          this.bricks.push({
            x: v1.x + ux * d,
            y: v1.y + uy * d,
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

  paddlePoint(p) {
    const edge = this.arena.edges[p.edgeIdx];
    const t = clamp(p.t, this.paddleHalf(p), edge.len - this.paddleHalf(p));
    return {
      x: edge.a.x + edge.ux * t,
      y: edge.a.y + edge.uy * t,
      edge,
    };
  }

  spawnBallAt(p, spreadDeg) {
    const { x, y, edge } = this.paddlePoint(p);
    const bx = x - edge.nx * (PADDLE_THICK + BALL_R + 4);
    const by = y - edge.ny * (PADDLE_THICK + BALL_R + 4);
    const toC = Math.atan2(CY - by, CX - bx);
    const a = toC + ((this.rng() * 2 - 1) * spreadDeg * Math.PI) / 180;
    const speed = this.ballSpeed();
    this.balls.push({
      x: bx,
      y: by,
      prevX: bx,
      prevY: by,
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

  collideBricks(ball) {
    for (const b of this.bricks) {
      if (b.hp <= 0) continue;
      const hw = BRICK_W / 2;
      const hh = BRICK_H / 2;
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
      return;
    }
  }

  /** 壁(担当者のいない辺)での反射 */
  collideWalls(ball) {
    for (const idx of this.wallEdges()) {
      const e = this.arena.edges[idx];
      const d = (ball.x - e.a.x) * e.nx + (ball.y - e.a.y) * e.ny;
      if (d < -BALL_R) continue;
      if (ball.vx * e.nx + ball.vy * e.ny <= 0) continue;
      // 辺の範囲(角をふさぐため少し広げる)
      const u = (ball.x - e.a.x) * e.ux + (ball.y - e.a.y) * e.uy;
      if (u < -BALL_R * 2 || u > e.len + BALL_R * 2) continue;
      const dot = ball.vx * e.nx + ball.vy * e.ny;
      ball.vx -= 2 * dot * e.nx;
      ball.vy -= 2 * dot * e.ny;
      const push = d + BALL_R;
      ball.x -= e.nx * push;
      ball.y -= e.ny * push;
      return;
    }
  }

  /** 自分の辺の上をスライドするパドルとの衝突 */
  collidePaddles(ball) {
    const reach = BALL_R + PADDLE_THICK / 2;
    let best = null;
    for (const p of this.players.values()) {
      const edge = this.arena.edges[p.edgeIdx];
      const half = this.paddleHalf(p);
      const t = clamp(p.t, half, edge.len - half);
      const x1 = edge.a.x + edge.ux * (t - half);
      const y1 = edge.a.y + edge.uy * (t - half);
      const ex = edge.ux * (half * 2);
      const ey = edge.uy * (half * 2);
      const len2 = ex * ex + ey * ey || 1;
      let u = ((ball.x - x1) * ex + (ball.y - y1) * ey) / len2;
      u = clamp(u, 0, 1);
      const qx = x1 + ex * u;
      const qy = y1 + ey * u;
      const dist = Math.hypot(ball.x - qx, ball.y - qy);
      if (dist <= reach && (!best || dist < best.dist)) {
        const hitT = t - half + u * half * 2;
        best = { p, edge, dist, qx, qy, rel: clamp((hitT - t) / half, -1, 1) };
      }
    }
    if (!best) return;
    if (ball.vx * best.edge.nx + ball.vy * best.edge.ny <= 0) return;

    // ど真ん中ヒットの垂直反射は永久ループになり得るため、わずかに乱す
    let rel = best.rel;
    if (Math.abs(rel) < 0.06) {
      rel += (this.rng() < 0.5 ? -1 : 1) * (0.06 + this.rng() * 0.06);
    }
    const speed = Math.hypot(ball.vx, ball.vy);
    const cosA = Math.cos(rel * MAX_ANGLE);
    const sinA = Math.sin(rel * MAX_ANGLE);
    ball.vx = (-best.edge.nx * cosA + best.edge.ux * sinA) * speed;
    ball.vy = (-best.edge.ny * cosA + best.edge.uy * sinA) * speed;
    ball.x = best.qx - best.edge.nx * (reach + 0.5);
    ball.y = best.qy - best.edge.ny * (reach + 0.5);
    ball.lastHitBy = best.p.id;
  }

  outsideBy(x, y) {
    let max = -Infinity;
    for (const e of this.arena.edges) {
      const d = (x - e.a.x) * e.nx + (y - e.a.y) * e.ny;
      if (d > max) max = d;
    }
    return max;
  }

  advanceLevel() {
    this.level++;
    this.buildBricks();
    this.balls = [];
    this.powerups = [];
    this.slowUntil = 0;
    this.banner = { text: `LEVEL ${this.level}`, until: this.t + 1.8 };
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

    // パドル移動(自分の辺の上だけ)
    for (const p of this.players.values()) {
      const edge = this.arena.edges[p.edgeIdx];
      const half = this.paddleHalf(p);
      if (p.targetT != null) {
        const target = clamp(p.targetT, half, edge.len - half);
        const maxMove = PADDLE_SPEED * dt;
        p.t += clamp(target - p.t, -maxMove, maxMove);
      }
      p.t = clamp(p.t, half, edge.len - half);
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
      this.collideWalls(ball);
      this.collideBricks(ball);

      if (this.outsideBy(ball.x, ball.y) > LOST_MARGIN) {
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

    // パワーアップ(外周へ流れる)
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const pu = this.powerups[i];
      pu.x += pu.vx * dt;
      pu.y += pu.vy * dt;
      let caught = null;
      for (const p of this.players.values()) {
        const { x, y, edge } = this.paddlePoint(p);
        const half = this.paddleHalf(p);
        const du = (pu.x - x) * edge.ux + (pu.y - y) * edge.uy;
        const dn = (pu.x - x) * edge.nx + (pu.y - y) * edge.ny;
        if (Math.abs(du) <= half + POWERUP_R && Math.abs(dn) <= PADDLE_THICK + POWERUP_R) {
          caught = p;
          break;
        }
      }
      if (caught) {
        this.applyPowerup(pu.type, caught);
        this.powerups.splice(i, 1);
      } else if (this.outsideBy(pu.x, pu.y) > LOST_MARGIN) {
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
      n: this.arena.n,
      lives: this.lives,
      level: this.level,
      banner: bannerActive ? this.banner.text : null,
      serveIn:
        this.ballState === 'serving' && this.serveAt != null
          ? round1(Math.max(0, this.serveAt - this.t))
          : 0,
      slow: this.slowUntil > this.t,
      players: [...this.players.values()].map((p) => {
        const edge = this.arena.edges[p.edgeIdx];
        return {
          id: p.id,
          name: p.name,
          score: p.score,
          color: p.color,
          expanded: p.expandUntil > this.t,
          t: round1(clamp(p.t, this.paddleHalf(p), edge.len - this.paddleHalf(p))),
          hw: round1(this.paddleHalf(p)),
          ax: round1(edge.a.x),
          ay: round1(edge.a.y),
          bx: round1(edge.b.x),
          by: round1(edge.b.y),
        };
      }),
      walls: this.wallEdges().map((idx) => {
        const e = this.arena.edges[idx];
        return {
          ax: round1(e.a.x),
          ay: round1(e.a.y),
          bx: round1(e.b.x),
          by: round1(e.b.y),
        };
      }),
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
    id: 'edges',
    name: 'エッジ・ディフェンス',
    description:
      '各プレイヤーがn角形の1辺を受け持つ協力ブロック崩し。自分の辺を抜かれるとみんなのライフが減る!誰もいない辺は壁が守る。人数でアリーナの形が変わる(1人=三角形 / 2人=正方形の上下 / 3人=三角形 / 4人=正方形)',
    minPlayers: 1,
    maxPlayers: 4,
    allowJoinInProgress: false,
    path: '/edges/',
  },
  Game: EdgesGame,
};
