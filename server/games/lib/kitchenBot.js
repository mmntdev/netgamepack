'use strict';

// キッチン系ゲーム共通の CPU プレイヤー。
// BFS でキッチン内を移動し、サラダ / トマトサラダを調理して提供する(スープは作らない)。
// makeKitchenBot(LAYOUT, T) でレイアウトごとの botAct(game, botId) を生成する。

module.exports = function makeKitchenBot(LAYOUT, T) {
  const ROWS = LAYOUT.length;
  const COLS = LAYOUT[0].length;
  const BOT_RECIPES = { salad: ['lettuce'], tomato_salad: ['lettuce', 'tomato'] };
  const CRATE_CHAR = { lettuce: 'L', tomato: 'T' };
  const STEPS = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];

  function isFloor(c, r) {
    return c >= 0 && r >= 0 && c < COLS && r < ROWS && LAYOUT[r][c] === '.';
  }

  function tilesOf(ch) {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (LAYOUT[r][c] === ch) out.push([c, r]);
      }
    }
    return out;
  }

  const STATIONS = {
    L: tilesOf('L'),
    T: tilesOf('T'),
    D: tilesOf('D'),
    W: tilesOf('W'),
    X: tilesOf('X'),
  };

  /** 床タイルのBFS(距離と前任者) */
  function bfs(fromC, fromR) {
    const dist = new Map();
    const prev = new Map();
    const k0 = fromC + ',' + fromR;
    dist.set(k0, 0);
    const queue = [[fromC, fromR]];
    while (queue.length) {
      const [c, r] = queue.shift();
      const dk = dist.get(c + ',' + r);
      for (const [dc, dr] of STEPS) {
        const nc = c + dc;
        const nr = r + dr;
        const k = nc + ',' + nr;
        if (!isFloor(nc, nr) || dist.has(k)) continue;
        dist.set(k, dk + 1);
        prev.set(k, c + ',' + r);
        queue.push([nc, nr]);
      }
    }
    return { dist, prev };
  }

  /**
   * 指定の設備タイル群のどれかへ移動してアクションする。
   * 戻り値: 'moving' | 'there'(到着してアクション済み) | 'unreachable'
   */
  function gotoAndAct(game, id, p, stations) {
    const c = Math.floor(p.x / T);
    const r = Math.floor(p.y / T);
    const { dist, prev } = bfs(c, r);

    let best = null;
    for (const [sc, sr] of stations) {
      for (const [dc, dr] of STEPS) {
        const fc = sc + dc;
        const fr = sr + dr;
        const k = fc + ',' + fr;
        if (!isFloor(fc, fr) || !dist.has(k)) continue;
        if (!best || dist.get(k) < best.d) best = { d: dist.get(k), fc, fr, sc, sr };
      }
    }
    if (!best) return 'unreachable';

    if (c === best.fc && r === best.fr) {
      // 立ち位置に到着。まずタイル中央に寄せてターゲットのずれを防ぐ
      const cx = (c + 0.5) * T;
      const cy = (r + 0.5) * T;
      const off = Math.hypot(p.x - cx, p.y - cy);
      if (off > T * 0.22) {
        const dx = cx - p.x;
        const dy = cy - p.y;
        const m = Math.hypot(dx, dy) || 1;
        const mag = Math.min(1, off / (T * 0.6));
        game.handleInput(id, { x: (dx / m) * mag, y: (dy / m) * mag });
        return 'moving';
      }
      // 設備の方を向いてからアクション(壁方向への移動入力は向きだけ変える)
      const fx = best.sc - c;
      const fy = best.sr - r;
      game.handleInput(id, { x: fx * 0.6, y: fy * 0.6 });
      game.handleInput(id, { a: 1 });
      return 'there';
    }

    // 経路の次の一歩を求める(立ち位置から現在地まで prev を遡る)
    let cur = best.fc + ',' + best.fr;
    let next = cur;
    const startKey = c + ',' + r;
    while (prev.has(cur)) {
      const par = prev.get(cur);
      if (par === startKey) {
        next = cur;
        break;
      }
      cur = par;
    }
    const [nc, nr] = next.split(',').map(Number);
    const dx = (nc + 0.5) * T - p.x;
    const dy = (nr + 0.5) * T - p.y;
    const m = Math.hypot(dx, dy) || 1;
    game.handleInput(id, { x: dx / m, y: dy / m });
    return 'moving';
  }

  return function botAct(game, id) {
    const p = game.players.get(id);
    if (!p) return;
    const st = p._bot || (p._bot = { task: null, boards: {} });

    // タスク選択(CPUが作れる注文のみ)
    if (!st.task) {
      const order = game.orders.find((o) => BOT_RECIPES[o.type]);
      if (!order) {
        game.handleInput(id, { x: 0, y: 0 });
        return;
      }
      st.task = { ings: BOT_RECIPES[order.type].slice() };
      st.boards = {};
    }
    const task = st.task;
    const carry = p.carry;
    const myTileC = Math.floor(p.x / T);
    const myTileR = Math.floor(p.y / T);

    const boardOf = (ing) => {
      const bk = st.boards[ing];
      if (!bk) return null;
      const [c, r] = bk.split(',').map(Number);
      return game.boards.find((b) => b.c === c && b.r === r) || null;
    };
    const ingReady = (ing) => {
      const b = boardOf(ing);
      return !!(b && b.item && b.item.type === ing && b.item.chopped);
    };

    // --- 工程1: 各食材を切ってまな板に置いたままにする ---
    for (const ing of task.ings) {
      // すでに皿に載っている食材は準備済み扱い
      const onPlate = carry && carry.type === 'plate' && carry.contents.includes(ing);
      if (onPlate || ingReady(ing)) continue;
      const b = boardOf(ing);

      if (carry && carry.type === ing && !carry.chopped) {
        // 空いているまな板に置く
        const free = game.boards.filter((x) => !x.item);
        if (free.length === 0) {
          game.handleInput(id, { x: 0, y: 0 });
          return;
        }
        const res = gotoAndAct(game, id, p, free.map((x) => [x.c, x.r]));
        if (res === 'there') {
          // 目の前(隣接)のまな板に置けたはずなので割り当てを記録
          const placed = game.boards.find(
            (x) =>
              Math.abs(x.c - myTileC) + Math.abs(x.r - myTileR) === 1 &&
              x.item &&
              x.item.type === ing
          );
          if (placed) st.boards[ing] = placed.c + ',' + placed.r;
        }
        return;
      }
      if (carry) {
        // 作業に不要な持ち物を処分(空の皿は返却、それ以外はゴミ箱)
        if (carry.type === 'plate' && carry.contents.length === 0) {
          gotoAndAct(game, id, p, STATIONS.D);
        } else {
          gotoAndAct(game, id, p, STATIONS.X);
        }
        return;
      }
      if (b && b.item && b.item.type === ing && !b.item.chopped) {
        gotoAndAct(game, id, p, [[b.c, b.r]]); // 連打して切る
        return;
      }
      if (b) {
        // 板の中身が消えた・別物になった → 仕切り直し
        delete st.boards[ing];
      }
      gotoAndAct(game, id, p, STATIONS[CRATE_CHAR[ing]]); // 食材箱へ
      return;
    }

    // --- 工程2: 皿を取り、まな板から盛り付ける ---
    if (!carry) {
      gotoAndAct(game, id, p, STATIONS.D);
      return;
    }
    if (carry.type !== 'plate') {
      gotoAndAct(game, id, p, STATIONS.X);
      return;
    }
    for (const ing of task.ings) {
      if (carry.contents.includes(ing)) continue;
      const b = boardOf(ing);
      if (!b || !b.item || b.item.type !== ing || !b.item.chopped) {
        // 盗まれた等でやり直し。皿の中身をリセットして工程1へ
        delete st.boards[ing];
        if (carry.contents.length === 0) {
          gotoAndAct(game, id, p, STATIONS.D); // 空の皿は返却
        } else {
          gotoAndAct(game, id, p, STATIONS.X); // 中身はゴミ箱で空に
        }
        return;
      }
      gotoAndAct(game, id, p, [[b.c, b.r]]);
      return;
    }

    // --- 工程3: 提供(注文が消えていたら破棄してやり直し) ---
    const stillOrdered = game.orders.some((o) => {
      const items = BOT_RECIPES[o.type];
      return (
        items &&
        items.length === carry.contents.length &&
        items.every((x) => carry.contents.includes(x))
      );
    });
    if (!stillOrdered) {
      const res = gotoAndAct(game, id, p, STATIONS.X);
      if (res === 'there') st.task = null;
      return;
    }
    const res = gotoAndAct(game, id, p, STATIONS.W);
    if (res === 'there' && !p.carry) {
      st.task = null; // 提供成功
    }
  };
};
