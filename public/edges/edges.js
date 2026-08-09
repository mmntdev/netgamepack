/* エッジ・ディフェンス クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 700;
  const H = 700;

  const HP_COLORS = { 1: '#22c55e', 2: '#f59e0b', 3: '#ef4444' };
  const POWERUP_STYLE = {
    multi: { color: '#38bdf8', label: 'M' },
    expand: { color: '#a3e635', label: 'W' },
    slow: { color: '#c084fc', label: 'S' },
    life: { color: '#f472b6', label: '+' },
  };
  const PADDLE_THICK = 14;

  const client = NetGame.createClient({ gameId: 'edges' });

  // ---- 入力 ----
  let pointerPos = null; // 論理座標
  let keyVec = null; // {x,y} 押下中の矢印方向
  let keyFrac = 0.5; // 自分の辺に沿った位置(0..1)

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  canvas.addEventListener('pointermove', (e) => {
    pointerPos = canvasPos(e);
  });
  canvas.addEventListener('pointerdown', (e) => {
    pointerPos = canvasPos(e);
  });

  function isTypingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  const KEY_VECS = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
    a: { x: -1, y: 0 },
    A: { x: -1, y: 0 },
    d: { x: 1, y: 0 },
    D: { x: 1, y: 0 },
    w: { x: 0, y: -1 },
    W: { x: 0, y: -1 },
    s: { x: 0, y: 1 },
    S: { x: 0, y: 1 },
  };

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || !client.playing) return;
    const v = KEY_VECS[e.key];
    if (!v) return;
    e.preventDefault();
    keyVec = v;
    pointerPos = null; // キー操作に切り替え
  });
  window.addEventListener('keyup', (e) => {
    const v = KEY_VECS[e.key];
    if (v && keyVec && v.x === keyVec.x && v.y === keyVec.y) {
      keyVec = null;
      client.sendInput({ t: Math.round(keyFrac * 1000) / 1000 });
    }
  });

  function myPaddle(snap) {
    if (!snap || !snap.players) return null;
    return snap.players.find((p) => p.id === client.you) || null;
  }

  function edgeOf(p) {
    const ex = p.bx - p.ax;
    const ey = p.by - p.ay;
    const len = Math.hypot(ex, ey) || 1;
    return { ux: ex / len, uy: ey / len, len };
  }

  let lastFrameAt = performance.now();

  function updateInput(snap) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
    lastFrameAt = now;

    if (client.role !== 'player') return;
    const me = myPaddle(snap);
    if (!me) return;
    const edge = edgeOf(me);

    let frac = null;
    if (pointerPos != null) {
      // ポインタ位置を自分の辺に射影する
      const du = (pointerPos.x - me.ax) * edge.ux + (pointerPos.y - me.ay) * edge.uy;
      frac = Math.max(0, Math.min(1, du / edge.len));
      keyFrac = frac;
    } else if (keyVec) {
      const dir = keyVec.x * edge.ux + keyVec.y * edge.uy; // 矢印方向を辺方向に射影
      if (dir !== 0) {
        keyFrac = Math.max(0, Math.min(1, keyFrac + Math.sign(dir) * (820 * dt) / edge.len));
      }
      frac = keyFrac;
    } else {
      keyFrac = me.t / edge.len;
    }

    if (frac != null) client.sendInput({ t: Math.round(frac * 1000) / 1000 });
  }

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function roundRectPath(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground(snap) {
    ctx.fillStyle = '#070b18';
    ctx.fillRect(0, 0, W, H);

    // 壁(担当者のいない辺)はしっかり描く
    for (const wall of snap.walls) {
      ctx.save();
      ctx.strokeStyle = '#475077';
      ctx.shadowColor = '#475077';
      ctx.shadowBlur = 8;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wall.ax, wall.ay);
      ctx.lineTo(wall.bx, wall.by);
      ctx.stroke();
      ctx.restore();
    }

    // 担当辺のベースライン(破線=ここを抜かれると失点)
    for (const p of snap.players) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 10]);
      ctx.beginPath();
      ctx.moveTo(p.ax, p.ay);
      ctx.lineTo(p.bx, p.by);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 中央コア
    ctx.save();
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBricks(bricks) {
    for (const b of bricks) {
      const color = HP_COLORS[b.hp] || HP_COLORS[1];
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.92;
      roundRectPath(-b.w / 2 + 1, -b.h / 2 + 1, b.w - 2, b.h - 2, 4);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#ffffff';
      roundRectPath(-b.w / 2 + 1, -b.h / 2 + 1, b.w - 2, (b.h - 2) * 0.4, 4);
      ctx.fill();
      ctx.restore();
    }
  }

  function paddleColor(p) {
    return NetGame.PLAYER_COLORS[p.color % NetGame.PLAYER_COLORS.length];
  }

  function drawPaddles(prev, curr, alpha) {
    for (const p of curr.players) {
      const edge = edgeOf(p);
      let t = p.t;
      const pp = prev && prev.players && prev.players.find((q) => q.id === p.id);
      if (pp) t = lerp(pp.t, p.t, alpha);

      const cx = p.ax + edge.ux * t;
      const cy = p.ay + edge.uy * t;
      const color = paddleColor(p);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = p.expanded ? 18 : 10;
      ctx.strokeStyle = color;
      ctx.lineWidth = PADDLE_THICK;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - edge.ux * p.hw, cy - edge.uy * p.hw);
      ctx.lineTo(cx + edge.ux * p.hw, cy + edge.uy * p.hw);
      ctx.stroke();
      ctx.restore();

      // 名前ラベル(辺の外側)
      const mx = (p.ax + p.bx) / 2 - W / 2;
      const my = (p.ay + p.by) / 2 - H / 2;
      const ml = Math.hypot(mx, my) || 1;
      const lx = cx + (mx / ml) * 24;
      const ly = cy + (my / ml) * 24;
      ctx.fillStyle = 'rgba(232, 236, 255, 0.75)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = p.id === client.you ? `${p.name} ▲` : p.name;
      ctx.fillText(label, lx, ly);
      ctx.textBaseline = 'alphabetic';
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
    ctx.textAlign = 'left';
    ctx.font = '18px sans-serif';
    let hearts = '';
    for (let i = 0; i < snap.lives; i++) hearts += '❤';
    ctx.fillStyle = '#f87171';
    ctx.fillText(hearts, 14, 28);

    ctx.fillStyle = '#8f9bc4';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`LEVEL ${snap.level}`, 14, 50);
    if (snap.slow) {
      ctx.fillStyle = '#c084fc';
      ctx.fillText('SLOW', 90, 50);
    }

    ctx.textAlign = 'right';
    let y = 26;
    for (const p of snap.players) {
      ctx.fillStyle = paddleColor(p);
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
      ctx.font = 'bold 40px sans-serif';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 24;
      ctx.fillText(snap.banner, W / 2, H - 60);
      ctx.shadowBlur = 0;
    } else if (snap.serveIn > 0) {
      ctx.fillStyle = 'rgba(232,236,255,0.85)';
      ctx.font = 'bold 24px sans-serif';
      ctx.fillText(`READY… ${snap.serveIn.toFixed(1)}`, W / 2, H - 60);
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
    const { prev, curr, alpha } = rs;
    updateInput(curr);
    drawBackground(curr);
    drawBricks(curr.bricks);
    drawPowerups(curr.powerups);
    drawPaddles(prev, curr, alpha);
    drawBalls(prev, curr, alpha);
    drawHud(curr);
    drawCenterText(curr);
  }

  requestAnimationFrame(render);
})();
