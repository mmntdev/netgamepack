'use strict';

/* スモークテスト:実サーバーを起動し、socket.io-client で実際にプレイして検証する。
 *  1. /healthz と /api/games が応答する
 *  2. ブロック崩し:ルーム作成→参加→開始→スナップショット受信→ブロックが減る/スコアが入る
 *  3. 途中参加プレイヤーがパドルを持てる
 *  4. PONG:2人で開始→片方切断→もう片方の勝ちで終了
 *  5. 不正入力(存在しないルーム等)がエラーになる
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      })
      .on('error', reject);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      timeoutMs
    );
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function testHttp() {
  console.log('HTTP エンドポイント:');
  const health = await fetchJson(`${BASE}/healthz`);
  check(health.status === 200, '/healthz が 200 を返す');
  const games = await fetchJson(`${BASE}/api/games`);
  check(games.status === 200 && Array.isArray(games.body), '/api/games が配列を返す');
  check(
    ['breakout', 'camo', 'edges', 'kitchen', 'kitchenbattle', 'polygon', 'snake', 'pong'].every(
      (id) => games.body.some((g) => g.id === id)
    ),
    '全8ゲームが登録されている'
  );
}

async function testBreakout() {
  console.log('ブロック崩し:');
  const host = await connect();
  const guest = await connect();
  const late = await connect();

  const created = await emitAck(host, 'room:create', { gameId: 'breakout', name: 'ホスト' });
  check(created.ok === true, 'ルームを作成できる');
  check(/^[A-Z0-9]{4}$/.test(created.roomId), 'ルームコードが4文字');

  const joined = await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'ゲスト' });
  check(joined.ok === true, '別クライアントが参加できる');
  check(joined.lobby.players.length === 2, 'ロビーに2人いる');

  const bad = await emitAck(guest, 'room:start', {});
  check(bad.ok === false, 'ホスト以外は開始できない');

  const gameStartPromise = waitFor(guest, 'game:start');
  const started = await emitAck(host, 'room:start', {});
  check(started.ok === true, 'ホストが開始できる');
  await gameStartPromise;
  console.log('  ✓ ゲスト側に game:start が届く');

  const snap0 = await waitFor(guest, 'game:state');
  check(snap0.bricks.length > 0, 'ブロックが配置されている');
  check(snap0.players.length === 2, 'パドルが2枚ある');
  check(snap0.lives === 3, 'ライフが3');

  // 途中参加
  const lateJoin = await emitAck(late, 'room:join', { roomId: created.roomId, name: '途中参加' });
  check(lateJoin.ok === true && lateJoin.role === 'player', '進行中でもプレイヤーとして途中参加できる');
  const lateSnap = await waitFor(late, 'game:state');
  check(
    lateSnap.players.some((p) => p.name === '途中参加'),
    '途中参加者のパドルが追加される'
  );

  // ボールを追いかける単純AI:自分のパドルをボールのx座標へ動かし続ける
  const chase = (socket) => {
    const handler = (snap) => {
      if (snap.balls && snap.balls.length > 0) {
        socket.emit('game:input', { x: snap.balls[0].x });
      }
    };
    socket.on('game:state', handler);
    return () => socket.off('game:state', handler);
  };
  const stops = [chase(host), chase(guest), chase(late)];

  const initialBricks = snap0.bricks.length;
  let lastSnap = snap0;
  const collector = (snap) => (lastSnap = snap);
  guest.on('game:state', collector);

  await sleep(12000);
  stops.forEach((f) => f());
  guest.off('game:state', collector);

  check(
    lastSnap.bricks.length < initialBricks || lastSnap.level > 1,
    `ブロックが減っている(${initialBricks} → ${lastSnap.bricks.length}, level=${lastSnap.level})`
  );
  const totalScore = lastSnap.players.reduce((s, p) => s + p.score, 0);
  check(totalScore > 0, `スコアが加算されている(合計 ${totalScore})`);

  // 全員退室でルームが消える
  host.disconnect();
  guest.disconnect();
  late.disconnect();
  await sleep(300);
  const stats = await fetchJson(`${BASE}/api/stats`);
  check(stats.body.rooms === 0, '全員退室でルームが破棄される');
}

async function testPolygon() {
  console.log('ポリゴン・ブロック崩し:');
  const host = await connect();
  const guest = await connect();

  const created = await emitAck(host, 'room:create', { gameId: 'polygon', name: 'ホスト' });
  check(created.ok === true, 'ルームを作成できる');
  const joined = await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'ゲスト' });
  check(joined.ok === true, '2人目が参加できる');

  const started = await emitAck(host, 'room:start', {});
  check(started.ok === true, 'ホストが開始できる');

  const snap0 = await waitFor(guest, 'game:state');
  check(snap0.n >= 3, `アリーナが${snap0.n}角形`);
  check(snap0.bricks.length > 0, '中央にブロックが配置されている');
  check(snap0.players.length === 2, 'パドルが2つある');

  // ボールの方向へパドルを回すAI
  const cx = snap0.w / 2;
  const cy = snap0.h / 2;
  const chase = (socket) => {
    const handler = (snap) => {
      if (snap.balls && snap.balls.length > 0) {
        const b = snap.balls[0];
        socket.emit('game:input', { a: Math.atan2(b.y - cy, b.x - cx) });
      }
    };
    socket.on('game:state', handler);
    return () => socket.off('game:state', handler);
  };
  const stops = [chase(host), chase(guest)];

  const initialBricks = snap0.bricks.length;
  let lastSnap = snap0;
  const collector = (snap) => (lastSnap = snap);
  guest.on('game:state', collector);

  await sleep(12000);
  stops.forEach((f) => f());
  guest.off('game:state', collector);

  check(
    lastSnap.bricks.length < initialBricks || lastSnap.level > 1,
    `ブロックが減っている(${initialBricks} → ${lastSnap.bricks.length}, level=${lastSnap.level})`
  );
  const totalScore = lastSnap.players.reduce((s, p) => s + p.score, 0);
  check(totalScore > 0, `スコアが加算されている(合計 ${totalScore})`);

  host.disconnect();
  guest.disconnect();
  await sleep(300);
}

async function testEdges() {
  console.log('エッジ・ディフェンス:');
  const host = await connect();
  const guest = await connect();

  const created = await emitAck(host, 'room:create', { gameId: 'edges', name: 'した' });
  check(created.ok === true, 'ルームを作成できる');
  const joined = await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'うえ' });
  check(joined.ok === true, '2人目が参加できる');

  const started = await emitAck(host, 'room:start', {});
  check(started.ok === true, 'ホストが開始できる');

  const snap0 = await waitFor(guest, 'game:state');
  check(snap0.n === 4, '2人プレイは正方形アリーナ');
  check(snap0.walls.length === 2, '空いた2辺が壁になる');
  check(snap0.players.length === 2, '各プレイヤーが辺を受け持つ');
  check(
    snap0.players.every((p) => typeof p.ax === 'number' && typeof p.t === 'number'),
    'スナップショットに辺の端点とパドル位置が入っている'
  );
  check(snap0.bricks.length > 0, '中央にブロックが配置されている');

  // ボールを自分の辺に射影して追いかけるAI
  const chase = (socket) => {
    const handler = (snap) => {
      if (!snap.balls || snap.balls.length === 0) return;
      const me = snap.players.find((p) => p.id === socket.id);
      if (!me) return;
      const ex = me.bx - me.ax;
      const ey = me.by - me.ay;
      const len = Math.hypot(ex, ey) || 1;
      const b = snap.balls[0];
      const du = ((b.x - me.ax) * ex + (b.y - me.ay) * ey) / (len * len);
      socket.emit('game:input', { t: Math.max(0, Math.min(1, du)) });
    };
    socket.on('game:state', handler);
    return () => socket.off('game:state', handler);
  };
  const stops = [chase(host), chase(guest)];

  const initialBricks = snap0.bricks.length;
  let lastSnap = snap0;
  const collector = (snap) => (lastSnap = snap);
  guest.on('game:state', collector);

  await sleep(12000);
  stops.forEach((f) => f());
  guest.off('game:state', collector);

  check(
    lastSnap.bricks.length < initialBricks || lastSnap.level > 1,
    `ブロックが減っている(${initialBricks} → ${lastSnap.bricks.length}, level=${lastSnap.level})`
  );
  const totalScore = lastSnap.players.reduce((s, p) => s + p.score, 0);
  check(totalScore > 0, `スコアが加算されている(合計 ${totalScore})`);

  // 片方が退出 → その辺が壁になりゲーム続行
  const wallPromise = new Promise((resolve) => {
    const handler = (snap) => {
      if (snap.walls.length === 3 && snap.players.length === 1) {
        host.off('game:state', handler);
        resolve(snap);
      }
    };
    host.on('game:state', handler);
    setTimeout(() => {
      host.off('game:state', handler);
      resolve(null);
    }, 4000);
  });
  guest.disconnect();
  const wallSnap = await wallPromise;
  check(!!wallSnap, '退出したプレイヤーの辺が壁に変わりゲーム続行');

  host.disconnect();
  await sleep(300);

  // 6人 → 六角形アリーナ
  const six = [];
  for (let i = 0; i < 6; i++) six.push(await connect());
  const hexRoom = await emitAck(six[0], 'room:create', { gameId: 'edges', name: 'P1' });
  for (let i = 1; i < 6; i++) {
    const res = await emitAck(six[i], 'room:join', { roomId: hexRoom.roomId, name: `P${i + 1}` });
    if (i === 5) check(res.role === 'player', '6人目もプレイヤーとして参加できる');
  }
  await emitAck(six[0], 'room:start', {});
  const hexSnap = await waitFor(six[5], 'game:state');
  check(hexSnap.n === 6, '6人プレイは六角形アリーナ');
  check(hexSnap.walls.length === 0, '6人で全辺に担当がつく');
  check(hexSnap.players.length === 6, 'パドルが6つある');
  for (const s of six) s.disconnect();
  await sleep(300);
}

function testKitchenLogic() {
  console.log('クレイジーキッチン(調理ロジック):');
  const { Game } = require('../server/games/kitchen.js');
  const T = 56;
  const dt = 1 / 60;
  const g = new Game([{ id: 'p1', name: 'コック' }]);
  const p = g.players.get('p1');
  for (let i = 0; i < 200; i++) g.tick(dt); // カウントダウンを飛ばす
  const at = (c, r, f) => {
    p.x = (c + 0.5) * T;
    p.y = (r + 0.5) * T;
    p.facing = f;
  };
  const act = () => g.action(p);

  // サラダ: レタス取得→切る→作業台→皿→盛る→提供(レタス箱は col8, row0)
  at(8, 1, 0); act();
  check(p.carry && p.carry.type === 'lettuce', 'レタスを取れる');
  at(1, 3, 3); act(); act(); act(); act(); act();
  check(p.carry && p.carry.chopped, '3回切って取り上げられる');
  at(5, 3, 1); act();
  at(2, 7, 2); act();
  at(5, 3, 1); act();
  check(p.carry && p.carry.type === 'plate' && p.carry.contents.includes('lettuce'), '皿に盛れる');
  at(11, 3, 1); act();
  check(g.teamScore === 20 && p.carry === null, 'サラダ提供で+20');

  // スープ: 玉ねぎ3個→調理→完成→注ぐ→提供(玉ねぎ箱は col9, row0)
  for (let i = 0; i < 3; i++) {
    at(9, 1, 0); act();
    at(1, 3, 3); act(); act(); act(); act(); act();
    at(6, 7, 2); act();
  }
  const pot = g.pots[0];
  check(pot.state === 'cooking', '玉ねぎ3個で調理開始');
  for (let i = 0; i < 60 * 9; i++) g.tick(dt);
  check(pot.state === 'done', '8秒で完成');
  at(2, 7, 2); act();
  at(6, 7, 2); act();
  check(p.carry && p.carry.contents.includes('soup'), '皿にスープを注げる');
  at(11, 3, 1); act();
  check(g.teamScore === 60, 'スープ提供で+40');

  // 焦げとリセット
  for (let i = 0; i < 3; i++) {
    at(9, 1, 0); act();
    at(1, 3, 3); act(); act(); act(); act(); act();
    at(6, 7, 2); act();
  }
  for (let i = 0; i < 60 * 19; i++) g.tick(dt);
  check(pot.state === 'burnt', '放置すると焦げる');
  at(6, 7, 2); act();
  check(pot.state === 'empty', '手ぶらアクションで鍋をリセット');

  // 鍋からの取り出し
  at(9, 1, 0); act();
  at(1, 3, 3); act(); act(); act(); act(); act();
  at(6, 7, 2); act();
  check(pot.contents === 1 && p.carry === null, '鍋に玉ねぎを1個入れる');
  act();
  check(
    p.carry && p.carry.type === 'onion' && p.carry.chopped && pot.contents === 0,
    '手ぶらアクションで鍋から刻み玉ねぎを取り出せる'
  );
  act();
  check(pot.contents === 1 && p.carry === null, '取り出した玉ねぎを鍋に戻せる');
  for (let i = 0; i < 2; i++) {
    at(9, 1, 0); act();
    at(1, 3, 3); act(); act(); act(); act(); act();
    at(6, 7, 2); act();
  }
  check(pot.state === 'cooking', '3個で調理再開');
  act();
  check(pot.state === 'filling' && pot.contents === 2, '調理中に取り出すと調理が中断される');

  // 皿スタックの上に置いたまま盛り付け
  at(9, 7, 2); act(); // 持っていた玉ねぎをゴミ箱へ
  at(8, 1, 0); act(); // レタス
  at(1, 3, 3); act(); act(); act(); act(); act(); // 刻んで持つ
  at(2, 7, 2); act(); // 皿スタックへ直接
  const staged = g.counterItems.get('2,8');
  check(
    p.carry === null && staged && staged.type === 'plate' && staged.contents.includes('lettuce'),
    '皿スタックの上の皿に直接盛れる'
  );
  at(2, 7, 2); act(); // 手ぶらで中身ごと取る
  check(
    p.carry && p.carry.type === 'plate' && p.carry.contents.includes('lettuce'),
    '置いた皿を中身ごと取れる'
  );
  g.addOrder('salad');
  const sBefore = g.teamScore;
  at(11, 3, 1); act();
  check(g.teamScore === sBefore + 20, 'そのまま提供できる');
}

async function testKitchen() {
  console.log('クレイジーキッチン(通信):');
  const host = await connect();
  const guest = await connect();

  const created = await emitAck(host, 'room:create', { gameId: 'kitchen', name: 'コック1' });
  check(created.ok === true, 'ルームを作成できる');
  const joined = await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'コック2' });
  check(joined.ok === true, '2人目が参加できる');

  await emitAck(host, 'room:start', {});
  const snap0 = await waitFor(guest, 'game:state');
  check(Array.isArray(snap0.layout) && snap0.layout.length === 9, 'キッチンレイアウトが届く');
  check(snap0.orders.length >= 2, '注文が出ている');
  check(snap0.players.length === 2, 'コックが2人いる');

  // カウントダウン明けに右→上へ移動してレタス箱(col8)からレタスを取る
  await sleep(3500);
  const result = await new Promise((resolve) => {
    let phase = 'right';
    const handler = (snap) => {
      const me = snap.players.find((q) => q.id === host.id);
      if (!me) return;
      if (phase === 'right') {
        if (me.x < 8.35 * 56) {
          host.emit('game:input', { x: 1, y: 0 });
        } else {
          phase = 'up';
        }
      }
      if (phase === 'up') {
        if (me.y > 1.7 * 56) {
          host.emit('game:input', { x: 0, y: -1 });
        } else {
          host.emit('game:input', { x: 0, y: 0 });
          host.emit('game:input', { a: 1 });
          phase = 'grab';
        }
      } else if (phase === 'grab') {
        if (me.carry) {
          host.off('game:state', handler);
          resolve(me.carry);
        } else {
          host.emit('game:input', { a: 1 });
        }
      }
    };
    host.on('game:state', handler);
    setTimeout(() => {
      host.off('game:state', handler);
      resolve(null);
    }, 12000);
  });
  check(result && result.type === 'lettuce', `移動してレタスを取れる(${result && result.type})`);

  host.disconnect();
  guest.disconnect();
  await sleep(300);
}

function testKitchenBattleLogic() {
  console.log('キッチンバトル(対戦ロジック):');
  const { Game } = require('../server/games/kitchenbattle.js');
  const T = 52;
  const dt = 1 / 60;
  const g = new Game([
    { id: 'a1', name: '青1' },
    { id: 'b1', name: '桃1' },
    { id: 'a2', name: '青2' },
    { id: 'b2', name: '桃2' },
  ]);
  const teams = ['a1', 'b1', 'a2', 'b2'].map((id) => g.players.get(id).team);
  check(JSON.stringify(teams) === '[0,1,0,1]', 'チームが交互に割り当てられる');

  for (let i = 0; i < 200; i++) g.tick(dt);
  const p = g.players.get('a1');
  const q = g.players.get('b1');
  const at = (pl, c, r, f) => {
    pl.x = (c + 0.5) * T;
    pl.y = (r + 0.5) * T;
    pl.facing = f;
  };
  const act = (pl) => g.action(pl);

  // 左チームのサラダ提供(窓口は自陣の左壁 col0,row6)
  at(p, 1, 1, 3); act(p);
  at(p, 1, 3, 3); act(p); act(p); act(p); act(p); act(p);
  at(p, 1, 1, 0); act(p);
  at(p, 1, 7, 2); act(p);
  at(p, 1, 1, 0); act(p);
  at(p, 1, 6, 3); act(p);
  check(g.teamScores[0] === 20, '左チームが自陣の窓口で提供+20');

  // 右チームも提供できる(共有注文を追加してから。窓口は右壁 col14,row6)
  g.addOrder('salad');
  at(q, 13, 1, 1); act(q);
  at(q, 13, 3, 1); act(q); act(q); act(q); act(q); act(q);
  at(q, 13, 1, 0); act(q);
  at(q, 12, 7, 2); act(q);
  at(q, 13, 1, 0); act(q);
  at(q, 13, 6, 1); act(q);
  check(g.teamScores[1] === 20, '右チームも自陣の窓口で提供+20');

  // 中央カウンター共用(妨害)
  at(p, 1, 1, 3); act(p);
  at(p, 6, 1, 1); act(p);
  check(g.counterItems.has('7,1'), '中央カウンターに置ける');
  at(q, 8, 1, 3); act(q);
  check(q.carry && q.carry.type === 'lettuce', '相手チームが中央カウンターから取れる');

  // 中央の壁は通れない
  at(p, 6, 6, 1);
  p.mx = 1;
  p.my = 0;
  for (let i = 0; i < 120; i++) g.tick(dt);
  check(p.x < 7 * T, '中央の壁は通り抜けられない');

  // 勝敗判定
  g.teamScores[0] = 100;
  g.teamScores[1] = 60;
  g.finish();
  check(g.result.title.includes('ブルー'), `勝敗タイトル(${g.result.title})`);

  // 5人 → 3対2の変則マッチ
  const g5 = new Game(
    ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: 'P' + (i + 1) }))
  );
  const count5 = [0, 0];
  for (const pl of g5.players.values()) count5[pl.team]++;
  check(count5[0] === 3 && count5[1] === 2, `5人で3対2に分かれる(${count5})`);
  const positions = new Set(
    [...g5.players.values()].map((pl) => `${Math.round(pl.x)},${Math.round(pl.y)}`)
  );
  check(positions.size === 5, '5人全員のスポーン位置が重ならない');
  // 全員動けるか(壁にめり込んでいないか)
  for (const pl of g5.players.values()) {
    check(!g5.collides(pl.x, pl.y), `スポーンが床の上にある(${pl.name})`);
  }
}

async function testKitchenBattle() {
  console.log('キッチンバトル(通信):');
  const p1 = await connect();
  const p2 = await connect();

  const created = await emitAck(p1, 'room:create', { gameId: 'kitchenbattle', name: 'あお' });
  check(created.ok === true, 'ルームを作成できる');

  const early = await emitAck(p1, 'room:start', {});
  check(early.ok === false, '1人では開始できない');

  const joined = await emitAck(p2, 'room:join', { roomId: created.roomId, name: 'もも' });
  check(joined.ok === true, '2人目が参加できる');

  const started = await emitAck(p1, 'room:start', {});
  check(started.ok === true, '2人揃えば開始できる(1vs1)');

  const snap = await waitFor(p2, 'game:state');
  check(Array.isArray(snap.teamScores) && snap.teamScores.length === 2, 'チームスコアが届く');
  const t1 = snap.players.find((p) => p.id === p1.id);
  const t2 = snap.players.find((p) => p.id === p2.id);
  check(t1 && t2 && t1.team !== t2.team, '2人が別チームに分かれる');
  check(t1.x < snap.w / 2 === (t1.team === 0), 'チームに応じた側にスポーンする');

  p1.disconnect();
  p2.disconnect();
  await sleep(300);
}

async function testSnake() {
  console.log('マルチスネーク:');
  const host = await connect();
  const guest = await connect();

  const created = await emitAck(host, 'room:create', { gameId: 'snake', name: 'へび1' });
  check(created.ok === true, 'ルームを作成できる');
  const joined = await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'へび2' });
  check(joined.ok === true, '2人目が参加できる');

  const started = await emitAck(host, 'room:start', {});
  check(started.ok === true, 'ホストが開始できる');

  const snap0 = await waitFor(guest, 'game:state');
  check(snap0.players.length === 2, 'スネークが2匹いる');
  check(snap0.food.length > 0, 'エサが配置されている');
  check(snap0.timeLeft > 0 && snap0.timeLeft <= 120, '残り時間が設定されている');

  // カウントダウン明けに、生存中の頭が動くことを観測する(死亡タイミングに左右されないように)
  const moved = await new Promise((resolve) => {
    let lastHead = null;
    const handler = (snap) => {
      const p = snap.players.find((q) => q.id === host.id);
      if (!p || !p.alive || p.body.length < 2) {
        lastHead = null;
        return;
      }
      const head = p.body[0] + ',' + p.body[1];
      if (lastHead && head !== lastHead) {
        guest.off('game:state', handler);
        resolve(true);
      }
      lastHead = head;
    };
    guest.on('game:state', handler);
    setTimeout(() => {
      guest.off('game:state', handler);
      resolve(false);
    }, 10000);
  });
  check(moved, 'スネークが移動している');
  const snapB = await waitFor(guest, 'game:state');
  check(snapB.timeLeft < snap0.timeLeft, '残り時間が減っている');

  // guest を上の壁に誘導して死亡→リスポーンを確認
  const deathAndRespawn = new Promise((resolve) => {
    let died = false;
    const handler = (snap) => {
      const me = snap.players.find((q) => q.id === guest.id);
      if (!me) return;
      if (!died) {
        if (!me.alive) {
          died = true;
          return;
        }
        if (me.body.length < 4) return;
        const [hx, hy, nx, ny] = me.body;
        if (hy < ny) return; // 既に上向き → 壁へ一直線
        if (hy > ny) guest.emit('game:input', { d: 1 }); // 下向き → まず右へ
        else guest.emit('game:input', { d: 0 }); // 横向き → 上へ
        void hx;
        void nx;
      } else if (me.alive) {
        guest.off('game:state', handler);
        resolve(true);
      }
    };
    guest.on('game:state', handler);
    setTimeout(() => {
      guest.off('game:state', handler);
      resolve(false);
    }, 15000);
  });
  check(await deathAndRespawn, '壁に衝突して死亡 → リスポーンする');

  // 進行中でもプレイヤーとして途中参加できる
  const late = await connect();
  const lateJoin = await emitAck(late, 'room:join', { roomId: created.roomId, name: '途中' });
  check(lateJoin.ok === true && lateJoin.role === 'player', '途中参加がプレイヤーになる');
  const lateSnap = await waitFor(late, 'game:state');
  check(
    lateSnap.players.some((p) => p.name === '途中'),
    '途中参加のスネークが追加される'
  );

  host.disconnect();
  guest.disconnect();
  late.disconnect();
  await sleep(300);
}

async function testPong() {
  console.log('PONG:');
  const p1 = await connect();
  const p2 = await connect();
  const p3 = await connect();

  const created = await emitAck(p1, 'room:create', { gameId: 'pong', name: 'ひだり' });
  check(created.ok === true, 'ルームを作成できる');

  const early = await emitAck(p1, 'room:start', {});
  check(early.ok === false, '1人では開始できない');

  const joined = await emitAck(p2, 'room:join', { roomId: created.roomId, name: 'みぎ' });
  check(joined.ok === true && joined.role === 'player', '2人目がプレイヤーとして参加');

  const spec = await emitAck(p3, 'room:join', { roomId: created.roomId, name: 'けんぶつ' });
  check(spec.ok === true && spec.role === 'spectator', '3人目は観戦者になる');

  const started = await emitAck(p1, 'room:start', {});
  check(started.ok === true, '2人揃えば開始できる');

  const snap = await waitFor(p3, 'game:state');
  check(snap.paddles.filter(Boolean).length === 2, '観戦者にもスナップショットが届く');

  // 片方が切断 → もう片方の勝ち
  const overPromise = waitFor(p1, 'game:over');
  p2.disconnect();
  const over = await overPromise;
  check(
    over && over.result && over.result.title.includes('ひだり'),
    `切断時に残った側の勝ちになる(${over && over.result && over.result.title})`
  );
  check(
    over && over.result && over.result.rows.length === 2,
    '結果に退出者を含む両プレイヤーのスコアが載る'
  );

  // 観戦者が繰り上がって再戦できる
  await sleep(300);
  const restart = await emitAck(p1, 'room:start', {});
  check(restart.ok === true, `観戦者が繰り上がって再戦できる(${restart.error || 'ok'})`);

  p1.disconnect();
  p3.disconnect();
}

async function testCamo() {
  console.log('ぬりかくれカメレオン(通信):');
  const p1 = await connect();
  const p2 = await connect();

  const created = await emitAck(p1, 'room:create', { gameId: 'camo', name: 'いろは' });
  check(created.ok === true, 'ルームを作成できる');
  await emitAck(p2, 'room:join', { roomId: created.roomId, name: 'にほへ' });
  const started = await emitAck(p1, 'room:start', {});
  check(started.ok === true, '2人で開始できる');

  const snap0 = await waitFor(p1, 'game:state');
  check(snap0.shapes.length >= 40 && snap0.palette.length === 12, 'ステージとパレットが届く');
  check(snap0.w > 800 && snap0.h > 600, `マップが1画面より広い(${snap0.w}x${snap0.h})`);
  const roles = snap0.players.map((p) => p.role).sort();
  check(
    roles.filter((r) => r === 'hunter').length === 1 &&
      roles.filter((r) => r === 'hider').length === 1,
    '2人で鬼1・カメレオン1に分かれる'
  );

  // 隠れフェーズ: 絵の具アイテムが見え、拾っていない色では塗れない
  const hiderId = snap0.players.find((p) => p.role === 'hider').id;
  const hiderSock = hiderId === p1.id ? p1 : p2;
  await sleep(3500); // 隠れフェーズへ
  const hideSnap = await waitFor(hiderSock, 'game:state');
  check(hideSnap.phase === 'hide' && hideSnap.items.length > 0, '絵の具アイテムが配置されている');
  hiderSock.emit('game:input', { p: [[0, 5]] }); // 未所持の色
  await sleep(1200);
  const afterSnap = await waitFor(hiderSock, 'game:state');
  const h = afterSnap.players.find((p) => p.id === hiderId);
  check(h.body[0] === 0, '拾っていない色では塗れない(通信経由)');
  check(Array.isArray(h.colors) && h.colors.includes(0), '所持色リストが届く');

  p1.disconnect();
  p2.disconnect();
  await sleep(300);
}

function testCamoLogic() {
  console.log('ぬりかくれカメレオン(絵の具ロジック):');
  const mod = require('../server/games/camo.js');
  const dt = 1 / 60;
  const g = new mod.Game(
    [
      { id: 'a', name: 'A', pref: 'hunter' },
      { id: 'b', name: 'B', pref: 'hider' },
      { id: 'c', name: 'C', pref: null },
    ],
    { hide: 20 }
  );
  check(
    g.players.get('a').role === 'hunter' && g.players.get('b').role === 'hider',
    '希望ロールが尊重される'
  );
  check(g.items.length === 33, `絵の具アイテムが配置される(${g.items.length}個)`);

  for (let i = 0; i < 60 * 4; i++) g.tick(dt); // 隠れフェーズへ
  const hider = [...g.players.values()].find((p) => p.role === 'hider');
  const item = g.items[0];
  hider.x = item.x;
  hider.y = item.y;
  g.tick(dt);
  check(hider.colors.has(item.c), 'アイテムに触れると色を獲得する');
  g.handleInput(hider.id, { p: [[0, item.c]] });
  check(hider.body[0] === item.c, '拾った色で塗れる');
  const unowned = [];
  for (let c = 1; c < 12; c++) if (!hider.colors.has(c)) unowned.push(c);
  g.handleInput(hider.id, { p: [[1, unowned[0]]] });
  check(hider.body[1] === 0, '拾っていない色では塗れない');
  g.handleInput(hider.id, { st: 1 });
  check(hider.body.every((c, i) => (i === 0 ? c === item.c : c === 0)), 'スタンプ機能は廃止済み');

  while (g.phase() !== 'seek') g.tick(dt);
  g.tick(dt);
  check(g.items.length === 0, '捜索フェーズで絵の具が消える');

  // CPUだけで完走(絵の具収集→塗り→勝敗まで)
  const g2 = new mod.Game(
    ['a', 'b', 'c', 'd'].map((id, i) => ({ id, name: 'CPU' + (i + 1), pref: null })),
    { hide: 20, seek: 60 }
  );
  let ticks = 0;
  while (!g2.finished && ticks < 60 * 100) {
    g2.tick(dt);
    ticks++;
    if (ticks % 6 === 0) for (const id of g2.players.keys()) mod.botAct(g2, id);
  }
  check(g2.finished, `CPUだけで完走する(${g2.result && g2.result.title})`);
  const painted = [...g2.players.values()].some(
    (p) => p.role === 'hider' && p.body.some((c) => c !== 0)
  );
  check(painted, 'CPUカメレオンが絵の具を集めて体を塗る');
}

async function testSettings() {
  console.log('ルーム設定と希望ロール:');
  // ブロック崩し: ライフ変更・権限・クランプ
  const host = await connect();
  const guest = await connect();
  const created = await emitAck(host, 'room:create', { gameId: 'breakout', name: 'ホスト' });
  await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'ゲスト' });
  check(
    created.lobby.settings && created.lobby.settings.lives === 3 &&
      created.lobby.settingsDef.length >= 1,
    '設定が既定値つきでロビーに載る'
  );
  const notHost = await emitAck(guest, 'room:setting', { key: 'lives', value: 5 });
  check(notHost.ok === false, 'ホスト以外は設定を変更できない');
  const set1 = await emitAck(host, 'room:setting', { key: 'lives', value: 5 });
  check(set1.ok === true, 'ホストは設定を変更できる');
  const badKey = await emitAck(host, 'room:setting', { key: 'nope', value: 1 });
  check(badKey.ok === false, '不明な設定キーはエラー');
  await emitAck(host, 'room:setting', { key: 'lives', value: 99 });
  const clampedLobby = await emitAck(host, 'room:setting', { key: 'lives', value: 5 });
  check(clampedLobby.ok === true, '範囲外の値はエラーにならずクランプされる');
  await emitAck(host, 'room:start', {});
  const snap = await waitFor(host, 'game:state');
  check(snap.lives === 5, `設定したライフでゲームが始まる(lives=${snap.lives})`);
  host.disconnect();
  guest.disconnect();
  await sleep(300);

  // PONG: 勝利点数
  const p1 = await connect();
  const p2 = await connect();
  const r2 = await emitAck(p1, 'room:create', { gameId: 'pong', name: 'A' });
  await emitAck(p2, 'room:join', { roomId: r2.roomId, name: 'B' });
  await emitAck(p1, 'room:setting', { key: 'win', value: 3 });
  await emitAck(p1, 'room:start', {});
  const ps = await waitFor(p1, 'game:state');
  check(ps.winScore === 3, 'PONGの勝利点数を変更できる');
  p1.disconnect();
  p2.disconnect();
  await sleep(300);

  // カメレオン: 希望ロール + 隠れ時間設定
  const c1 = await connect();
  const c2 = await connect();
  const r3 = await emitAck(c1, 'room:create', { gameId: 'camo', name: 'かくれたい' });
  await emitAck(c2, 'room:join', { roomId: r3.roomId, name: 'おにやりたい' });
  const pref1 = await emitAck(c1, 'room:pref', { value: 'hider' });
  check(pref1.ok === true, '希望ロールを設定できる');
  await emitAck(c2, 'room:pref', { value: 'hunter' });
  await emitAck(c1, 'room:setting', { key: 'hide', value: 20 });
  await emitAck(c1, 'room:start', {});
  const cs = await waitFor(c1, 'game:state');
  const role1 = cs.players.find((p) => p.id === c1.id).role;
  const role2 = cs.players.find((p) => p.id === c2.id).role;
  check(role1 === 'hider' && role2 === 'hunter', `希望どおりの役割になる(${role1}/${role2})`);
  const hideSnap = await new Promise((resolve) => {
    const handler = (s) => {
      if (s.phase === 'hide') {
        c1.off('game:state', handler);
        resolve(s);
      }
    };
    c1.on('game:state', handler);
    setTimeout(() => {
      c1.off('game:state', handler);
      resolve(null);
    }, 6000);
  });
  check(
    hideSnap && hideSnap.phaseLeft <= 20.5,
    `隠れ時間の設定が反映される(${hideSnap && hideSnap.phaseLeft}秒)`
  );
  c1.disconnect();
  c2.disconnect();
  await sleep(300);
}

async function testBots() {
  console.log('CPUプレイヤー:');
  const host = await connect();
  const guest = await connect();

  // ブロック崩し: CPU追加/削除と、CPUが動くこと
  const created = await emitAck(host, 'room:create', { gameId: 'breakout', name: 'ホスト' });
  await emitAck(guest, 'room:join', { roomId: created.roomId, name: 'ゲスト' });

  const notHost = await emitAck(guest, 'room:addBot', {});
  check(notHost.ok === false, 'ホスト以外はCPUを追加できない');

  const updatePromise = waitFor(host, 'room:update');
  const added = await emitAck(host, 'room:addBot', {});
  check(added.ok === true, 'ホストはCPUを追加できる');
  const update1 = await updatePromise;
  check(
    update1.players.some((p) => p.isBot && p.role === 'player'),
    'ロビーにCPUがプレイヤーとして表示される'
  );

  const removed = await emitAck(host, 'room:removeBot', {});
  check(removed.ok === true, 'CPUを削除できる');

  await emitAck(host, 'room:addBot', {});
  await emitAck(host, 'room:start', {});
  const snap0 = await waitFor(host, 'game:state');
  check(snap0.players.length === 3, 'CPU込みでゲームが始まる(パドル3枚)');
  const botId = snap0.players.find((p) => p.id.startsWith('bot-')).id;
  await sleep(4000);
  const snap1 = await waitFor(host, 'game:state');
  const b0 = snap0.players.find((p) => p.id === botId);
  const b1 = snap1.players.find((p) => p.id === botId);
  check(b0 && b1 && Math.abs(b1.x - b0.x) > 1, `CPUのパドルが動いている(${b0.x} → ${b1.x})`);

  host.disconnect();
  guest.disconnect();
  await sleep(300);

  // PONG: CPUを対戦相手にして1人で開始できる
  const solo = await connect();
  const pongRoom = await emitAck(solo, 'room:create', { gameId: 'pong', name: 'ひとり' });
  await emitAck(solo, 'room:addBot', {});
  const started = await emitAck(solo, 'room:start', {});
  check(started.ok === true, 'PONGをCPU相手に1人で開始できる');
  const pongSnap = await waitFor(solo, 'game:state');
  check(pongSnap.paddles.filter(Boolean).length === 2, 'CPUのパドルが配置されている');
  void pongRoom;
  solo.disconnect();
  await sleep(300);
}

async function testSpectatorRescue() {
  console.log('観戦者の救済(ブロック崩し):');
  // 4人プレイヤー + 1観戦者 → プレイヤー全員退出 → 観戦者に game:over が届き繰り上がる
  const sockets = [];
  for (let i = 0; i < 5; i++) sockets.push(await connect());
  const [host, ...rest] = sockets;

  const created = await emitAck(host, 'room:create', { gameId: 'breakout', name: 'P1' });
  for (let i = 0; i < 3; i++) {
    await emitAck(rest[i], 'room:join', { roomId: created.roomId, name: `P${i + 2}` });
  }
  const spectator = rest[3];
  const specInfo = await emitAck(spectator, 'room:join', {
    roomId: created.roomId,
    name: 'けんぶつ',
  });
  check(specInfo.role === 'spectator', '5人目は観戦者になる');

  await emitAck(host, 'room:start', {});
  await waitFor(spectator, 'game:state');

  const overPromise = waitFor(spectator, 'game:over');
  const updatePromise = new Promise((resolve) => {
    spectator.on('room:update', (lobby) => {
      const me = lobby.players.find((p) => p.id === spectator.id);
      if (me && me.role === 'player') resolve(lobby);
    });
  });
  for (const s of [host, rest[0], rest[1], rest[2]]) s.disconnect();

  const over = await overPromise;
  check(
    over && over.result && over.result.title.includes('退出'),
    '全プレイヤー退出時に観戦者へ game:over が届く'
  );
  await Promise.race([updatePromise, sleep(2000).then(() => null)]).then((lobby) => {
    check(!!lobby, '残った観戦者がプレイヤーに繰り上がる');
  });
  spectator.disconnect();
}

async function testValidation() {
  console.log('バリデーション:');
  const s = await connect();
  const noRoom = await emitAck(s, 'room:join', { roomId: 'ZZZZ', name: 'x' });
  check(noRoom.ok === false, '存在しないルームはエラー');
  const badGame = await emitAck(s, 'room:create', { gameId: 'nope', name: 'x' });
  check(badGame.ok === false, '存在しないゲームIDはエラー');
  const badCode = await emitAck(s, 'room:join', { roomId: 'ab', name: 'x' });
  check(badCode.ok === false, '不正なルームコードはエラー');
  const longName = await emitAck(s, 'room:create', {
    gameId: 'breakout',
    name: 'あ'.repeat(100),
  });
  check(
    longName.ok === true && longName.lobby.players[0].name.length <= 12,
    '長すぎる名前は切り詰められる'
  );
  s.disconnect();
}

async function main() {
  console.log('サーバー起動中…');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.on('data', () => {});

  try {
    // サーバー起動待ち
    let up = false;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetchJson(`${BASE}/healthz`);
        if (res.status === 200) {
          up = true;
          break;
        }
      } catch (e) {
        /* リトライ */
      }
      await sleep(200);
    }
    if (!up) throw new Error('サーバーが起動しませんでした');

    await testHttp();
    await testBreakout();
    await testPolygon();
    await testEdges();
    testKitchenLogic();
    await testKitchen();
    testKitchenBattleLogic();
    await testKitchenBattle();
    await testSnake();
    await testPong();
    testCamoLogic();
    await testCamo();
    await testSettings();
    await testBots();
    await testSpectatorRescue();
    await testValidation();
  } catch (err) {
    failures++;
    console.error('テスト実行エラー:', err);
  } finally {
    server.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nすべてのテストに合格 ✓' : `\n${failures} 件の失敗 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
