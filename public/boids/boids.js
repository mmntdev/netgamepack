/* 色鬼ボイド クライアント描画・入力 */
(function () {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = 800;
  const H = 600;

  const TEAM_COLORS = ['#f87171', '#38bdf8', '#fbbf24'];
  const TEAM_EMOJI = ['🔴', '🔵', '🟡'];
  const TEAM_NAMES = ['赤', '青', '黄'];
  // サーバーの PARAM_KEYS と同順([min, max])
  const PARAM_KEYS = ['speed', 'chase', 'flee', 'coh'];
  const PARAM_MAX = { speed: 2.2, chase: 2, flee: 2, coh: 2 };

  function sfx(name) {
    if (window.NetSfx) window.NetSfx.play(name);
  }

  let sfxPrev = null;
  let needClear = true;

  function sfxDiff(prev, curr) {
    if (!prev) return;
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
    gameId: 'boids',
    onGameStart() {
      sfxPrev = null;
      needClear = true;
    },
    onGameState(snap) {
      sfxDiff(sfxPrev, snap);
      sfxPrev = snap;
      updateControls(snap);
    },
  });

  function myTeam(snap) {
    const me = snap && snap.players.find((p) => p.id === client.you);
    return me ? me.team : -1;
  }

  // ---- 作戦ボタン ----
  const limitMsg = document.getElementById('limit-msg');
  const buttons = [...document.querySelectorAll('.tactic-btn')];
  let inputSeq = 0;
  let limitTimer = null;

  function pressTactic(key, btn) {
    if (!client.playing || client.role !== 'player') return;
    const snap = client.getRenderState() && client.getRenderState().curr;
    if (!snap || snap.countdown > 0) return;
    const team = myTeam(snap);
    if (team < 0) return;
    const idx = PARAM_KEYS.indexOf(key);
    const value = snap.params[team][idx];
    if (value >= PARAM_MAX[key] - 1e-9) {
      // 上限到達:「限界です!」約0.9秒表示+ボタン振動
      limitMsg.classList.add('show');
      clearTimeout(limitTimer);
      limitTimer = setTimeout(() => limitMsg.classList.remove('show'), 900);
      if (btn) {
        btn.classList.remove('shake');
        void btn.offsetWidth; // アニメーション再トリガー
        btn.classList.add('shake');
      }
      sfx('expire');
      return;
    }
    // 同一JSONは共通クライアントが間引くため連打カウンタを添える
    client.sendInput({ k: key, n: inputSeq++ });
    sfx('pick');
  }

  for (const btn of buttons) {
    btn.addEventListener('click', () => pressTactic(btn.dataset.param, btn));
  }

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const idx = ['1', '2', '3', '4'].indexOf(e.key);
    if (idx < 0 || !client.playing) return;
    e.preventDefault();
    pressTactic(PARAM_KEYS[idx], buttons[idx]);
  });

  // ---- チーム表示・パラメータ表 ----
  const teamBanner = document.getElementById('team-banner');
  const chkParams = document.getElementById('chk-params');
  const paramTable = document.getElementById('param-table');
  const paramBody = paramTable.querySelector('tbody');
  chkParams.checked = localStorage.getItem('boids-show-params') === '1';

  chkParams.addEventListener('change', () => {
    localStorage.setItem('boids-show-params', chkParams.checked ? '1' : '0');
    paramTable.classList.toggle('hidden', !chkParams.checked);
  });
  paramTable.classList.toggle('hidden', !chkParams.checked);

  function updateControls(snap) {
    const team = myTeam(snap);
    const isPlayer = client.role === 'player' && team >= 0;
    for (const btn of buttons) {
      btn.disabled = !isPlayer || snap.countdown > 0;
      btn.style.display = isPlayer ? '' : 'none';
    }
    if (isPlayer) {
      teamBanner.textContent = `あなたは ${TEAM_EMOJI[team]} ${TEAM_NAMES[team]}チーム`;
      teamBanner.style.color = TEAM_COLORS[team];
    } else {
      teamBanner.textContent = '👀 観戦中';
      teamBanner.style.color = '';
    }
    if (chkParams.checked) {
      paramBody.textContent = '';
      for (let c = 0; c < 3; c++) {
        const tr = document.createElement('tr');
        if (c === team) tr.className = 'mine';
        const th = document.createElement('td');
        th.textContent = `${TEAM_EMOJI[c]} ${TEAM_NAMES[c]}${snap.ai[c] ? '(AI)' : ''}`;
        tr.appendChild(th);
        for (let i = 0; i < 4; i++) {
          const td = document.createElement('td');
          td.textContent = snap.params[c][i].toFixed(2);
          tr.appendChild(td);
        }
        paramBody.appendChild(tr);
      }
    }
  }

  // ---- 描画 ----
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function torusLerp(a, b, t, size) {
    let d = b - a;
    if (d > size / 2) d -= size;
    if (d < -size / 2) d += size;
    let v = (a + d * t) % size;
    return v < 0 ? v + size : v;
  }

  function angleLerp(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  function drawBoids(prev, curr, alpha) {
    const pb = prev && prev.b && prev.b.length === curr.b.length ? prev.b : null;
    for (let i = 0; i < curr.b.length; i += 4) {
      let x = curr.b[i];
      let y = curr.b[i + 1];
      let a = curr.b[i + 2] / 100;
      const c = curr.b[i + 3];
      if (pb) {
        x = torusLerp(pb[i], x, alpha, W);
        y = torusLerp(pb[i + 1], y, alpha, H);
        a = angleLerp(pb[i + 2] / 100, a, alpha);
      }
      const color = TEAM_COLORS[c];
      // 同色グロー円
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // 進行方向に回転させた三角形
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, 3.4);
      ctx.lineTo(-4, -3.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawHud(snap) {
    // 支配率バー(積み上げ)
    const barX = 160;
    const barW = W - barX * 2;
    const barY = 12;
    const barH = 13;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, barY, barW, barH);
    let x = barX;
    for (let c = 0; c < 3; c++) {
      const w = (snap.counts[c] / snap.n) * barW;
      ctx.fillStyle = TEAM_COLORS[c];
      ctx.fillRect(x, barY, w, barH);
      x += w;
    }
    // 目標支配率の目盛り(左右どちらの端のチームにも見えるよう両側に)
    const goal = (snap.winPct / 100) * barW;
    ctx.fillStyle = 'rgba(232,236,255,0.9)';
    ctx.fillRect(barX + goal - 1, barY - 3, 2, barH + 6);
    ctx.fillRect(barX + barW - goal - 1, barY - 3, 2, barH + 6);
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232,236,255,0.6)';
    ctx.fillText(`目標 ${snap.winPct}%`, W / 2, barY + barH + 12);

    // 各色の 個体数 (支配率%)
    ctx.font = 'bold 13px sans-serif';
    for (let c = 0; c < 3; c++) {
      const pct = Math.round((snap.counts[c] / snap.n) * 100);
      ctx.fillStyle = TEAM_COLORS[c];
      ctx.textAlign = c === 0 ? 'left' : c === 1 ? 'center' : 'right';
      const tx = c === 0 ? 14 : c === 1 ? W / 2 : W - 14;
      ctx.fillText(
        `${TEAM_EMOJI[c]} ${snap.counts[c]} (${pct}%)${snap.ai[c] ? ' AI' : ''}`,
        tx,
        H - 12
      );
    }

    // 残り時間
    const t = Math.ceil(snap.timeLeft);
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    ctx.textAlign = 'left';
    ctx.fillStyle = snap.timeLeft <= 10 ? '#f87171' : 'rgba(232,236,255,0.85)';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`${mm}:${ss}`, 14, 26);

    if (client.role === 'spectator') {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(232,236,255,0.5)';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('👀 観戦中', W - 14, 26);
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
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText('赤→青→黄→赤 を追え!', W / 2, H / 2 + 36);
    }
  }

  const gameScreen = document.querySelector('[data-screen="game"]');

  function render() {
    requestAnimationFrame(render);
    if (gameScreen.classList.contains('hidden')) return;
    const rs = client.getRenderState();
    if (!rs) {
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#8f9bc4';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('接続中…', W / 2, H / 2);
      return;
    }
    // 残像:半透明矩形の重ね塗り
    if (needClear) {
      needClear = false;
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = 'rgba(11, 13, 16, 0.35)';
      ctx.fillRect(0, 0, W, H);
    }
    const { prev, curr, alpha } = rs;
    drawBoids(prev, curr, alpha);
    drawHud(curr);
  }

  requestAnimationFrame(render);
})();
