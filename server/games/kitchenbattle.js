'use strict';

// キッチンバトル 2vs2(サーバー権威)
// 左右対称の2つのキッチンでチーム対抗クッキング。注文は共有キューで早い者勝ち。
// 3分間でチーム合計スコアが高いほうの勝ち。提供窓口は各チームの外壁側、
// 中央の壁カウンターだけが両チーム共用(食材の取り合いあり)。

const T = 52;
const COLS = 15;
const ROWS = 9;
const W = COLS * T; // 780
const H = ROWS * T; // 468
const PLAYER_R = 14;
const SPEED = 220;
const COUNTDOWN = 3;
const MATCH_SECONDS = 180;
const CHOP_PER_PRESS = 34;
const COOK_SECONDS = 8;
const BURN_SECONDS = 10;
const ACTION_COOLDOWN = 0.08;
const ORDER_INTERVAL = 12;
const MAX_ORDERS = 5;

// '.'=床 '#'=作業台 L/T/O=食材箱 C=まな板 P=コンロ D=皿 W=提供窓口(各チームの外壁) X=ゴミ箱
// 中央列(col7)が壁で左右のキッチンを分ける
const LAYOUT = [
  '###############',
  'L......#......L',
  'O......#......O',
  'C......#......C',
  'C......#......C',
  'T......#......T',
  'W......#......W',
  '#......#......#',
  '#DDXPP###PPXDD#',
];

// [チーム0(左)のスポーン], [チーム1(右)のスポーン](各チーム最大3人)
const TEAM_SPAWNS = [
  [
    [2.5, 2.5],
    [3.5, 6.5],
    [5.5, 4.5],
  ],
  [
    [12.5, 2.5],
    [11.5, 6.5],
    [9.5, 4.5],
  ],
];

const TEAM_NAMES = ['ブルー', 'ピンク'];

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

class KitchenBattleGame {
  constructor(players, settings = {}) {
    this.t = 0;
    this.matchSeconds = [120, 180, 300].includes(settings.time) ? settings.time : MATCH_SECONDS;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.startAt = COUNTDOWN;
    this.teamScores = [0, 0];
    this.rng = Math.random;
    this.nextOrderId = 1;
    this.orderTimer = 0;

    this.boards = [];
    this.pots = [];
    this.counterItems = new Map();
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

  teamCount(team) {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    // 少ないほうのチームへ(同数なら左=ブルー)
    const team = this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
    const member = this.teamCount(team) % TEAM_SPAWNS[team].length;
    const [sx, sy] = TEAM_SPAWNS[team][member];
    this.players.set(id, {
      id,
      name,
      team,
      member,
      score: 0,
      x: sx * T,
      y: sy * T,
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

    if (CRATE_TYPES[ch]) {
      if (!carry) p.carry = { type: CRATE_TYPES[ch], chopped: false };
      return;
    }

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
      // 手ぶらなら鍋から刻み玉ねぎを1個取り出せる(調理中なら中断される)
      if (
        !carry &&
        pot.contents > 0 &&
        (pot.state === 'filling' || pot.state === 'cooking')
      ) {
        pot.contents--;
        pot.state = pot.contents > 0 ? 'filling' : 'empty';
        pot.cookT = 0;
        p.carry = { type: 'onion', chopped: true };
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

    // 皿スタック(スタックの上に皿を1枚置いたまま盛り付けできる)
    if (ch === 'D') {
      const key = `${tc},${tr}`;
      const slot = this.counterItems.get(key);
      if (!carry) {
        if (slot) {
          p.carry = slot; // 置いてある皿を中身ごと取る
          this.counterItems.delete(key);
        } else {
          p.carry = { type: 'plate', contents: [] }; // 新しい皿
        }
        return;
      }
      if (carry.type === 'plate') {
        if (carry.contents.length === 0) {
          p.carry = null; // 空の皿は返却
          return;
        }
        if (!slot) {
          this.counterItems.set(key, carry); // 中身入りの皿は上に仮置きできる
          p.carry = null;
        }
        return;
      }
      // 刻んだ食材を持っていれば、スタックの上の皿に直接盛る(皿がなければ新しい皿に)
      if (carry.chopped) {
        if (!slot) {
          if (carry.type === 'lettuce' || carry.type === 'tomato') {
            this.counterItems.set(key, { type: 'plate', contents: [carry.type] });
            p.carry = null;
          }
        } else if (slot.type === 'plate' && this.tryAddToPlate(slot, carry.type)) {
          p.carry = null;
        }
      }
      return;
    }

    // 提供窓口(各チームの外壁側)— 注文は共有キューで先に出したチームが得点を奪う
    if (ch === 'W') {
      if (!carry || carry.type !== 'plate' || carry.contents.length === 0) return;
      const idx = this.orders.findIndex((o) => setEq(RECIPES[o.type].items, carry.contents));
      if (idx >= 0) {
        const order = this.orders[idx];
        const score = RECIPES[order.type].score;
        this.orders.splice(idx, 1);
        this.teamScores[p.team] += score;
        p.score += score;
        p.carry = null;
        if (this.orders.length < 2) this.addOrder();
      }
      return;
    }

    if (ch === 'X') {
      if (!carry) return;
      if (carry.type === 'plate') carry.contents = [];
      else p.carry = null;
      return;
    }

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
    const [a, b] = this.teamScores;
    let title;
    if (a === b) title = `引き分け!(${a} - ${b})`;
    else {
      const winner = a > b ? 0 : 1;
      title = `🏆 ${TEAM_NAMES[winner]}チームの勝ち!(${a} - ${b})`;
    }
    const rows = [...this.players.values()]
      .sort((x, y) => x.team - y.team || y.score - x.score)
      .map((p) => ({ name: `[${TEAM_NAMES[p.team]}] ${p.name}`, score: p.score }));
    this.result = { title, rows };
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;

    if (this.t >= this.startAt + this.matchSeconds) {
      this.finish();
      return;
    }

    if (this.t >= this.startAt) {
      for (const p of this.players.values()) {
        const nx = p.x + p.mx * SPEED * dt;
        if (!this.collides(nx, p.y)) p.x = nx;
        const ny = p.y + p.my * SPEED * dt;
        if (!this.collides(p.x, ny)) p.y = ny;
      }
    }

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

    // 期限切れ(対戦なのでペナルティなし、消えるだけ)
    for (let i = this.orders.length - 1; i >= 0; i--) {
      if (this.t >= this.orders[i].expiresAt) this.orders.splice(i, 1);
    }

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
        Math.max(0, this.startAt + this.matchSeconds - Math.max(this.t, this.startAt))
      ),
      teamScores: this.teamScores,
      teamNames: TEAM_NAMES,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        member: p.member,
        score: p.score,
        x: round1(p.x),
        y: round1(p.y),
        f: p.facing,
        carry: p.carry,
      })),
      boards: this.boards.map((b) => ({ c: b.c, r: b.r, item: b.item, progress: b.progress })),
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

const makeKitchenBot = require('./lib/kitchenBot');

const settingsDef = [
  {
    key: 'time',
    label: '制限時間',
    type: 'select',
    options: [
      { value: 120, label: '2分' },
      { value: 180, label: '3分' },
      { value: 300, label: '5分' },
    ],
    default: 180,
  },
];

module.exports = {
  botAct: makeKitchenBot(LAYOUT, T),
  settingsDef,
  meta: {
    id: 'kitchenbattle',
    name: 'キッチンバトル 2vs2',
    description:
      'チーム対抗の料理バトル!左右対称のキッチンに分かれ、共有の注文を早い者勝ちで取り合う。先に提供したチームが得点。3分間で合計スコアが高いチームの勝ち。中央のカウンターは共用なので、置いた食材は取られるかも!?(2〜6人・奇数なら2対3のような変則マッチ・途中参加OK)',
    minPlayers: 2,
    maxPlayers: 6,
    allowJoinInProgress: true,
    path: '/kitchenbattle/',
  },
  Game: KitchenBattleGame,
};
