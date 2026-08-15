'use strict';

// ぬりかくれカメレオン(サーバー権威)— めっちゃカメレオン風の2Dお絵描きかくれんぼ
// カメレオン(隠れチーム)は真っ白な体に背景をスタンプ/手描きして擬態し、
// ハンター(鬼チーム)は捜索フェーズで怪しい場所を撃って見つけ出す。

const W = 1600; // 1画面(800x600)の4倍の広さ。クライアントはカメラスクロールで表示する
const H = 1200;
const COUNTDOWN = 3;
const HIDE_TIME = 40; // 隠れフェーズ
const SEEK_TIME = 90; // 捜索フェーズ
const HIDER_SPEED_HIDE = 180;
const HIDER_SPEED_SEEK = 80; // 捜索中は忍び足のみ
const HUNTER_SPEED = 210;
const SHOT_COOLDOWN = 0.8;
const SHOT_HIT_SCORE = 30;
const SHOT_MISS_PENALTY = 5;
const SURVIVE_TICK_SCORE = 2; // 生存1秒ごと
const SURVIVE_BONUS = 50;

// 体のドット絵グリッド(1セル=4px、体は 40x56px)
const BODY_W = 10;
const BODY_H = 14;
const CELL = 4;
const BODY_PX_W = BODY_W * CELL;
const BODY_PX_H = BODY_H * CELL;

// ステージの色パレット(0=白は体の初期色)
const PALETTE = [
  '#f5f5f4', // 0 白(初期の体)
  '#166534', // 1 深緑
  '#4d7c0f', // 2 若草
  '#a16207', // 3 土
  '#7c2d12', // 4 焦げ茶
  '#1e3a8a', // 5 紺
  '#0e7490', // 6 青緑
  '#7e22ce', // 7 紫
  '#be185d', // 8 赤紫
  '#b45309', // 9 オレンジ
  '#334155', // 10 グレー
  '#365314', // 11 オリーブ
];
const BASE_COLOR_IDX = 11; // 地面のベース色

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

class CamoGame {
  constructor(players) {
    this.t = 0;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.rng = Math.random;
    this.startAt = COUNTDOWN;
    this.shots = []; // {x, y, hit, at}
    this.endReason = null;

    // ステージ生成(円と矩形のカラフルなパッチワーク)
    this.shapes = [];
    for (let i = 0; i < 64; i++) {
      const kind = this.rng() < 0.5 ? 0 : 1; // 0=円, 1=矩形
      const c = 1 + Math.floor(this.rng() * (PALETTE.length - 1));
      if (kind === 0) {
        this.shapes.push({
          k: 0,
          x: Math.round(40 + this.rng() * (W - 80)),
          y: Math.round(40 + this.rng() * (H - 80)),
          r: Math.round(40 + this.rng() * 110),
          c,
        });
      } else {
        const w = Math.round(70 + this.rng() * 220),
          h = Math.round(50 + this.rng() * 160);
        this.shapes.push({
          k: 1,
          x: Math.round(this.rng() * (W - w)),
          y: Math.round(this.rng() * (H - h)),
          w,
          h,
          c,
        });
      }
    }

    // 役割分担: 人数の約1/3がハンター(最低1人)
    const list = [...players];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    const hunterCount = Math.max(1, Math.floor(list.length / 3));
    list.forEach((p, i) => {
      const role = i < hunterCount ? 'hunter' : 'hider';
      this.addPlayerWithRole(p, role, i);
    });
  }

  get playerCount() {
    return this.players.size;
  }

  addPlayerWithRole({ id, name }, role, idx) {
    const p = {
      id,
      name,
      role,
      color: idx % 8,
      score: 0,
      alive: true,
      x: 60 + this.rng() * (W - 120),
      y: 60 + this.rng() * (H - 120),
      mx: 0,
      my: 0,
      cdUntil: 0,
      surviveAcc: 0,
      body: new Array(BODY_W * BODY_H).fill(0), // 全マス白からスタート
    };
    this.players.set(id, p);
  }

  addPlayer() {
    // 役割が試合開始時に固定されるため途中参加は不可(観戦のみ)
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.finished) return;
    // 鬼が全員いなくなったら隠れチームの勝ち、隠れが全員いなくなったら鬼の勝ち
    if (this.phase() !== 'countdown') {
      if (![...this.players.values()].some((q) => q.role === 'hunter')) {
        this.finish('ハンターが退出したため、カメレオンチームの勝ち!');
      } else if (!this.aliveHiders().length) {
        this.finish('🏆 ハンターチームの勝ち!');
      }
    }
  }

  phase() {
    if (this.t < this.startAt) return 'countdown';
    if (this.t < this.startAt + HIDE_TIME) return 'hide';
    return 'seek';
  }

  phaseLeft() {
    if (this.t < this.startAt) return this.startAt - this.t;
    if (this.t < this.startAt + HIDE_TIME) return this.startAt + HIDE_TIME - this.t;
    return Math.max(0, this.startAt + HIDE_TIME + SEEK_TIME - this.t);
  }

  aliveHiders() {
    return [...this.players.values()].filter((p) => p.role === 'hider' && p.alive);
  }

  /** ステージの (x,y) のパレット番号(上に描かれた図形が優先) */
  colorAt(x, y) {
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      if (s.k === 0) {
        const dx = x - s.x;
        const dy = y - s.y;
        if (dx * dx + dy * dy <= s.r * s.r) return s.c;
      } else if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        return s.c;
      }
    }
    return BASE_COLOR_IDX;
  }

  /** 現在地の背景を体にコピー(スタンプ擬態) */
  stampBody(p) {
    const left = p.x - BODY_PX_W / 2;
    const top = p.y - BODY_PX_H / 2;
    for (let cy = 0; cy < BODY_H; cy++) {
      for (let cx = 0; cx < BODY_W; cx++) {
        p.body[cy * BODY_W + cx] = this.colorAt(
          left + cx * CELL + CELL / 2,
          top + cy * CELL + CELL / 2
        );
      }
    }
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || !data || this.finished) return;
    const phase = this.phase();

    // 移動
    if (typeof data.x === 'number' && typeof data.y === 'number') {
      if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
      let mx = clamp(data.x, -1, 1);
      let my = clamp(data.y, -1, 1);
      const mag = Math.hypot(mx, my);
      if (mag > 1) {
        mx /= mag;
        my /= mag;
      }
      p.mx = mx;
      p.my = my;
      return;
    }

    // スタンプ擬態(隠れフェーズのカメレオンのみ)
    if (data.st && p.role === 'hider' && p.alive && phase === 'hide') {
      this.stampBody(p);
      return;
    }

    // 手描きペイント(隠れフェーズのカメレオンのみ)
    if (Array.isArray(data.p) && p.role === 'hider' && p.alive && phase === 'hide') {
      for (const entry of data.p.slice(0, 64)) {
        if (!Array.isArray(entry)) continue;
        const idx = Math.trunc(entry[0]);
        const col = Math.trunc(entry[1]);
        if (
          Number.isFinite(idx) &&
          Number.isFinite(col) &&
          idx >= 0 &&
          idx < BODY_W * BODY_H &&
          col >= 0 &&
          col < PALETTE.length
        ) {
          p.body[idx] = col;
        }
      }
      return;
    }

    // 射撃(捜索フェーズのハンターのみ)
    if (
      typeof data.sx === 'number' &&
      typeof data.sy === 'number' &&
      p.role === 'hunter' &&
      phase === 'seek' &&
      this.t >= p.cdUntil
    ) {
      if (!Number.isFinite(data.sx) || !Number.isFinite(data.sy)) return;
      const sx = clamp(data.sx, 0, W);
      const sy = clamp(data.sy, 0, H);
      p.cdUntil = this.t + SHOT_COOLDOWN;
      let hitPlayer = null;
      for (const q of this.aliveHiders()) {
        if (
          Math.abs(sx - q.x) <= BODY_PX_W / 2 + 2 &&
          Math.abs(sy - q.y) <= BODY_PX_H / 2 + 2
        ) {
          hitPlayer = q;
          break;
        }
      }
      if (hitPlayer) {
        hitPlayer.alive = false;
        p.score += SHOT_HIT_SCORE;
      } else {
        p.score = Math.max(0, p.score - SHOT_MISS_PENALTY);
      }
      this.shots.push({ x: Math.round(sx), y: Math.round(sy), hit: !!hitPlayer, at: this.t });
      if (this.shots.length > 12) this.shots.shift();
      if (!this.aliveHiders().length) {
        this.finish('🏆 ハンターチームの勝ち!(全員発見)');
      }
    }
  }

  finish(title) {
    if (this.finished) return;
    this.finished = true;
    const rows = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({
        name: `[${p.role === 'hunter' ? '🔫 鬼' : '🦎'}] ${p.name}`,
        score: p.score,
      }));
    this.result = { title, rows };
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;
    const phase = this.phase();

    // 移動(隠れフェーズ中のハンターは待機で動けない)
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      let speed = 0;
      if (p.role === 'hider') {
        if (phase === 'hide') speed = HIDER_SPEED_HIDE;
        else if (phase === 'seek') speed = HIDER_SPEED_SEEK;
      } else if (p.role === 'hunter' && phase === 'seek') {
        speed = HUNTER_SPEED;
      }
      if (speed > 0) {
        p.x = clamp(p.x + p.mx * speed * dt, BODY_PX_W / 2, W - BODY_PX_W / 2);
        p.y = clamp(p.y + p.my * speed * dt, BODY_PX_H / 2, H - BODY_PX_H / 2);
      }
    }

    // 生存スコア(捜索フェーズ中、1秒ごと)
    if (phase === 'seek') {
      for (const p of this.aliveHiders()) {
        p.surviveAcc += dt;
        while (p.surviveAcc >= 1) {
          p.surviveAcc -= 1;
          p.score += SURVIVE_TICK_SCORE;
        }
      }
      // 時間切れ → 生き残りボーナスとカメレオン勝利
      if (this.t >= this.startAt + HIDE_TIME + SEEK_TIME) {
        const survivors = this.aliveHiders();
        for (const p of survivors) p.score += SURVIVE_BONUS;
        this.finish(
          survivors.length > 0
            ? `🦎 カメレオンチームの勝ち!(${survivors.length}人生存)`
            : '🏆 ハンターチームの勝ち!'
        );
      }
    }

    // 古い着弾マークを掃除
    this.shots = this.shots.filter((s) => this.t - s.at < 2.5);
  }

  serialize() {
    const phase = this.phase();
    return {
      w: W,
      h: H,
      bodyW: BODY_W,
      bodyH: BODY_H,
      cell: CELL,
      palette: PALETTE,
      shapes: this.shapes,
      base: BASE_COLOR_IDX,
      phase,
      phaseLeft: round1(this.phaseLeft()),
      countdown: phase === 'countdown' ? round1(this.startAt - this.t) : 0,
      aliveHiders: this.aliveHiders().length,
      shots: this.shots.map((s) => ({ x: s.x, y: s.y, hit: s.hit, age: round1(this.t - s.at) })),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        color: p.color,
        score: p.score,
        alive: p.alive,
        x: round1(p.x),
        y: round1(p.y),
        cd: p.role === 'hunter' ? round1(Math.max(0, p.cdUntil - this.t)) : 0,
        body: p.role === 'hider' ? p.body : undefined,
      })),
    };
  }
}

/** CPU: カメレオンは隠れて擬態、ハンターは巡回して時々撃つ */
function botAct(game, id) {
  const p = game.players.get(id);
  if (!p || !p.alive || game.finished) return;
  const st = p._bot || (p._bot = { tx: null, ty: null, nextShotAt: 0, stamped: 0 });
  const phase = game.phase();

  if (p.role === 'hider') {
    if (phase === 'hide') {
      const hideElapsed = game.t - game.startAt;
      if (hideElapsed < HIDE_TIME * 0.5) {
        // 前半はうろついて隠れ場所を探す
        if (
          st.tx == null ||
          Math.hypot(st.tx - p.x, st.ty - p.y) < 20
        ) {
          st.tx = 60 + game.rng() * (W - 120);
          st.ty = 60 + game.rng() * (H - 120);
        }
        const dx = st.tx - p.x;
        const dy = st.ty - p.y;
        const m = Math.hypot(dx, dy) || 1;
        game.handleInput(id, { x: dx / m, y: dy / m });
      } else {
        // 後半は止まってスタンプ擬態(数回やり直す)
        game.handleInput(id, { x: 0, y: 0 });
        if (game.t >= st.stamped + 3) {
          st.stamped = game.t;
          game.handleInput(id, { st: 1 });
        }
      }
    } else {
      game.handleInput(id, { x: 0, y: 0 }); // 捜索中はじっとする
    }
    return;
  }

  // ハンター
  if (phase !== 'seek') return;
  if (st.tx == null || Math.hypot(st.tx - p.x, st.ty - p.y) < 30) {
    st.tx = 60 + game.rng() * (W - 120);
    st.ty = 60 + game.rng() * (H - 120);
  }
  const dx = st.tx - p.x;
  const dy = st.ty - p.y;
  const m = Math.hypot(dx, dy) || 1;
  game.handleInput(id, { x: dx / m, y: dy / m });
  if (st.nextShotAt === 0) st.nextShotAt = game.t + 4 + game.rng() * 4;
  if (game.t >= st.nextShotAt) {
    st.nextShotAt = game.t + 5 + game.rng() * 5;
    const targets = game.aliveHiders();
    if (targets.length > 0 && game.rng() < 0.6) {
      const q = targets[Math.floor(game.rng() * targets.length)];
      // わざと誤差をつける(人間が勝てるように)
      const err = 25 + game.rng() * 80;
      const a = game.rng() * Math.PI * 2;
      game.handleInput(id, {
        sx: q.x + Math.cos(a) * err,
        sy: q.y + Math.sin(a) * err,
      });
    }
  }
}

module.exports = {
  botAct,
  meta: {
    id: 'camo',
    name: 'ぬりかくれカメレオン',
    description:
      'めっちゃカメレオン風の2Dお絵描きかくれんぼ!カメレオンチームは真っ白な体に背景をスタンプ&手描きして擬態し、ハンター(鬼)は捜索フェーズで怪しい場所を撃って見つけ出す。生き残れればカメレオンの勝ち。人数の1/3が自動で鬼になる(2〜6人)',
    minPlayers: 2,
    maxPlayers: 6,
    allowJoinInProgress: false,
    path: '/camo/',
  },
  Game: CamoGame,
};
