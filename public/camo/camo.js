/* ぬりかくれカメレオン クライアント描画・入力・お絵描きエディタ */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 800;
  const H = 600;

  // ---- 効果音 ----
  function sfx(name) {
    if (window.NetSfx) window.NetSfx.play(name);
  }

  let sfxPrev = null;

  function sfxDiff(prev, curr) {
    if (!prev) return;
    // 新しい射撃(座標で比較)
    const keyOf = (s) => `${s.x},${s.y}`;
    const prevKeys = new Set(prev.shots.map(keyOf));
    for (const s of curr.shots) {
      if (!prevKeys.has(keyOf(s))) {
        sfx('brick');
        if (s.hit) sfx('die');
      }
    }
    if (prev.phase === 'hide' && curr.phase === 'seek') sfx('order');
    if (curr.countdown > 0 && Math.ceil(curr.countdown) !== Math.ceil(prev.countdown)) sfx('tick');
    const me = curr.players.find((p) => p.id === client.you);
    const pm = prev.players.find((p) => p.id === client.you);
    if (me && pm && pm.alive && !me.alive) sfx('lost');
  }

  const client = NetGame.createClient({
    gameId: 'camo',
    onGameStart() {
      sfxPrev = null;
      pendingPaint.clear();
    },
    onGameState(snap) {
      sfxDiff(sfxPrev, snap);
      sfxPrev = snap;
      updatePaintPanel(snap);
    },
  });

  function me(snap) {
    if (!snap) return null;
    return snap.players.find((p) => p.id === client.you) || null;
  }

  // ---- 移動入力 ----
  const pressed = new Set();
  let joyBase = null;
  let joyVec = { x: 0, y: 0 };
  let joyStartAt = 0;
  let pointerPos = { x: W / 2, y: H / 2 }; // 照準(論理座標)

  function isTypingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * W,
      y: ((e.clientY - rect.top) / rect.height) * H,
    };
  }

  function shoot(x, y) {
    if (!client.playing || client.role !== 'player') return;
    client.socket.emit('game:input', { sx: Math.round(x), sy: Math.round(y) });
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || !client.playing) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) {
        const m = me(sfxPrev);
        if (m && m.role === 'hunter') shoot(pointerPos.x, pointerPos.y);
      }
      return;
    }
    const moveKeys = [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
    ];
    if (moveKeys.includes(e.key)) {
      e.preventDefault();
      pressed.add(e.key.toLowerCase());
    }
  });
  window.addEventListener('keyup', (e) => pressed.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => pressed.clear());

  canvas.addEventListener('pointermove', (e) => {
    pointerPos = canvasPos(e);
    if (joyBase) {
      const dx = e.clientX - joyBase.x;
      const dy = e.clientY - joyBase.y;
      const mag = Math.hypot(dx, dy);
      if (mag < 8) joyVec = { x: 0, y: 0 };
      else {
        const s = Math.min(1, mag / 48);
        joyVec = { x: (dx / mag) * s, y: (dy / mag) * s };
      }
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    joyBase = { x: e.clientX, y: e.clientY };
    joyStartAt = performance.now();
    joyVec = { x: 0, y: 0 };
  });
  window.addEventListener('pointerup', (e) => {
    if (!joyBase) return;
    const dx = e.clientX - joyBase.x;
    const dy = e.clientY - joyBase.y;
    const quickTap = performance.now() - joyStartAt < 250 && Math.hypot(dx, dy) < 10;
    joyBase = null;
    joyVec = { x: 0, y: 0 };
    if (quickTap) {
      const m = me(sfxPrev);
      if (m && m.role === 'hunter') shoot(pointerPos.x, pointerPos.y);
    }
  });

  function keyVector() {
    let x = 0;
    let y = 0;
    if (pressed.has('arrowleft') || pressed.has('a')) x -= 1;
    if (pressed.has('arrowright') || pressed.has('d')) x += 1;
    if (pressed.has('arrowup') || pressed.has('w')) y -= 1;
    if (pressed.has('arrowdown') || pressed.has('s')) y += 1;
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    return { x, y };
  }

  let lastSentMove = '';

  function updateInput() {
    if (client.role !== 'player') return;
    const kv = keyVector();
    const v = kv.x !== 0 || kv.y !== 0 ? kv : joyVec;
    const payload = { x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100 };
    const json = JSON.stringify(payload);
    if (json !== lastSentMove) {
      lastSentMove = json;
      client.sendInput(payload);
    } else if (payload.x !== 0 || payload.y !== 0) {
      client.sendInput(payload);
    }
  }

  // ---- お絵描きエディタ ----
  const paintPanel = document.getElementById('paint-panel');
  const editor = document.getElementById('body-editor');
  const ectx = editor.getContext('2d');
  const paletteRow = document.getElementById('palette-row');
  const btnStamp = document.getElementById('btn-stamp');
  const ECELL = 18; // エディタの1マスサイズ
  let selectedColor = 1;
  let paletteBuilt = false;
  const pendingPaint = new Map(); // idx -> color(送信待ち/反映待ちのローカル上書き)
  let paintQueue = [];
  let painting = false;

  function buildPalette(palette) {
    if (paletteBuilt) return;
    paletteBuilt = true;
    palette.forEach((hex, i) => {
      const b = document.createElement('button');
      b.style.width = '30px';
      b.style.height = '30px';
      b.style.borderRadius = '6px';
      b.style.border = '2px solid transparent';
      b.style.background = hex;
      b.style.cursor = 'pointer';
      b.dataset.idx = String(i);
      b.addEventListener('click', () => {
        selectedColor = i;
        for (const other of paletteRow.children) other.style.border = '2px solid transparent';
        b.style.border = '2px solid #e8ecff';
      });
      if (i === selectedColor) b.style.border = '2px solid #e8ecff';
      paletteRow.appendChild(b);
    });
  }

  function updatePaintPanel(snap) {
    const m = me(snap);
    const show = m && m.role === 'hider' && m.alive && snap.phase === 'hide';
    paintPanel.classList.toggle('hidden', !show);
    if (show) buildPalette(snap.palette);
  }

  function editorCell(e) {
    const rect = editor.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * editor.width;
    const y = ((e.clientY - rect.top) / rect.height) * editor.height;
    const cx = Math.floor(x / ECELL);
    const cy = Math.floor(y / ECELL);
    if (cx < 0 || cy < 0 || cx >= 10 || cy >= 14) return -1;
    return cy * 10 + cx;
  }

  function paintCell(e) {
    const idx = editorCell(e);
    if (idx < 0) return;
    if (pendingPaint.get(idx) === selectedColor) return;
    pendingPaint.set(idx, selectedColor);
    paintQueue.push([idx, selectedColor]);
  }

  editor.addEventListener('pointerdown', (e) => {
    painting = true;
    e.preventDefault();
    paintCell(e);
  });
  editor.addEventListener('pointermove', (e) => {
    if (painting) paintCell(e);
  });
  window.addEventListener('pointerup', () => {
    painting = false;
  });

  // ペイントは150msごとにまとめて送信
  setInterval(() => {
    if (paintQueue.length === 0 || !client.playing || client.role !== 'player') return;
    const batch = paintQueue.splice(0, 64);
    client.socket.emit('game:input', { p: batch });
  }, 150);

  if (btnStamp) {
    btnStamp.addEventListener('click', () => {
      if (!client.playing || client.role !== 'player') return;
      pendingPaint.clear();
      paintQueue = [];
      client.socket.emit('game:input', { st: 1 });
      sfx('pick');
      btnStamp.blur();
    });
  }

  function myBodyCell(m, idx) {
    if (pendingPaint.has(idx)) {
      // サーバーに反映されたらローカル上書きを消す
      if (m.body && m.body[idx] === pendingPaint.get(idx)) pendingPaint.delete(idx);
      else return pendingPaint.get(idx);
    }
    return m.body ? m.body[idx] : 0;
  }

  function drawEditor(snap) {
    const m = me(snap);
    if (!m || !m.body) return;
    for (let cy = 0; cy < 14; cy++) {
      for (let cx = 0; cx < 10; cx++) {
        const idx = cy * 10 + cx;
        ectx.fillStyle = snap.palette[myBodyCell(m, idx)] || '#fff';
        ectx.fillRect(cx * ECELL, cy * ECELL, ECELL, ECELL);
      }
    }
    ectx.strokeStyle = 'rgba(13, 19, 48, 0.35)';
    ectx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      ectx.beginPath();
      ectx.moveTo(i * ECELL, 0);
      ectx.lineTo(i * ECELL, 14 * ECELL);
      ectx.stroke();
    }
    for (let i = 0; i <= 14; i++) {
      ectx.beginPath();
      ectx.moveTo(0, i * ECELL);
      ectx.lineTo(10 * ECELL, i * ECELL);
      ectx.stroke();
    }
  }

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function drawStage(snap) {
    ctx.fillStyle = snap.palette[snap.base];
    ctx.fillRect(0, 0, W, H);
    for (const s of snap.shapes) {
      ctx.fillStyle = snap.palette[s.c];
      if (s.k === 0) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(s.x, s.y, s.w, s.h);
      }
    }
  }

  function drawBody(snap, p, x, y, alpha) {
    const cell = snap.cell;
    const left = x - (snap.bodyW * cell) / 2;
    const top = y - (snap.bodyH * cell) / 2;
    ctx.globalAlpha = alpha;
    const isMe = p.id === client.you;
    for (let cy = 0; cy < snap.bodyH; cy++) {
      for (let cx = 0; cx < snap.bodyW; cx++) {
        const idx = cy * snap.bodyW + cx;
        const c = isMe ? myBodyCell(p, idx) : p.body[idx];
        ctx.fillStyle = snap.palette[c] || '#fff';
        ctx.fillRect(left + cx * cell, top + cy * cell, cell, cell);
      }
    }
    // 小さな目(これだけが手がかり)
    ctx.fillStyle = 'rgba(10, 10, 10, 0.85)';
    ctx.fillRect(left + 2 * cell + 1, top + 2 * cell + 1, 2, 2);
    ctx.fillRect(left + 7 * cell + 1, top + 2 * cell + 1, 2, 2);
    ctx.globalAlpha = 1;
  }

  function drawHunter(snap, p, x, y) {
    ctx.save();
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(x - 9, y - 6, 18, 6); // バイザー
    ctx.restore();
    ctx.fillStyle = 'rgba(232, 236, 255, 0.85)';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`🔫 ${p.name}`, x, y - 22);
  }

  function render() {
    requestAnimationFrame(render);
    if (gameScreen.classList.contains('hidden')) return;
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
    updateInput();
    drawStage(curr);

    const m = me(curr);
    const myRole = m ? m.role : 'spectator';

    // プレイヤー描画
    for (const p of curr.players) {
      let x = p.x;
      let y = p.y;
      const pp = prev && prev.players && prev.players.find((q) => q.id === p.id);
      if (pp) {
        x = lerp(pp.x, p.x, alpha);
        y = lerp(pp.y, p.y, alpha);
      }
      if (p.role === 'hunter') {
        drawHunter(curr, p, x, y);
        continue;
      }
      if (!p.alive) {
        drawBody(curr, p, x, y, 0.22);
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('💀', x, y - 32);
        continue;
      }
      drawBody(curr, p, x, y, 1);
      const isMe = p.id === client.you;
      const teammateVisible =
        curr.phase === 'hide' && myRole === 'hider' && !isMe; // 隠れ中は仲間が分かる
      if (isMe || teammateVisible) {
        ctx.strokeStyle = isMe ? 'rgba(232,236,255,0.85)' : 'rgba(232,236,255,0.35)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
          x - (curr.bodyW * curr.cell) / 2 - 2,
          y - (curr.bodyH * curr.cell) / 2 - 2,
          curr.bodyW * curr.cell + 4,
          curr.bodyH * curr.cell + 4
        );
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(232, 236, 255, 0.8)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(isMe ? `${p.name} ▲` : p.name, x, y + (curr.bodyH * curr.cell) / 2 + 14);
      }
    }

    // 着弾マーク
    for (const s of curr.shots) {
      const a = Math.max(0, 1 - s.age / 2.5);
      ctx.globalAlpha = a;
      ctx.strokeStyle = s.hit ? '#ef4444' : '#0f172a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s.x - 7, s.y - 7);
      ctx.lineTo(s.x + 7, s.y + 7);
      ctx.moveTo(s.x + 7, s.y - 7);
      ctx.lineTo(s.x - 7, s.y + 7);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 鬼の照準(自分が鬼のとき)
    if (m && m.role === 'hunter' && curr.phase === 'seek' && m.alive) {
      const ready = m.cd <= 0;
      ctx.strokeStyle = ready ? 'rgba(239, 68, 68, 0.9)' : 'rgba(148, 163, 184, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pointerPos.x, pointerPos.y, 14, 0, Math.PI * 2);
      ctx.moveTo(pointerPos.x - 20, pointerPos.y);
      ctx.lineTo(pointerPos.x + 20, pointerPos.y);
      ctx.moveTo(pointerPos.x, pointerPos.y - 20);
      ctx.lineTo(pointerPos.x, pointerPos.y + 20);
      ctx.stroke();
      if (!ready) {
        ctx.strokeStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(pointerPos.x, pointerPos.y, 18, -Math.PI / 2, -Math.PI / 2 + (1 - m.cd / 0.8) * Math.PI * 2);
        ctx.stroke();
      }
    }

    // 隠れフェーズ中、鬼にはステージを見せない(カーテン)
    if (curr.phase === 'hide' && myRole === 'hunter') {
      ctx.fillStyle = 'rgba(7, 11, 24, 0.96)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e8ecff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🙈 隠れフェーズ中…', W / 2, H / 2 - 30);
      ctx.font = 'bold 22px sans-serif';
      ctx.fillStyle = '#8f9bc4';
      ctx.fillText(`出動まで ${Math.ceil(curr.phaseLeft)} 秒`, W / 2, H / 2 + 10);
      ctx.font = '14px sans-serif';
      ctx.fillText('カメレオンたちが体をぬって隠れています', W / 2, H / 2 + 44);
    }

    // HUD
    ctx.textAlign = 'center';
    const t = Math.ceil(curr.phaseLeft);
    const label =
      curr.phase === 'hide' ? '🎨 かくれる' : curr.phase === 'seek' ? '🔍 さがす' : '';
    if (label) {
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = 'rgba(13, 19, 48, 0.75)';
      const tw = ctx.measureText(`${label} ${t}秒`).width + 24;
      ctx.fillRect(W / 2 - tw / 2, 8, tw, 30);
      ctx.fillStyle = curr.phase === 'seek' && t <= 10 ? '#f87171' : '#e8ecff';
      ctx.fillText(`${label} ${t}秒`, W / 2, 29);
    }
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = 'rgba(13, 19, 48, 0.75)';
    ctx.fillRect(8, 8, 140, 28);
    ctx.fillStyle = '#a3e635';
    ctx.fillText(`🦎 のこり ${curr.aliveHiders}`, 16, 27);

    if (client.role === 'spectator') {
      ctx.fillStyle = 'rgba(232,236,255,0.6)';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('👀 観戦中', 16, H - 12);
    }

    if (curr.countdown > 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8ecff';
      ctx.font = 'bold 52px sans-serif';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 24;
      ctx.fillText(String(Math.ceil(curr.countdown)), W / 2, H / 2);
      ctx.shadowBlur = 0;
    }

    drawEditor(curr);
  }

  const gameScreen = document.querySelector('[data-screen="game"]');
  requestAnimationFrame(render);
})();
