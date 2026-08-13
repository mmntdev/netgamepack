/* キッチンバトル 2vs2 クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 780;
  const H = 468;

  const ING_COLORS = { lettuce: '#22c55e', tomato: '#ef4444', onion: '#eab308' };
  const ING_EMOJI = { lettuce: '🥬', tomato: '🍅', onion: '🧅', soup: '🍲' };
  const TEAM_COLORS = [
    ['#38bdf8', '#22d3ee'],
    ['#f472b6', '#fb7185'],
  ];

  const client = NetGame.createClient({ gameId: 'kitchenbattle' });

  // ---- 入力 ----
  const pressed = new Set();
  let actionSeq = 1;
  let joyBase = null;
  let joyVec = { x: 0, y: 0 };
  let joyStartAt = 0;
  let lastSentMove = '';

  function isTypingTarget(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  function sendAction() {
    if (!client.playing || client.role !== 'player') return;
    client.socket.emit('game:input', { a: actionSeq++ });
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e) || !client.playing) return;
    if (e.key === ' ' || e.key === 'e' || e.key === 'E' || e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat) sendAction();
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
  window.addEventListener('keyup', (e) => {
    pressed.delete(e.key.toLowerCase());
  });
  window.addEventListener('blur', () => pressed.clear());

  canvas.addEventListener('pointerdown', (e) => {
    joyBase = { x: e.clientX, y: e.clientY };
    joyStartAt = performance.now();
    joyVec = { x: 0, y: 0 };
  });
  window.addEventListener('pointermove', (e) => {
    if (!joyBase) return;
    const dx = e.clientX - joyBase.x;
    const dy = e.clientY - joyBase.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 8) {
      joyVec = { x: 0, y: 0 };
      return;
    }
    const s = Math.min(1, mag / 48);
    joyVec = { x: (dx / mag) * s, y: (dy / mag) * s };
  });
  window.addEventListener('pointerup', (e) => {
    if (!joyBase) return;
    const dx = e.clientX - joyBase.x;
    const dy = e.clientY - joyBase.y;
    if (performance.now() - joyStartAt < 250 && Math.hypot(dx, dy) < 10) sendAction();
    joyBase = null;
    joyVec = { x: 0, y: 0 };
  });

  const btnAction = document.getElementById('btn-action');
  if (btnAction) {
    btnAction.addEventListener('click', (e) => {
      e.preventDefault();
      sendAction();
      btnAction.blur();
    });
  }

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

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function teamColor(p) {
    const set = TEAM_COLORS[p.team] || TEAM_COLORS[0];
    return set[p.member % set.length];
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

  function emojiAt(emoji, x, y, size) {
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, x, y);
    ctx.textBaseline = 'alphabetic';
  }

  function drawTiles(snap) {
    const T = snap.tile;
    for (let r = 0; r < snap.layout.length; r++) {
      for (let c = 0; c < snap.layout[r].length; c++) {
        const ch = snap.layout[r][c];
        const x = c * T;
        const y = r * T;
        if (ch === '.') {
          // チームカラーでうっすら塗り分け
          const left = c < 7;
          ctx.fillStyle =
            (c + r) % 2 === 0
              ? left ? '#0f1830' : '#1a1128'
              : left ? '#0c1428' : '#160e22';
          ctx.fillRect(x, y, T, T);
          continue;
        }
        ctx.fillStyle = '#232c54';
        ctx.fillRect(x, y, T, T);
        ctx.fillStyle = '#2c3a72';
        ctx.fillRect(x + 2, y + 2, T - 4, T - 10);

        const cx = x + T / 2;
        const cy = y + T / 2 - 3;
        if (ch === 'L') emojiAt('🥬', cx, cy, 26);
        else if (ch === 'T') emojiAt('🍅', cx, cy, 26);
        else if (ch === 'O') emojiAt('🧅', cx, cy, 26);
        else if (ch === 'D') emojiAt('🍽️', cx, cy, 24);
        else if (ch === 'X') emojiAt('🗑️', cx, cy, 24);
        else if (ch === 'C') {
          ctx.fillStyle = '#e2e8f0';
          roundRectPath(x + 7, y + 11, T - 14, T - 26, 4);
          ctx.fill();
          emojiAt('🔪', x + T - 14, y + 13, 14);
        } else if (ch === 'W') {
          ctx.fillStyle = 'rgba(251, 191, 36, 0.25)';
          ctx.fillRect(x + 2, y + 2, T - 4, T - 10);
          emojiAt('🛎️', cx, cy, 24);
        } else if (ch === 'P') {
          ctx.fillStyle = '#151a30';
          ctx.fillRect(x + 4, y + 4, T - 8, T - 14);
        }
      }
    }
  }

  function drawItem(item, x, y, small) {
    const r = small ? 8 : 11;
    if (!item) return;
    if (item.type === 'plate') {
      ctx.fillStyle = '#f1f5f9';
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.arc(x, y, r + 1, 0, Math.PI * 2);
      ctx.fill();
      if (item.contents.includes('soup')) {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(x, y, r - 1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        item.contents.forEach((ing, i) => {
          ctx.fillStyle = ING_COLORS[ing] || '#fff';
          ctx.beginPath();
          ctx.arc(x - 5 + i * 10, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      return;
    }
    const color = ING_COLORS[item.type] || '#fff';
    ctx.fillStyle = color;
    if (item.chopped) {
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x - 6 + i * 6, y + (i % 2 === 0 ? -3 : 3), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(x - 3, y - 3, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawStations(snap, now) {
    const T = snap.tile;

    for (const it of snap.counters) {
      drawItem(it.item, (it.c + 0.5) * T, (it.r + 0.5) * T - 4, false);
    }

    for (const b of snap.boards) {
      const x = (b.c + 0.5) * T;
      const y = (b.r + 0.5) * T - 4;
      if (b.item) drawItem(b.item, x, y, false);
      if (b.item && !b.item.chopped && b.progress > 0) {
        ctx.fillStyle = '#0d1330';
        ctx.fillRect(x - 17, y - 22, 34, 6);
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(x - 16, y - 21, 32 * Math.min(1, b.progress / 100), 4);
      }
    }

    for (const pot of snap.pots) {
      const x = (pot.c + 0.5) * T;
      const y = (pot.r + 0.5) * T - 4;
      ctx.fillStyle = pot.state === 'burnt' ? '#1c1917' : '#334155';
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (pot.state === 'burnt') {
        emojiAt('💥', x, y, 16);
      } else if (pot.state === 'done') {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fill();
        const puls = 0.5 + 0.5 * Math.sin(now / 200);
        ctx.globalAlpha = 0.5 + 0.4 * puls;
        emojiAt('♨️', x, y - 20, 14);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#0d1330';
        ctx.fillRect(x - 17, y + 18, 34, 5);
        ctx.fillStyle = pot.burn > 0.6 ? '#ef4444' : '#f59e0b';
        ctx.fillRect(x - 16, y + 19, 32 * (1 - pot.burn), 3);
      } else {
        for (let i = 0; i < pot.n; i++) {
          ctx.fillStyle = ING_COLORS.onion;
          ctx.beginPath();
          ctx.arc(x - 7 + i * 7, y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        if (pot.state === 'cooking') {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, 15, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pot.cook);
          ctx.stroke();
        }
      }
    }
  }

  const FACE = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];

  function drawPlayers(prev, curr, alpha) {
    for (const p of curr.players) {
      let x = p.x;
      let y = p.y;
      const pp = prev && prev.players && prev.players.find((q) => q.id === p.id);
      if (pp) {
        x = lerp(pp.x, p.x, alpha);
        y = lerp(pp.y, p.y, alpha);
      }
      const color = teamColor(p);
      const [fx, fy] = FACE[p.f] || [0, 1];

      if (p.id === client.you) {
        const T = curr.tile;
        const tc = Math.floor((x + fx * T * 0.7) / T);
        const tr = Math.floor((y + fy * T * 0.7) / T);
        ctx.strokeStyle = 'rgba(232, 236, 255, 0.35)';
        ctx.lineWidth = 2;
        ctx.strokeRect(tc * T + 2, tr * T + 2, T - 4, T - 4);
      }

      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#0b1020';
      ctx.beginPath();
      ctx.arc(x + fx * 6 - fy * 4, y + fy * 6 + fx * 4, 2.4, 0, Math.PI * 2);
      ctx.arc(x + fx * 6 + fy * 4, y + fy * 6 - fx * 4, 2.4, 0, Math.PI * 2);
      ctx.fill();

      if (p.carry) drawItem(p.carry, x + fx * 20, y + fy * 20 - 4, true);

      ctx.fillStyle = 'rgba(232, 236, 255, 0.85)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      const label = p.id === client.you ? `${p.name} ▲` : p.name;
      ctx.fillText(label, x, y - 20);
    }
  }

  function drawHud(snap) {
    // 注文カード(上段の壁は全面プレーンなので隠れない)
    let ox = 8;
    for (const o of snap.orders) {
      const cw = 104;
      ctx.fillStyle = 'rgba(13, 19, 48, 0.92)';
      roundRectPath(ox, 5, cw, 42, 8);
      ctx.fill();
      ctx.strokeStyle = '#2c3a72';
      ctx.lineWidth = 1;
      ctx.stroke();
      const icons = o.items.map((i) => ING_EMOJI[i] || '').join('');
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText(icons, ox + 8, 20);
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = '#8f9bc4';
      ctx.fillText(`${o.label} +${o.score}`, ox + 8, 34);
      ctx.textBaseline = 'alphabetic';
      const ratio = Math.max(0, Math.min(1, o.left / o.ttl));
      ctx.fillStyle = '#0d1330';
      ctx.fillRect(ox + 4, 42, cw - 8, 3);
      ctx.fillStyle = ratio < 0.25 ? '#ef4444' : '#34d399';
      ctx.fillRect(ox + 4, 42, (cw - 8) * ratio, 3);
      ox += cw + 6;
    }

    // チームスコア(左下=ブルー / 右下=ピンク)、タイマーは中央下
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = TEAM_COLORS[0][0];
    ctx.fillText(`● ${snap.teamNames[0]} ${snap.teamScores[0]}`, 10, H - 12);
    ctx.textAlign = 'right';
    ctx.fillStyle = TEAM_COLORS[1][0];
    ctx.fillText(`${snap.teamScores[1]} ${snap.teamNames[1]} ●`, W - 10, H - 12);

    ctx.textAlign = 'center';
    const t = Math.ceil(snap.timeLeft);
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = snap.timeLeft <= 15 ? '#f87171' : '#e8ecff';
    ctx.fillText(`${mm}:${ss}`, W / 2, H - 12);

    if (client.role === 'spectator') {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232,236,255,0.6)';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('👀 観戦中', W / 2, H - 34);
    }

    if (snap.countdown > 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#e8ecff';
      ctx.font = 'bold 52px sans-serif';
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 24;
      ctx.fillText(String(Math.ceil(snap.countdown)), W / 2, H / 2);
      ctx.shadowBlur = 0;
    }
  }

  const gameScreen = document.querySelector('[data-screen="game"]');

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
    const now = performance.now();
    const { prev, curr, alpha } = rs;
    updateInput();
    drawTiles(curr);
    drawStations(curr, now);
    drawPlayers(prev, curr, alpha);
    drawHud(curr);
  }

  requestAnimationFrame(render);
})();
