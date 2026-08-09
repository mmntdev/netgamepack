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
    ['breakout', 'polygon', 'pong'].every((id) => games.body.some((g) => g.id === id)),
    'breakout / polygon / pong が登録されている'
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
    await testPong();
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
