/* ポリゴン・ブロック崩し クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 700;
  const H = 700;
  const CX = W / 2;
  const CY = H / 2;

  const HP_COLORS = { 1: '#22c55e', 2: '#f59e0b', 3: '#ef4444' };
  const POWERUP_STYLE = {
    multi: { color: '#38bdf8', label: 'M' },
    expand: { color: '#a3e635', label: 'W' },
    slow: { color: '#c084fc', label: 'S' },
    life: { color: '#f472b6', label: '+' },
  };
  const PADDLE_THICK = 14;

  // ---- 効果音(スナップショット差分から検出) ----
  function sfx(name) {
    if (window.NetSfx) window.NetSfx.play(name);
  }

  let sfxPrev = null;
  let radialDeltas = [];

  function sfxDiff(prev, curr) {
    if (!prev) return;
    if (curr.level > prev.level) {
      sfx('level');
      radialDeltas = [];
      return;
    }
    const hpSum = (s) => s.bricks.reduce((a, b) => a + b.hp, 0);
    if (curr.bricks.length < prev.bricks.length) sfx('break');
    else if (hpSum(curr) < hpSum(prev)) sfx('brick');

    if (curr.lives < prev.lives) sfx('life');
    if (curr.balls.length > prev.balls.length && prev.balls.length > 0) sfx('multi');
    else if (curr.balls.length < prev.balls.length && curr.lives === prev.lives) sfx('lost');

    if (curr.powerups.length < prev.powerups.length) sfx('powerup');

    // パドル反射(外向き → 内向きに転じた)
    if (prev.balls.length === curr.balls.length) {
      for (let i = 0; i < curr.balls.length; i++) {
        const d =
          Math.hypot(curr.balls[i].x - curr.cx, curr.balls[i].y - curr.cy) -
          Math.hypot(prev.balls[i].x - curr.cx, prev.balls[i].y - curr.cy);
        const pd = radialDeltas[i];
        if (pd != null && pd > 1 && d < -1) sfx('paddle');
        radialDeltas[i] = d;
      }
    } else {
      radialDeltas = [];
    }
  }

  const client = NetGame.createClient({
    gameId: 'polygon',
    onGameStart() {
      sfxPrev = null;
      radialDeltas = [];
    },
    onGameState(snap) {
      sfxDiff(sfxPrev, snap);
      sfxPrev = snap;
    },
  });

  // ---- サーバーと同じ外周ジオメトリ(n と r から再構築) ----
  const geomCache = {};
  function getGeom(n, r) {
    const key = `${n}:${r}`;
    if (geomCache[key]) return geomCache[key];
    const verts = [];
    const phi0 = -Math.PI / 2;
    for (let i = 0; i < n; i++) {
      const a = phi0 + (i * 2 * Math.PI) / n;
      verts.push({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) });
    }
    const edgeLen = 2 * r * Math.sin(Math.PI / n);
    const P = edgeLen * n;
    const edges = verts.map((v, i) => {
      const b = verts[(i + 1) % n];
      const ux = (b.x - v.x) / edgeLen;
      const uy = (b.y - v.y) / edgeLen;
      const mx = (v.x + b.x) / 2 - CX;
      const my = (v.y + b.y) / 2 - CY;
      const ml = Math.hypot(mx, my);
      return { a: v, ux, uy, nx: mx / ml, ny: my / ml };
    });
    const geom = {
      n,
      verts,
      edges,
      edgeLen,
      P,
      wrap(s) {
        return ((s % P) + P) % P;
      },
      diff(a, b) {
        return this.wrap(a - b + P / 2) - P / 2;
      },
      pointAt(s) {
        s = this.wrap(s);
        let idx = Math.floor(s / edgeLen);
        if (idx >= n) idx = n - 1;
        const t = s - idx * edgeLen;
        const e = edges[idx];
        return { x: e.a.x + e.ux * t, y: e.a.y + e.uy * t, nx: e.nx, ny: e.ny };
      },
    };
    geomCache[key] = geom;
    return geom;
  }

  // ---- 入力 ----
  let pointerAngle = null;
  let keyDir = 0;
  let keyAngle = Math.PI / 2; // 真下スタート

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = canvasPos(e);
    pointerAngle = Math.atan2(p.y - CY, p.x - CX);
  });
  canvas.addEventListener('pointerdown', (e) => {
    const p = canvasPos(e);
    pointerAngle = Math.atan2(p.y - CY, p.x - CX);
  });

  function isTypingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || !client.playing) return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyDir = -1;
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyDir = 1;
    else return;
    e.preventDefault();
    pointerAngle = null; // キー操作に切り替え
  });
  window.addEventListener('keyup', (e) => {
    if (
      ((e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') && keyDir === -1) ||
      ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && keyDir === 1)
    ) {
      keyDir = 0;
      client.sendInput({ a: Math.round(keyAngle * 1000) / 1000 });
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
    if (pointerAngle != null) {
      target = pointerAngle;
      keyAngle = pointerAngle;
    } else if (keyDir !== 0) {
      keyAngle += keyDir * 2.4 * dt; // 時計回り=+
      target = keyAngle;
    } else {
      const me = myPaddle(snap);
      if (me) {
        const geom = getGeom(snap.n, snap.r);
        const pt = geom.pointAt(me.s);
        keyAngle = Math.atan2(pt.y - CY, pt.x - CX);
      }
    }

    if (target != null) client.sendInput({ a: Math.round(target * 1000) / 1000 });
  }

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function drawBackground(snap) {
    ctx.fillStyle = '#070b18';
    ctx.fillRect(0, 0, W, H);

    const geom = getGeom(snap.n, snap.r);

    // 外周(境界線)
    ctx.beginPath();
    geom.verts.forEach((v, i) => (i === 0 ? ctx.moveTo(v.x, v.y) : ctx.lineTo(v.x, v.y)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 10]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 中央コア
    ctx.save();
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.beginPath();
    ctx.arc(CX, CY, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
    const geom = getGeom(curr.n, curr.r);
    for (const p of curr.players) {
      let s = p.s;
      const pp = prev && prev.n === curr.n && prev.players.find((q) => q.id === p.id);
      if (pp) s = geom.wrap(pp.s + geom.diff(p.s, pp.s) * alpha);

      const color = paddleColor(p);
      const steps = Math.max(4, Math.ceil((p.hw * 2) / 14));
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = p.expanded ? 18 : 10;
      ctx.strokeStyle = color;
      ctx.lineWidth = PADDLE_THICK;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const pt = geom.pointAt(s - p.hw + ((p.hw * 2) * i) / steps);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.restore();

      // 名前ラベル(外側に少しずらす)
      const mid = geom.pointAt(s);
      const lx = mid.x + mid.nx * 22;
      const ly = mid.y + mid.ny * 22;
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
