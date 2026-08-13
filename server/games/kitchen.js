'use strict';

// クレイジーキッチン(サーバー権威)— オーバークック風の協力クッキング
// 注文に合わせて食材を取り、切り、煮込み、盛り付けて提供する。3分間のチーム戦。

const T = 56; // タイルサイズ(px)
const COLS = 13;
const ROWS = 9;
const W = COLS * T; // 728
const H = ROWS * T; // 504
const PLAYER_R = 14;
const SPEED = 220;
const COUNTDOWN = 3;
const MATCH_SECONDS = 180;
const CHOP_PER_PRESS = 34; // 3回で完了
const COOK_SECONDS = 8;
const BURN_SECONDS = 10; // 完成から焦げるまで
const ACTION_COOLDOWN = 0.08;
const ORDER_INTERVAL = 16;
const MAX_ORDERS = 4;
const EXPIRE_PENALTY = 10;

// '.'=床 '#'=作業台 L/T/O=食材箱(レタス/トマト/玉ねぎ)
// C=まな板 P=コンロ(鍋) D=皿 W=提供窓口 X=ゴミ箱
const LAYOUT = [
  '########LOTT#',
  '#...........#',
  '#...........#',
  'C.....#.....W',
  'C.....#.....W',
  '#.....#.....#',
  '#...........#',
  '#...........#',
  '##DD##PP#X###',
];

const SPAWNS = [
  [2.5, 2.5],
  [10.5, 2.5],
  [2.5, 6.5],
  [10.5, 6.5],
];

const CRATE_TYPES = { L: 'lettuce', T: 'tomato', O: 'onion' };

const RECIPES = {
  salad: { label: 'サラダ', items: ['lettuce'], score: 20, ttl: 60 },
  tomato_salad: { label: 'トマトサラダ', items: ['lettuce', 'tomato'], score: 30, ttl: 75 },
  soup: { label: 'オニオンスープ', items: ['soup'], score: 40, ttl: 90 },
};
const ORDER_WEIGHTS = [
  { type: 'salad', weight: 40 },
  { type: 'tomato_salad', weight: 30 },
  { type: 'soup', weight: 30 },
];

// 0=上, 1=右, 2=下, 3=左
const FACE = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function setEq(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

class KitchenGame {
  constructor(players) {
    this.t = 0;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.startAt = COUNTDOWN;
    this.teamScore = 0;
    this.rng = Math.random;
    this.nextColor = 0;
    this.nextOrderId = 1;
    this.orderTimer = 0;

    this.boards = []; // {c, r, item, progress}
    this.pots = []; // {c, r, contents, cookT, doneT, state}
    this.counterItems = new Map(); // "c,r" -> item
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = LAYOUT[r][c];
        if (ch === 'C') this.boards.push({ c, r, item: null, progress: 0 });
        if (ch === 'P') this.pots.push({ c, r, contents: 0, cookT: 0, doneT: 0, state: 'empty' });
      }
    }

    this.orders = [];
    this.addOrder('salad');
    this.addOrder('soup');

    for (const p of players) this.addPlayer(p);
  }

  get playerCount() {
    return this.players.size;
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    const idx = this.players.size % SPAWNS.length;
    this.players.set(id, {
      id,
      name,
      score: 0,
      color: this.nextColor++ % 8,
      x: SPAWNS[idx][0] * T,
      y: SPAWNS[idx][1] * T,
      mx: 0,
      my: 0,
      facing: 2,
      carry: null,
      lastActionAt: -1,
    });
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  handleInput(id, data) {
    const p = this.players.get(id);
    if (!p || !data) return;
    if (typeof data.a === 'number' && Number.isFinite(data.a)) {
      if (this.t - p.lastActionAt >= ACTION_COOLDOWN && this.t >= this.startAt) {
        p.lastActionAt = this.t;
        this.action(p);
      }
      return;
    }
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
      if (Math.abs(mx) > 0.2 || Math.abs(my) > 0.2) {
        p.facing = Math.abs(mx) > Math.abs(my) ? (mx > 0 ? 1 : 3) : (my > 0 ? 2 : 0);
      }
    }
  }

  tileAt(c, r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return '#';
    return LAYOUT[r][c];
  }

  solid(c, r) {
    return this.tileAt(c, r) !== '.';
  }

  collides(x, y) {
    const h = PLAYER_R;
    const c0 = Math.floor((x - h) / T);
    const c1 = Math.floor((x + h) / T);
    const r0 = Math.floor((y - h) / T);
    const r1 = Math.floor((y + h) / T);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (this.solid(c, r)) return true;
      }
    }
    return false;
  }

  targetTile(p) {
    const [fx, fy] = FACE[p.facing];
    const tx = Math.floor((p.x + fx * T * 0.7) / T);
    const ty = Math.floor((p.y + fy * T * 0.7) / T);
    return [tx, ty];
  }

  addOrder(type) {
    if (!type) {
      const total = ORDER_WEIGHTS.reduce((s, o) => s + o.weight, 0);
      let r = this.rng() * total;
      type = ORDER_WEIGHTS[0].type;
      for (const o of ORDER_WEIGHTS) {
        r -= o.weight;
        if (r <= 0) {
          type = o.type;
          break;
        }
      }
    }
    const recipe = RECIPES[type];
    this.orders.push({
      id: this.nextOrderId++,
      type,
      ttl: recipe.ttl,
      expiresAt: Math.max(this.t, this.startAt) + recipe.ttl,
    });
  }

  /** 皿に食材を追加できるなら追加して true */
  tryAddToPlate(plate, ingType) {
    if (ingType !== 'lettuce' && ingType !== 'tomato') return false;
    if (plate.contents.includes('soup')) return false;
    if (plate.contents.includes(ingType)) return false;
    plate.contents.push(ingType);
    return true;
  }

  action(p) {
    const [tc, tr] = this.targetTile(p);
    const ch = this.tileAt(tc, tr);
    const carry = p.carry;

    // 食材箱
    if (CRATE_TYPES[ch]) {
      if (!carry) p.carry = { type: CRATE_TYPES[ch], chopped: false };
      return;
    }

    // まな板
    if (ch === 'C') {
      const b = this.boards.find((x) => x.c === tc && x.r === tr);
      if (!b) return;
      if (!b.item) {
        if (carry && carry.type !== 'plate' && !carry.chopped) {
          b.item = carry;
          b.progress = 0;
          p.carry = null;
        }
        return;
      }
      if (!b.item.chopped) {
        if (!carry) {
          b.progress += CHOP_PER_PRESS;
          if (b.progress >= 100) {
            b.item.chopped = true;
            b.progress = 100;
          }
        }
        return;
      }
      // 切り終わった食材
      if (!carry) {
        p.carry = b.item;
        b.item = null;
        b.progress = 0;
      } else if (carry.type === 'plate' && this.tryAddToPlate(carry, b.item.type)) {
        b.item = null;
        b.progress = 0;
      }
      return;
    }

    // コンロ(鍋)
    if (ch === 'P') {
      const pot = this.pots.find((x) => x.c === tc && x.r === tr);
      if (!pot) return;
      if (
        carry &&
        carry.type === 'onion' &&
        carry.chopped &&
        pot.contents < 3 &&
        (pot.state === 'empty' || pot.state === 'filling')
      ) {
        pot.contents++;
        pot.state = pot.contents >= 3 ? 'cooking' : 'filling';
        pot.cookT = 0;
        p.carry = null;
        return;
      }
      if (carry && carry.type === 'plate' && carry.contents.length === 0 && pot.state === 'done') {
        carry.contents.push('soup');
        pot.contents = 0;
        pot.state = 'empty';
        pot.cookT = 0;
        pot.doneT = 0;
        return;
      }
      if (!carry && pot.state === 'burnt') {
        pot.contents = 0;
        pot.state = 'empty';
        pot.cookT = 0;
        pot.doneT = 0;
      }
      return;
    }

    // 皿スタック
    if (ch === 'D') {
      if (!carry) p.carry = { type: 'plate', contents: [] };
      else if (carry.type === 'plate' && carry.contents.length === 0) p.carry = null; // 返却
      return;
    }

    // 提供窓口
    if (ch === 'W') {
      if (!carry || carry.type !== 'plate' || carry.contents.length === 0) return;
      const idx = this.orders.findIndex((o) => setEq(RECIPES[o.type].items, carry.contents));
      if (idx >= 0) {
        const order = this.orders[idx];
        const score = RECIPES[order.type].score;
        this.orders.splice(idx, 1);
        this.teamScore += score;
        p.score += score;
        p.carry = null;
        if (this.orders.length < 2) this.addOrder();
      }
      return;
    }

    // ゴミ箱
    if (ch === 'X') {
      if (!carry) return;
      if (carry.type === 'plate') carry.contents = [];
      else p.carry = null;
      return;
    }

    // 作業台(何でも置ける・拾える・皿への盛り付け)
    if (ch === '#') {
      const key = `${tc},${tr}`;
      const item = this.counterItems.get(key);
      if (item) {
        if (!carry) {
          p.carry = item;
          this.counterItems.delete(key);
        } else if (carry.type === 'plate' && item.type !== 'plate' && item.chopped) {
          if (this.tryAddToPlate(carry, item.type)) this.counterItems.delete(key);
        } else if (item.type === 'plate' && carry.type !== 'plate' && carry.chopped) {
          if (this.tryAddToPlate(item, carry.type)) p.carry = null;
        }
      } else if (carry) {
        this.counterItems.set(key, carry);
        p.carry = null;
      }
    }
  }

  finish() {
    this.finished = true;
    const rows = [...this.players.values()]
      .map((p) => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
    this.result = {
      title: `タイムアップ! チームスコア ${this.teamScore}`,
      rows,
    };
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;

    if (this.t >= this.startAt + MATCH_SECONDS) {
      this.finish();
      return;
    }

    // プレイヤー移動(カウントダウン中は動けない)
    if (this.t >= this.startAt) {
      for (const p of this.players.values()) {
        const nx = p.x + p.mx * SPEED * dt;
        if (!this.collides(nx, p.y)) p.x = nx;
        const ny = p.y + p.my * SPEED * dt;
        if (!this.collides(p.x, ny)) p.y = ny;
      }
    }

    // 鍋
    for (const pot of this.pots) {
      if (pot.state === 'cooking') {
        pot.cookT += dt;
        if (pot.cookT >= COOK_SECONDS) {
          pot.state = 'done';
          pot.doneT = 0;
        }
      } else if (pot.state === 'done') {
        pot.doneT += dt;
        if (pot.doneT >= BURN_SECONDS) pot.state = 'burnt';
      }
    }

    // 注文の期限切れ
    for (let i = this.orders.length - 1; i >= 0; i--) {
      if (this.t >= this.orders[i].expiresAt) {
        this.orders.splice(i, 1);
        this.teamScore = Math.max(0, this.teamScore - EXPIRE_PENALTY);
      }
    }

    // 注文の追加
    if (this.t >= this.startAt) {
      this.orderTimer += dt;
      if (this.orders.length < 2) {
        this.orderTimer = 0;
        this.addOrder();
      } else if (this.orderTimer >= ORDER_INTERVAL && this.orders.length < MAX_ORDERS) {
        this.orderTimer = 0;
        this.addOrder();
      }
    }
  }

  serialize() {
    return {
      w: W,
      h: H,
      tile: T,
      layout: LAYOUT,
      countdown: this.t < this.startAt ? round1(this.startAt - this.t) : 0,
      timeLeft: round1(
        Math.max(0, this.startAt + MATCH_SECONDS - Math.max(this.t, this.startAt))
      ),
      teamScore: this.teamScore,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        color: p.color,
        x: round1(p.x),
        y: round1(p.y),
        f: p.facing,
        carry: p.carry,
      })),
      boards: this.boards.map((b) => ({
        c: b.c,
        r: b.r,
        item: b.item,
        progress: b.progress,
      })),
      pots: this.pots.map((pot) => ({
        c: pot.c,
        r: pot.r,
        n: pot.contents,
        state: pot.state,
        cook: pot.state === 'cooking' ? round1(pot.cookT / COOK_SECONDS) : 0,
        burn: pot.state === 'done' ? round1(pot.doneT / BURN_SECONDS) : 0,
      })),
      counters: [...this.counterItems.entries()].map(([key, item]) => {
        const [c, r] = key.split(',').map(Number);
        return { c, r, item };
      }),
      orders: this.orders.map((o) => ({
        type: o.type,
        label: RECIPES[o.type].label,
        items: RECIPES[o.type].items,
        score: RECIPES[o.type].score,
        left: round1(Math.max(0, o.expiresAt - this.t)),
        ttl: o.ttl,
      })),
    };
  }
}

module.exports = {
  meta: {
    id: 'kitchen',
    name: 'クレイジーキッチン',
    description:
      'オーバークック風の協力クッキング!食材を取って、切って、煮込んで、盛り付けて提供。3分間でチームスコアをどこまで伸ばせる?鍋は放置すると焦げるので注意。途中参加OK(1〜4人)',
    minPlayers: 1,
    maxPlayers: 4,
    allowJoinInProgress: true,
    path: '/kitchen/',
  },
  Game: KitchenGame,
};
