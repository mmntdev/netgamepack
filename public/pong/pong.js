/* PONG クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 800;
  const H = 500;
  const SIDE_COLORS = ['#38bdf8', '#f472b6'];

  // ---- 効果音(スナップショット差分から検出) ----
  function sfx(name) {
    if (window.NetSfx) window.NetSfx.play(name);
  }

  let sfxPrev = null;
  let lastDx = null;
  let lastDy = null;

  function sfxDiff(prev, curr) {
    if (!prev) return;
    const sum = (s) => s.paddles.reduce((a, p) => a + (p ? p.score : 0), 0);
    if (sum(curr) > sum(prev)) {
      sfx('score');
      lastDx = null;
      lastDy = null;
    }
    if (prev.ball && curr.ball) {
      const dx = curr.ball.x - prev.ball.x;
      const dy = curr.ball.y - prev.ball.y;
      if (lastDx != null && Math.abs(dx) > 0.5 && Math.sign(dx) !== Math.sign(lastDx)) sfx('paddle');
      if (lastDy != null && Math.abs(dy) > 0.5 && Math.sign(dy) !== Math.sign(lastDy)) sfx('wall');
      lastDx = dx;
      lastDy = dy;
    } else {
      lastDx = null;
      lastDy = null;
    }
  }

  const client = NetGame.createClient({
    gameId: 'pong',
    onGameStart() {
      sfxPrev = null;
      lastDx = null;
      lastDy = null;
    },
    onGameState(snap) {
      sfxDiff(sfxPrev, snap);
      sfxPrev = snap;
    },
  });

  // ---- 入力 ----
  let pointerY = null;
  let keyDir = 0;
  let keyTargetY = H / 2;

  function canvasY(clientY) {
    const rect = canvas.getBoundingClientRect();
    return ((clientY - rect.top) / rect.height) * H;
  }

  canvas.addEventListener('pointermove', (e) => {
    pointerY = canvasY(e.clientY);
  });
  canvas.addEventListener('pointerdown', (e) => {
    pointerY = canvasY(e.clientY);
  });

  function isTypingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || !client.playing) return;
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') keyDir = -1;
    else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') keyDir = 1;
    else return;
    e.preventDefault();
    pointerY = null;
  });
  window.addEventListener('keyup', (e) => {
    if (
      ((e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') && keyDir === -1) ||
      ((e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') && keyDir === 1)
    ) {
      keyDir = 0;
      // 離した瞬間の最終位置を確実に送る
      client.sendInput({ y: Math.round(keyTargetY * 10) / 10 });
    }
  });

  let lastFrameAt = performance.now();

  function myPaddle(snap) {
    if (!snap || !snap.paddles) return null;
    return snap.paddles.find((p) => p && p.id === client.you) || null;
  }

  function updateInput(snap) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    if (client.role !== 'player') return;

    let target = null;
    if (pointerY != null) {
      target = pointerY;
      keyTargetY = pointerY;
    } else if (keyDir !== 0) {
      keyTargetY = Math.max(0, Math.min(H, keyTargetY + keyDir * 600 * dt));
      target = keyTargetY;
    } else {
      const me = myPaddle(snap);
      if (me) keyTargetY = me.y + me.h / 2;
    }

    if (target != null) client.sendInput({ y: Math.round(target * 10) / 10 });
  }

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  const gameScreen = document.querySelector('[data-screen="game"]');

  function render() {
    requestAnimationFrame(render);
    if (gameScreen.classList.contains('hidden')) return; // 非表示中は描画しない
    const rs = client.getRenderState();

    ctx.fillStyle = '#070b18';
    ctx.fillRect(0, 0, W, H);

    // センターライン
    ctx.strokeStyle = 'rgba(143, 155, 196, 0.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 14]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!rs) {
      ctx.fillStyle = '#8f9bc4';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('接続中…', W / 2, H / 2);
      return;
    }

    const { prev, curr, alpha } = rs;
    updateInput(curr);

    // スコアと名前
    curr.paddles.forEach((p, side) => {
      const cx = side === 0 ? W / 4 : (W * 3) / 4;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232, 236, 255, 0.25)';
      ctx.font = 'bold 84px sans-serif';
      ctx.fillText(p ? String(p.score) : '-', cx, 110);
      ctx.fillStyle = p ? SIDE_COLORS[side] : '#475077';
      ctx.font = 'bold 15px sans-serif';
      let label = p ? p.name : '(待機中)';
      if (p && p.id === client.you) label += ' ▲';
      ctx.fillText(label, cx, 140);
    });

    // パドル
    curr.paddles.forEach((p, side) => {
      if (!p) return;
      let y = p.y;
      const pp = prev && prev.paddles && prev.paddles[side];
      if (pp) y = lerp(pp.y, p.y, alpha);
      ctx.save();
      ctx.shadowColor = SIDE_COLORS[side];
      ctx.shadowBlur = 14;
      ctx.fillStyle = SIDE_COLORS[side];
      ctx.fillRect(p.x, y, p.w, p.h);
      ctx.restore();
    });

    // ボール
    if (curr.ball) {
      let x = curr.ball.x;
      let y = curr.ball.y;
      if (prev && prev.ball) {
        x = lerp(prev.ball.x, curr.ball.x, alpha);
        y = lerp(prev.ball.y, curr.ball.y, alpha);
      }
      ctx.save();
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 16;
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(x, y, curr.ball.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (curr.serveIn > 0) {
      ctx.fillStyle = 'rgba(232, 236, 255, 0.85)';
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`READY… ${curr.serveIn.toFixed(1)}`, W / 2, H / 2 + 60);
    }

    if (client.role === 'spectator') {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232,236,255,0.5)';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('👀 観戦中', W / 2, H - 16);
    }
  }

  requestAnimationFrame(render);
})();
