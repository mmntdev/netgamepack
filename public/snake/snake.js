/* マルチスネーク クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 800;
  const H = 600;

  // ---- 効果音(スナップショット差分から検出) ----
  function sfx(name) {
    if (window.NetSfx) window.NetSfx.play(name);
  }

  let sfxPrev = null;

  function sfxDiff(prev, curr) {
    if (!prev) return;
    const me = curr.players.find((p) => p.id === client.you);
    const pmMe = prev.players.find((p) => p.id === client.you);
    if (me && pmMe) {
      if (me.score > pmMe.score) sfx('eat');
      if (pmMe.alive && !me.alive) sfx('die');
      if (!pmMe.alive && me.alive) sfx('respawn');
    }
    // 開始カウントダウンと残り5秒のカウント
    if (curr.countdown > 0 && Math.ceil(curr.countdown) !== Math.ceil(prev.countdown)) sfx('tick');
    if (
      curr.countdown <= 0 &&
      curr.timeLeft <= 5 &&
      Math.ceil(curr.timeLeft) !== Math.ceil(prev.timeLeft)
    ) {
      sfx('tick');
    }
  }

  const client = NetGame.createClient({
    gameId: 'snake',
    onGameStart() {
      sfxPrev = null;
    },
    onGameState(snap) {
      sfxDiff(sfxPrev, snap);
      sfxPrev = snap;
    },
  });

  // ---- 入力(0=上, 1=右, 2=下, 3=左) ----
  const KEY_DIRS = {
    ArrowUp: 0,
    ArrowRight: 1,
    ArrowDown: 2,
    ArrowLeft: 3,
    w: 0,
    W: 0,
    d: 1,
    D: 1,
    s: 2,
    S: 2,
    a: 3,
    A: 3,
  };

  function isTypingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || !client.playing) return;
    const d = KEY_DIRS[e.key];
    if (d === undefined) return;
    e.preventDefault();
    client.sendInput({ d });
  });

  // スワイプ操作
  let swipeStart = null;
  canvas.addEventListener('pointerdown', (e) => {
    swipeStart = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.hypot(dx, dy) < 24) return;
    const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    client.sendInput({ d });
  });

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function snakeColor(p) {
    return NetGame.PLAYER_COLORS[p.color % NetGame.PLAYER_COLORS.length];
  }

  function drawBackground(snap) {
    ctx.fillStyle = '#070b18';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(56, 100, 200, 0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= snap.cw; x++) {
      ctx.beginPath();
      ctx.moveTo(x * snap.cell, 0);
      ctx.lineTo(x * snap.cell, H);
      ctx.stroke();
    }
    for (let y = 0; y <= snap.ch; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * snap.cell);
      ctx.lineTo(W, y * snap.cell);
      ctx.stroke();
    }
    // 外周(壁)
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
  }

  function drawFood(snap, now) {
    for (const f of snap.food) {
      const cx = (f.x + 0.5) * snap.cell;
      const cy = (f.y + 0.5) * snap.cell;
      ctx.save();
      if (f.p) {
        // 死体エサ(小さめ・点滅気味)
        ctx.globalAlpha = 0.65 + 0.35 * Math.sin(now / 180 + f.x + f.y);
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = 8;
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(cx, cy, snap.cell * 0.26, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 10;
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(cx, cy, snap.cell * 0.34, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#22c55e';
        ctx.fillRect(cx - 1.5, cy - snap.cell * 0.5, 3, snap.cell * 0.2);
      }
      ctx.restore();
    }
  }

  function bodyPoints(p, prevP, alpha, cell) {
    // 前スナップショットと長さが同じならセルごとに補間
    const pts = [];
    const n = p.body.length / 2;
    const canLerp = prevP && prevP.alive && prevP.body.length === p.body.length;
    for (let i = 0; i < n; i++) {
      let x = p.body[i * 2];
      let y = p.body[i * 2 + 1];
      if (canLerp) {
        x = lerp(prevP.body[i * 2], x, alpha);
        y = lerp(prevP.body[i * 2 + 1], y, alpha);
      }
      pts.push([(x + 0.5) * cell, (y + 0.5) * cell]);
    }
    return pts;
  }

  function drawSnakes(prev, curr, alpha, now) {
    for (const p of curr.players) {
      if (!p.alive || p.body.length === 0) continue;
      const prevP = prev && prev.players && prev.players.find((q) => q.id === p.id);
      const pts = bodyPoints(p, prevP, alpha, curr.cell);
      if (pts.length === 0) continue;
      const color = snakeColor(p);

      ctx.save();
      if (p.inv) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now / 90);
      // 体(1本の太い線として描く)
      ctx.strokeStyle = color;
      ctx.lineWidth = curr.cell * 0.72;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 頭と目
      const [hx, hy] = pts[0];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(hx, hy, curr.cell * 0.48, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b1020';
      const ex = pts.length > 1 ? Math.sign(hx - pts[1][0]) : 0;
      const ey = pts.length > 1 ? Math.sign(hy - pts[1][1]) : -1;
      // 進行方向に合わせて目をずらす
      const ox = ey !== 0 ? 4.5 : 0;
      const oy = ex !== 0 ? 4.5 : 0;
      ctx.beginPath();
      ctx.arc(hx + ex * 3 + ox, hy + ey * 3 + oy, 2.4, 0, Math.PI * 2);
      ctx.arc(hx + ex * 3 - ox, hy + ey * 3 - oy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 名前ラベル
      ctx.fillStyle = 'rgba(232, 236, 255, 0.8)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      const label = p.id === client.you ? `${p.name} ▲` : p.name;
      ctx.fillText(label, hx, hy - curr.cell * 0.8);
    }
  }

  function drawHud(snap) {
    // 残り時間
    ctx.textAlign = 'center';
    const t = Math.ceil(snap.timeLeft);
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    ctx.fillStyle = snap.timeLeft <= 10 ? '#f87171' : 'rgba(232,236,255,0.85)';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`${mm}:${ss}`, W / 2, 32);

    // スコア(右上)
    ctx.textAlign = 'right';
    let y = 26;
    for (const p of snap.players) {
      ctx.fillStyle = snakeColor(p);
      ctx.font = 'bold 13px sans-serif';
      let line = `${p.name}: ${p.score}`;
      if (!p.alive && p.respawnIn > 0) line += ` (復活 ${p.respawnIn.toFixed(1)})`;
      ctx.fillText(line, W - 14, y);
      y += 18;
    }

    if (client.role === 'spectator') {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(232,236,255,0.5)';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('👀 観戦中', 14, 28);
    }

    // 開始カウントダウン
    if (snap.countdown > 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8ecff';
      ctx.font = 'bold 52px sans-serif';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 24;
      ctx.fillText(String(Math.ceil(snap.countdown)), W / 2, H / 2);
      ctx.shadowBlur = 0;
    }

    // 自分が死んでいる間の表示
    const me = snap.players.find((p) => p.id === client.you);
    if (me && !me.alive && snap.countdown <= 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232,236,255,0.85)';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(
        me.respawnIn > 0 ? `復活まで ${me.respawnIn.toFixed(1)}` : '復活中…',
        W / 2,
        H / 2 - 40
      );
    }
  }

  const gameScreen = document.querySelector('[data-screen="game"]');

  function render() {
    requestAnimationFrame(render);
    if (gameScreen.classList.contains('hidden')) return; // 非表示中は描画しない
    const rs = client.getRenderState();
    if (!rs) {
      ctx.fillStyle = '#070b18';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#8f9bc4';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('接続中…', W / 2, H / 2);
      return;
    }
    const now = performance.now();
    const { prev, curr, alpha } = rs;
    drawBackground(curr);
    drawFood(curr, now);
    drawSnakes(prev, curr, alpha, now);
    drawHud(curr);
  }

  requestAnimationFrame(render);
})();
