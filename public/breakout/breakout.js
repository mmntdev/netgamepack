/* ブロック崩し クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 800;
  const H = 600;

  const HP_COLORS = { 1: '#22c55e', 2: '#f59e0b', 3: '#ef4444' };
  const POWERUP_STYLE = {
    multi: { color: '#38bdf8', label: 'M' },
    expand: { color: '#a3e635', label: 'W' },
    slow: { color: '#c084fc', label: 'S' },
    life: { color: '#f472b6', label: '+' },
  };

  const client = NetGame.createClient({ gameId: 'breakout' });

  // ---- 入力 ----
  let pointerX = null; // 論理座標での目標中心X
  let keyDir = 0;
  let keyTargetX = W / 2;

  function canvasX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }

  canvas.addEventListener('pointermove', (e) => {
    pointerX = canvasX(e.clientX);
  });
  canvas.addEventListener('pointerdown', (e) => {
    pointerX = canvasX(e.clientX);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyDir = -1;
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyDir = 1;
    else return;
    e.preventDefault();
    pointerX = null; // キー操作に切り替え
  });
  window.addEventListener('keyup', (e) => {
    if (
      ((e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') && keyDir === -1) ||
      ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && keyDir === 1)
    ) {
      keyDir = 0;
    }
  });

  function myPaddle(snap) {
    if (!snap || !snap.players) return null;
    return snap.players.find((p) => p.id === client.you) || null;
  }

  let lastFrameAt = performance.now();

  function updateInput(snap) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    if (client.role !== 'player') return;

    let target = null;
    if (pointerX != null) {
      target = pointerX;
      keyTargetX = pointerX;
    } else if (keyDir !== 0) {
      keyTargetX = Math.max(0, Math.min(W, keyTargetX + keyDir * 700 * dt));
      target = keyTargetX;
    } else {
      const me = myPaddle(snap);
      if (me) keyTargetX = me.x + me.w / 2;
    }

    if (target != null) client.sendInput({ x: Math.round(target * 10) / 10 });
  }

  // ---- 描画ヘルパー ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground() {
    ctx.fillStyle = '#070b18';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(56, 100, 200, 0.07)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }

  function drawBricks(bricks) {
    for (const b of bricks) {
      const color = HP_COLORS[b.hp] || HP_COLORS[1];
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.92;
      roundRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 4);
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#ffffff';
      roundRect(b.x + 1.5, b.y + 1.5, b.w - 3, (b.h - 3) * 0.35, 4);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function paddleColor(snap, p) {
    return NetGame.PLAYER_COLORS[p.color % NetGame.PLAYER_COLORS.length];
  }

  function drawPaddles(prev, curr, alpha) {
    for (const p of curr.players) {
      let x = p.x;
      const pp = prev && prev.players && prev.players.find((q) => q.id === p.id);
      if (pp) x = lerp(pp.x, p.x, alpha);

      const color = paddleColor(curr, p);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = p.expanded ? 18 : 10;
      ctx.fillStyle = color;
      roundRect(x, p.y, p.w, p.h, 7);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = 'rgba(232, 236, 255, 0.75)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      const label = p.id === client.you ? `${p.name} ▲` : p.name;
      ctx.fillText(label, x + p.w / 2, p.y + p.h + 14);
    }
  }

  function drawBalls(prev, curr, alpha) {
    curr.balls.forEach((b, i) => {
      let x = b.x;
      let y = b.y;
      const pb = prev && prev.balls && prev.balls[i];
      if (pb && curr.balls.length === prev.balls.length) {
        x = lerp(pb.x, b.x, alpha);
        y = lerp(pb.y, b.y, alpha);
      }
      ctx.save();
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 14;
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  function drawPowerups(powerups) {
    for (const pu of powerups) {
      const style = POWERUP_STYLE[pu.type] || POWERUP_STYLE.multi;
      ctx.save();
      ctx.shadowColor = style.color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(pu.x, pu.y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#071120';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(style.label, pu.x, pu.y + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }

  function drawHud(snap) {
    // ライフ
    ctx.textAlign = 'left';
    ctx.font = '18px sans-serif';
    let hearts = '';
    for (let i = 0; i < snap.lives; i++) hearts += '❤';
    ctx.fillStyle = '#f87171';
    ctx.fillText(hearts, 14, 28);

    // レベル
    ctx.fillStyle = '#8f9bc4';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`LEVEL ${snap.level}`, 14, 50);
    if (snap.slow) {
      ctx.fillStyle = '#c084fc';
      ctx.fillText('SLOW', 90, 50);
    }

    // スコア
    ctx.textAlign = 'right';
    let y = 26;
    for (const p of snap.players) {
      ctx.fillStyle = paddleColor(snap, p);
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(`${p.name}: ${p.score}`, W - 14, y);
      y += 18;
    }

    if (client.role === 'spectator') {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232,236,255,0.5)';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('👀 観戦中', W / 2, 28);
    }
  }

  function drawCenterText(snap) {
    ctx.textAlign = 'center';
    if (snap.banner) {
      ctx.fillStyle = '#e8ecff';
      ctx.font = 'bold 46px sans-serif';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 24;
      ctx.fillText(snap.banner, W / 2, H / 2 - 20);
      ctx.shadowBlur = 0;
    } else if (snap.serveIn > 0) {
      ctx.fillStyle = 'rgba(232,236,255,0.85)';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(`READY… ${snap.serveIn.toFixed(1)}`, W / 2, H / 2 - 20);
    }
  }

  function render() {
    requestAnimationFrame(render);
    const rs = client.getRenderState();
    drawBackground();
    if (!rs) {
      ctx.fillStyle = '#8f9bc4';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('接続中…', W / 2, H / 2);
      return;
    }
    const { prev, curr, alpha } = rs;
    updateInput(curr);
    drawBricks(curr.bricks);
    drawPowerups(curr.powerups);
    drawPaddles(prev, curr, alpha);
    drawBalls(prev, curr, alpha);
    drawHud(curr);
    drawCenterText(curr);
  }

  requestAnimationFrame(render);
})();
