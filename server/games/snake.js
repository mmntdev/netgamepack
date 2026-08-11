'use strict';

// マルチスネーク(サーバー権威)
// 最大6人が同じグリッドで対戦するスネーク。制限時間内にエサを食べてスコアを稼ぐ。
// 倒された蛇の体はエサに変わり、少し待つとリスポーン(直後は無敵)。途中参加OK。

const CW = 40; // グリッド列数
const CH = 30; // グリッド行数
const CELL = 20; // クライアント描画用のセルサイズ(px)
const MATCH_SECONDS = 120;
const COUNTDOWN = 3;
const STEP_START = 0.125; // 序盤の1歩の秒数
const STEP_END = 0.095; // 終盤の1歩の秒数
const START_LENGTH = 4;
const RESPAWN_DELAY = 2.5;
const INVINCIBLE_TIME = 2.0;
const FOOD_BASE = 4; // 常設エサ数 = FOOD_BASE + プレイヤー数
const FOOD_SCORE = 10;
const KILL_SCORE = 30;
const GROW_PER_FOOD = 2;
const PELLET_TTL = 15; // 死体エサの寿命(秒)
const PELLET_MAX = 6; // 1体から出る死体エサの上限

// 0=上, 1=右, 2=下, 3=左
const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function key(x, y) {
  return x * 100 + y;
}

class SnakeGame {
  constructor(players) {
    this.t = 0;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.food = []; // {x, y, exp?}(exp あり=死体エサ)
    this.stepTimer = 0;
    this.startAt = COUNTDOWN;
    this.rng = Math.random;
    this.nextColor = 0;
    for (const p of players) this.addPlayer(p);
    this.refillFood();
  }

  get playerCount() {
    return this.players.size;
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    const p = {
      id,
      name,
      score: 0,
      color: this.nextColor++ % 8,
      alive: false,
      body: [], // [ [x,y], ... ] 先頭が頭
      dir: 0,
      queue: [],
      grow: 0,
      respawnAt: this.t, // すぐ湧く
      invUntil: 0,
    };
    this.players.set(id, p);
    this.refillFood();
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive) this.dropPellets(p);
    this.players.delete(id);
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || !data || typeof data.d !== 'number') return;
    const d = Math.trunc(data.d);
    if (d < 0 || d > 3 || !Number.isFinite(d)) return;
    if (p.queue.length >= 3) return;
    const last = p.queue.length > 0 ? p.queue[p.queue.length - 1] : p.dir;
    if (d === last || (d + 2) % 4 === last) return; // 同方向・真後ろは無視
    p.queue.push(d);
  }

  occupiedCells() {
    const occ = new Set();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const [x, y] of p.body) occ.add(key(x, y));
    }
    for (const f of this.food) occ.add(key(f.x, f.y));
    return occ;
  }

  refillFood() {
    const target = FOOD_BASE + this.players.size;
    const baseCount = this.food.filter((f) => !f.exp).length;
    for (let i = baseCount; i < target; i++) this.spawnFood();
  }

  spawnFood() {
    const occ = this.occupiedCells();
    for (let tries = 0; tries < 100; tries++) {
      const x = Math.floor(this.rng() * CW);
      const y = Math.floor(this.rng() * CH);
      if (!occ.has(key(x, y))) {
        this.food.push({ x, y });
        return;
      }
    }
  }

  dropPellets(p) {
    let dropped = 0;
    for (let i = 1; i < p.body.length && dropped < PELLET_MAX; i += 2) {
      const [x, y] = p.body[i];
      this.food.push({ x, y, exp: this.t + PELLET_TTL });
      dropped++;
    }
  }

  /** 安全なリスポーン位置を探して蛇を配置する */
  spawnSnake(p) {
    const occ = this.occupiedCells();
    for (let tries = 0; tries < 80; tries++) {
      const x = 3 + Math.floor(this.rng() * (CW - 6));
      const y = 3 + Math.floor(this.rng() * (CH - 6));
      // 中央へ向かうおおまかな向き
      const dx = CW / 2 - x;
      const dy = CH / 2 - y;
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      const [ux, uy] = DIRS[dir];
      const body = [];
      let ok = true;
      for (let i = 0; i < START_LENGTH; i++) {
        const bx = x - ux * i;
        const by = y - uy * i;
        if (bx < 0 || by < 0 || bx >= CW || by >= CH || occ.has(key(bx, by))) {
          ok = false;
          break;
        }
        body.push([bx, by]);
      }
      // 前方2マスも空けておく
      for (let i = 1; i <= 2 && ok; i++) {
        const fx = x + ux * i;
        const fy = y + uy * i;
        if (fx < 0 || fy < 0 || fx >= CW || fy >= CH || occ.has(key(fx, fy))) ok = false;
      }
      if (!ok) continue;
      p.body = body;
      p.dir = dir;
      p.queue = [];
      p.grow = 0;
      p.alive = true;
      p.invUntil = this.t + INVINCIBLE_TIME;
      return;
    }
    // 見つからなければ次の tick で再挑戦
    p.respawnAt = this.t + 0.5;
  }

  stepInterval() {
    const progress = Math.min(1, Math.max(0, (this.t - this.startAt) / MATCH_SECONDS));
    return STEP_START + (STEP_END - STEP_START) * progress;
  }

  creditKill(p) {
    p.score += KILL_SCORE;
  }

  doStep() {
    const movers = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      while (p.queue.length > 0) {
        const d = p.queue.shift();
        if ((d + 2) % 4 !== p.dir && d !== p.dir) {
          p.dir = d;
          break;
        }
      }
      movers.push(p);
    }

    // 全員同時に1マス前進(尻尾は伸び予約がなければ縮む)
    for (const p of movers) {
      const [dx, dy] = DIRS[p.dir];
      p.body.unshift([p.body[0][0] + dx, p.body[0][1] + dy]);
      if (p.grow > 0) p.grow--;
      else p.body.pop();
    }

    // 占有マップ(移動後)
    const occ = new Map(); // key -> [{p, isHead}]
    for (const p of movers) {
      p.body.forEach(([x, y], i) => {
        const k = key(x, y);
        let arr = occ.get(k);
        if (!arr) occ.set(k, (arr = []));
        arr.push({ p, isHead: i === 0 });
      });
    }

    // 衝突判定
    const deaths = [];
    for (const p of movers) {
      const [hx, hy] = p.body[0];
      if (hx < 0 || hy < 0 || hx >= CW || hy >= CH) {
        deaths.push(p);
        continue;
      }
      const inv = p.invUntil > this.t;
      for (const o of occ.get(key(hx, hy)) || []) {
        if (o.p === p && o.isHead) continue;
        if (o.p === p) {
          deaths.push(p); // 自分の体
          break;
        }
        if (inv || o.p.invUntil > this.t) continue; // 無敵はすり抜け
        deaths.push(p);
        if (!o.isHead) this.creditKill(o.p); // 相手の体に突っ込んだ → 相手に加点
        break;
      }
    }

    for (const p of deaths) {
      p.alive = false;
      this.dropPellets(p);
      p.body = [];
      p.respawnAt = this.t + RESPAWN_DELAY;
    }

    // エサ
    let ate = false;
    for (const p of movers) {
      if (!p.alive) continue;
      const [hx, hy] = p.body[0];
      const idx = this.food.findIndex((f) => f.x === hx && f.y === hy);
      if (idx >= 0) {
        this.food.splice(idx, 1);
        p.grow += GROW_PER_FOOD;
        p.score += FOOD_SCORE;
        ate = true;
      }
    }
    if (ate) this.refillFood();
  }

  finish() {
    this.finished = true;
    const rows = [...this.players.values()]
      .map((p) => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    let title = 'タイムアップ!';
    if (rows.length === 1) {
      title = `タイムアップ! スコア ${rows[0].score}`;
    } else if (rows.length > 1) {
      title =
        rows[0].score === rows[1].score
          ? 'タイムアップ! 引き分け!'
          : `🏆 ${rows[0].name} の勝ち!`;
    }
    this.result = { title, rows };
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;

    // 期限切れの死体エサを掃除
    if (this.food.some((f) => f.exp && f.exp <= this.t)) {
      this.food = this.food.filter((f) => !f.exp || f.exp > this.t);
    }

    // リスポーン
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt != null && this.t >= p.respawnAt) {
        p.respawnAt = null;
        this.spawnSnake(p);
      }
    }

    // 開始カウントダウン中は移動しない
    if (this.t < this.startAt) return;

    // タイムアップ
    if (this.t >= this.startAt + MATCH_SECONDS) {
      this.finish();
      return;
    }

    this.stepTimer += dt;
    const interval = this.stepInterval();
    let steps = 0;
    while (this.stepTimer >= interval && steps < 4) {
      this.stepTimer -= interval;
      this.doStep();
      steps++;
    }
  }

  serialize() {
    return {
      w: CW * CELL,
      h: CH * CELL,
      cw: CW,
      ch: CH,
      cell: CELL,
      countdown: this.t < this.startAt ? Math.round((this.startAt - this.t) * 10) / 10 : 0,
      timeLeft: Math.max(
        0,
        Math.round((this.startAt + MATCH_SECONDS - Math.max(this.t, this.startAt)) * 10) / 10
      ),
      players: [...this.players.values()].map((p) => {
        const flat = [];
        for (const [x, y] of p.body) flat.push(x, y);
        return {
          id: p.id,
          name: p.name,
          score: p.score,
          color: p.color,
          alive: p.alive,
          inv: p.invUntil > this.t,
          respawnIn:
            !p.alive && p.respawnAt != null
              ? Math.round(Math.max(0, p.respawnAt - this.t) * 10) / 10
              : 0,
          body: flat,
        };
      }),
      food: this.food.map((f) => ({ x: f.x, y: f.y, p: !!f.exp })),
    };
  }
}

module.exports = {
  meta: {
    id: 'snake',
    name: 'マルチスネーク',
    description:
      '最大6人同時対戦のスネーク。2分間でエサを食べてスコアを稼ぎ、相手を自分の体に突っ込ませれば大量ボーナス!倒された蛇はエサになり、少し待てば復活できる。途中参加OK',
    minPlayers: 1,
    maxPlayers: 6,
    allowJoinInProgress: true,
    path: '/snake/',
  },
  Game: SnakeGame,
};
