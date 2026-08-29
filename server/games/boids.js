'use strict';

// 色鬼ボイド(サーバー権威)
// Reynolds の Boids モデル(分離・整列・結束)に3色の三すくみ追跡を加えたシミュレーション。
// 赤→青→黄→赤 を追い、捕獲距離内に入った獲物は捕獲側の色に変わる。
// プレイヤーは自チームの性向(速度/追跡/逃走/結束)を作戦ボタン連打で強化する。
// パラメータは時間減衰するので押し続けて維持する設計。
// 引き継ぎ資料の推奨(§7)どおり、パラメータはサーバー側で clamp し、
// シミュレーションもすべてサーバーで実行する(ホスト昇格ロジックは不要)。

const W = 800;
const H = 600;
const N = 120; // 個体数(O(N²) 走査なのでこれ以上増やすなら空間分割が必要)
const COUNTDOWN = 3;

// 三すくみ: 0=赤, 1=青, 2=黄。 prey(c)=(c+1)%3, predator(c)=(c+2)%3
const TEAM_NAMES = ['赤', '青', '黄'];
const TEAM_EMOJI = ['🔴', '🔵', '🟡'];

const CAPTURE_DIST = 7;
const SEP_RANGE = 22;
const SEP_FORCE = 1.6;
const ALIGN_RANGE = 60;
const ALIGN_FORCE = 0.15;
const COH_RANGE = 60;
const COH_FORCE = 0.006;
const CHASE_RANGE = 120;
const CHASE_FORCE = 0.35;
const FLEE_RANGE = 84;
const FLEE_FORCE = 220; // 距離の逆2乗で減衰

// チーム性向パラメータ: { key: [min, base, max, 1押しの上昇] }
const PARAM_DEF = {
  speed: [0.7, 1.3, 2.2, 0.1],
  chase: [0, 1.0, 2, 0.15],
  flee: [0, 1.0, 2, 0.15],
  coh: [0, 1.0, 2, 0.15],
};
const PARAM_KEYS = Object.keys(PARAM_DEF);
const DECAY_INTERVAL = 0.5; // 0.5秒ごとに基準値方向へ
const DECAY_STEP = 0.02;
const PRESS_MIN_INTERVAL = 0.045; // 連打の受付上限(約20回/秒)

const AI_INTERVAL = 30; // ソロAIの戦況評価間隔(秒)

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** トーラス上の最短差分(±size/2 で折り返し) */
function torusDelta(d, size) {
  if (d > size / 2) return d - size;
  if (d < -size / 2) return d + size;
  return d;
}

function wrap(v, size) {
  v %= size;
  return v < 0 ? v + size : v;
}

function baseParams() {
  const p = {};
  for (const k of PARAM_KEYS) p[k] = PARAM_DEF[k][1];
  return p;
}

class BoidsGame {
  constructor(players, settings = {}) {
    this.t = 0;
    this.finished = false;
    this.result = null;
    this.players = new Map();
    this.rng = Math.random;
    this.startAt = COUNTDOWN;
    this.winPct = [60, 70, 80, 90, 100].includes(settings.winPct) ? settings.winPct : 80;
    this.matchSeconds = [120, 180, 300].includes(settings.time) ? settings.time : 180;
    this.decayTimer = 0;
    this.aiTimer = 0;
    this.endReason = null;

    // チーム性向(3チームぶん)
    this.teamParams = [baseParams(), baseParams(), baseParams()];

    // チーム割り当て: 希望チーム優先 → おまかせ勢は人数の少ないチームへ
    const wanted = { red: 0, blue: 1, yellow: 2 };
    const randoms = [];
    for (const p of players) {
      const team = p.pref != null && wanted[p.pref] != null ? wanted[p.pref] : null;
      if (team != null) this.registerPlayer(p, team);
      else randoms.push(p);
    }
    for (const p of randoms) this.registerPlayer(p, this.smallestTeam());

    this.spawn();
  }

  get playerCount() {
    return this.players.size;
  }

  teamPlayerCounts() {
    const counts = [0, 0, 0];
    for (const p of this.players.values()) counts[p.team]++;
    return counts;
  }

  smallestTeam() {
    const counts = this.teamPlayerCounts();
    let best = 0;
    for (let c = 1; c < 3; c++) if (counts[c] < counts[best]) best = c;
    return best;
  }

  registerPlayer({ id, name }, team) {
    this.players.set(id, { id, name, team, lastPress: -Infinity, presses: 0 });
  }

  addPlayer({ id, name }) {
    if (this.players.has(id)) return;
    // 途中参加は人数の少ないチームへ(AI チームがあればそこを引き継ぐ)
    this.registerPlayer({ id, name }, this.smallestTeam());
  }

  removePlayer(id) {
    this.players.delete(id); // 空になったチームは自動的にAI制御へ戻る
  }

  /** boids 初期化(色は i%3 で均等配分) */
  spawn() {
    this.boids = [];
    for (let i = 0; i < N; i++) {
      const a = this.rng() * Math.PI * 2;
      this.boids.push({
        x: this.rng() * W,
        y: this.rng() * H,
        vx: Math.cos(a),
        vy: Math.sin(a),
        c: i % 3,
      });
    }
  }

  counts() {
    const n = [0, 0, 0];
    for (const b of this.boids) n[b.c]++;
    return n;
  }

  /** 支配率が winPct 以上のチーム index(なければ -1) */
  winnerOf(counts) {
    for (let c = 0; c < 3; c++) {
      if ((counts[c] / N) * 100 >= this.winPct) return c;
    }
    return -1;
  }

  handleInput(id, data) {
    if (this.finished || this.t < this.startAt) return; // カウントダウン中の先押しは無効
    const p = this.players.get(id);
    if (!p || !data || typeof data.k !== 'string') return;
    if (!Object.prototype.hasOwnProperty.call(PARAM_DEF, data.k)) return;
    const def = PARAM_DEF[data.k];
    if (this.t - p.lastPress < PRESS_MIN_INTERVAL) return; // 連打の受付上限
    p.lastPress = this.t;
    const params = this.teamParams[p.team];
    const next = Math.min(def[2], params[data.k] + def[3]);
    if (next > params[data.k]) {
      params[data.k] = next;
      p.presses++;
    }
    // 上限到達時は変化なし(「限界です!」表示はクライアントが値から判定する)
  }

  /** 1フレームぶんの力計算・移動・捕獲(§3.2) */
  step() {
    const B = this.boids;
    const tags = new Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const b = B[i];
      const P = this.teamParams[b.c];
      const prey = (b.c + 1) % 3;
      let sepX = 0;
      let sepY = 0;
      let sumVX = 0;
      let sumVY = 0;
      let sumDX = 0;
      let sumDY = 0;
      let mates = 0;
      let chaseDX = 0;
      let chaseDY = 0;
      let bestD2 = CHASE_RANGE * CHASE_RANGE;
      let fleeX = 0;
      let fleeY = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const o = B[j];
        const dx = torusDelta(o.x - b.x, W);
        const dy = torusDelta(o.y - b.y, H);
        const d2 = dx * dx + dy * dy;
        if (o.c === b.c) {
          if (d2 < ALIGN_RANGE * ALIGN_RANGE) {
            sumVX += o.vx;
            sumVY += o.vy;
            sumDX += dx;
            sumDY += dy;
            mates++;
            if (d2 < SEP_RANGE * SEP_RANGE && d2 > 0.0001) {
              const d = Math.sqrt(d2);
              const w = (1 - d / SEP_RANGE) / d; // 近いほど強く離れる
              sepX -= dx * w;
              sepY -= dy * w;
            }
          }
        } else if (o.c === prey) {
          if (d2 < bestD2) {
            bestD2 = d2;
            chaseDX = dx;
            chaseDY = dy;
          }
          if (d2 < CAPTURE_DIST * CAPTURE_DIST) tags[j] = b.c; // フレーム末尾で色変換
        } else if (d2 < FLEE_RANGE * FLEE_RANGE && d2 > 1) {
          fleeX -= dx / d2; // 距離の逆2乗
          fleeY -= dy / d2;
        }
      }
      let ax = sepX * SEP_FORCE;
      let ay = sepY * SEP_FORCE;
      if (mates > 0) {
        ax += (sumVX / mates - b.vx) * ALIGN_FORCE;
        ay += (sumVY / mates - b.vy) * ALIGN_FORCE;
        ax += (sumDX / mates) * COH_FORCE * P.coh;
        ay += (sumDY / mates) * COH_FORCE * P.coh;
      }
      if (chaseDX !== 0 || chaseDY !== 0) {
        const d = Math.sqrt(bestD2) || 1;
        ax += (chaseDX / d) * CHASE_FORCE * P.chase;
        ay += (chaseDY / d) * CHASE_FORCE * P.chase;
      }
      ax += fleeX * FLEE_FORCE * P.flee;
      ay += fleeY * FLEE_FORCE * P.flee;
      // 加速度は0.5倍で加算し、後段で speed に正規化する
      b.nvx = b.vx + ax * 0.5;
      b.nvy = b.vy + ay * 0.5;
    }
    for (let i = 0; i < N; i++) {
      const b = B[i];
      if (tags[i] >= 0) b.c = tags[i]; // 捕獲された個体は捕獲側の色に
      const sp = this.teamParams[b.c].speed;
      const m = Math.hypot(b.nvx, b.nvy);
      if (m > 1e-9) {
        b.vx = (b.nvx / m) * sp;
        b.vy = (b.nvy / m) * sp;
      } else {
        const cur = Math.hypot(b.vx, b.vy) || 1;
        b.vx = (b.vx / cur) * sp;
        b.vy = (b.vy / cur) * sp;
      }
      b.x = wrap(b.x + b.vx * 2, W); // 実効移動 = speed×2 px/フレーム
      b.y = wrap(b.y + b.vy * 2, H);
    }
  }

  /** プレイヤーのいるチームだけ 0.5秒ごとに基準値方向へ減衰(§3.3) */
  decay() {
    const counts = this.teamPlayerCounts();
    for (let c = 0; c < 3; c++) {
      if (counts[c] === 0) continue; // AI チームは減衰しない(aiTick が直接調整する)
      const params = this.teamParams[c];
      for (const k of PARAM_KEYS) {
        const base = PARAM_DEF[k][1];
        if (params[k] > base) params[k] = Math.max(base, params[k] - DECAY_STEP);
        else if (params[k] < base) params[k] = Math.min(base, params[k] + DECAY_STEP);
      }
    }
  }

  bump(team, key, delta) {
    const def = PARAM_DEF[key];
    this.teamParams[team][key] = clamp(this.teamParams[team][key] + delta, def[0], def[2]);
  }

  /** プレイヤー不在チームの戦況評価(§5)。
   * ほぼ全分岐に speed+0.1 が入り速度に回帰処理がないのは原作の意図的な仕様
   * (長引くほどAIが速くなる)。バランス調整するならここが第一候補。 */
  aiTick() {
    const counts = this.counts();
    const playerCounts = this.teamPlayerCounts();
    for (let c = 0; c < 3; c++) {
      if (playerCounts[c] > 0) continue;
      const myShare = counts[c] / N;
      const preyShare = counts[(c + 1) % 3] / N;
      const predShare = counts[(c + 2) % 3] / N;
      if (myShare < 0.25) {
        this.bump(c, 'flee', 0.3);
        this.bump(c, 'coh', 0.2);
        this.bump(c, 'chase', -0.2);
        this.bump(c, 'speed', 0.1);
      } else if (preyShare > 0.4) {
        this.bump(c, 'chase', 0.3);
        this.bump(c, 'speed', 0.1);
        this.bump(c, 'flee', -0.1);
      } else if (predShare > 0.4) {
        this.bump(c, 'flee', 0.3);
        this.bump(c, 'speed', 0.1);
      } else {
        this.bump(c, 'chase', (this.rng() - 0.5) * 0.3);
        this.bump(c, 'flee', (this.rng() - 0.5) * 0.3);
      }
    }
  }

  finish(winner, reason) {
    this.finished = true;
    this.endReason = reason;
    const counts = this.counts();
    const playerCounts = this.teamPlayerCounts();
    const rows = [];
    for (let c = 0; c < 3; c++) {
      const members = [...this.players.values()].filter((p) => p.team === c);
      const label =
        members.length > 0 ? members.map((p) => p.name).join(', ') : playerCounts[c] === 0 ? 'AI' : '';
      rows.push({
        name: `${TEAM_EMOJI[c]} ${TEAM_NAMES[c]}チーム(${label})`,
        score: counts[c],
        team: c,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    let title;
    if (winner >= 0) {
      title = `${TEAM_EMOJI[winner]} ${TEAM_NAMES[winner]}チームの勝ち!`;
      if (reason === 'timeout') title = `タイムアップ! ${title}`;
      else title = `🏆 ${title}`;
    } else {
      title = 'タイムアップ! 引き分け!';
    }
    this.result = { title, rows: rows.map((r) => ({ name: r.name, score: r.score })) };
  }

  tick(dt) {
    if (this.finished) return;
    this.t += dt;
    if (this.t < this.startAt) return;

    this.step();

    this.decayTimer += dt;
    while (this.decayTimer >= DECAY_INTERVAL) {
      this.decayTimer -= DECAY_INTERVAL;
      this.decay();
    }
    this.aiTimer += dt;
    while (this.aiTimer >= AI_INTERVAL) {
      this.aiTimer -= AI_INTERVAL;
      this.aiTick();
    }

    const counts = this.counts();
    const winner = this.winnerOf(counts);
    if (winner >= 0) {
      this.finish(winner, 'domination');
      return;
    }
    if (this.t >= this.startAt + this.matchSeconds) {
      const top = Math.max(...counts);
      const leaders = [0, 1, 2].filter((c) => counts[c] === top);
      this.finish(leaders.length === 1 ? leaders[0] : -1, 'timeout');
    }
  }

  serialize() {
    // boid は [round(x), round(y), round(atan2(vy,vx)*100), c] の羅列(整数化でサイズ圧縮)
    const flat = [];
    for (const b of this.boids) {
      flat.push(Math.round(b.x), Math.round(b.y), Math.round(Math.atan2(b.vy, b.vx) * 100), b.c);
    }
    const playerCounts = this.teamPlayerCounts();
    return {
      w: W,
      h: H,
      n: N,
      winPct: this.winPct,
      countdown: this.t < this.startAt ? Math.round((this.startAt - this.t) * 10) / 10 : 0,
      timeLeft: Math.max(
        0,
        Math.round((this.startAt + this.matchSeconds - Math.max(this.t, this.startAt)) * 10) / 10
      ),
      b: flat,
      counts: this.counts(),
      params: this.teamParams.map((p) => PARAM_KEYS.map((k) => Math.round(p[k] * 100) / 100)),
      ai: playerCounts.map((n) => n === 0),
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team })),
    };
  }
}

/** CPU: aiTick と同じ戦況評価で作戦ボタンを連打する(10Hz で呼ばれ、確率で1押し) */
function botAct(game, id) {
  const p = game.players.get(id);
  if (!p || game.finished || game.t < game.startAt) return;
  if (game.rng() > 0.28) return; // 平均 約2.8押し/秒
  const counts = game.counts();
  const myShare = counts[p.team] / N;
  const preyShare = counts[(p.team + 1) % 3] / N;
  const predShare = counts[(p.team + 2) % 3] / N;
  let pool;
  if (myShare < 0.25) pool = ['flee', 'flee', 'coh', 'speed'];
  else if (preyShare > 0.4) pool = ['chase', 'chase', 'speed'];
  else if (predShare > 0.4) pool = ['flee', 'flee', 'speed'];
  else pool = ['chase', 'flee', 'coh', 'speed'];
  game.handleInput(id, { k: pool[Math.floor(game.rng() * pool.length)] });
}

const settingsDef = [
  {
    key: 'winPct',
    label: '勝利条件(支配率)',
    type: 'select',
    options: [
      { value: 60, label: '60%' },
      { value: 70, label: '70%' },
      { value: 80, label: '80%' },
      { value: 90, label: '90%' },
      { value: 100, label: '100%' },
    ],
    default: 80,
  },
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

const prefDef = {
  key: 'team',
  label: '希望するチーム',
  options: [
    { value: 'random', label: '🎲 おまかせ' },
    { value: 'red', label: '🔴 赤' },
    { value: 'blue', label: '🔵 青' },
    { value: 'yellow', label: '🟡 黄' },
  ],
  default: 'random',
};

module.exports = {
  botAct,
  settingsDef,
  prefDef,
  meta: {
    id: 'boids',
    name: '色鬼ボイド',
    description:
      '赤→青→黄→赤の三すくみで追いかけ合う120匹の群れ(Boids)シミュレーション対戦。捕まえた獲物は自分の色に!作戦ボタンを連打して自チームの「速度・追跡・逃走・結束」を強化しよう(押さないと減衰)。目標支配率に先に到達したチームの勝ち。人のいないチームはAIが操作(1人ソロプレイOK・チーム相乗りOK・途中参加OK)',
    minPlayers: 1,
    maxPlayers: 6,
    allowJoinInProgress: true,
    path: '/boids/',
  },
  Game: BoidsGame,
};
