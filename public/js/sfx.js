/* NetGame 共通効果音(Web Audio API でその場で合成、音声ファイル不要)
 * 使い方: NetSfx.play('brick') など。初回のユーザー操作で AudioContext を起こす。
 * ゲーム画面ツールバーに 🔊/🔇 ボタンを自動追加(設定は localStorage に保存)。 */
(function () {
  'use strict';

  let ctx = null;
  let master = null;
  let muted = localStorage.getItem('netgame-muted') === '1';

  function ensureCtx() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }

  // 自動再生制限対策: 最初のユーザー操作で起こす
  function unlock() {
    ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  function ready() {
    return !muted && ctx && ctx.state === 'running';
  }

  function tone(freq, dur, opts = {}) {
    if (!ready()) return;
    const t0 = ctx.currentTime + (opts.delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, opts.slide), t0 + dur);
    }
    g.gain.setValueAtTime(opts.vol || 0.5, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, opts = {}) {
    if (!ready()) return;
    const t0 = ctx.currentTime + (opts.delay || 0);
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = opts.high ? 'highpass' : 'lowpass';
    f.frequency.value = opts.freq || 1200;
    const g = ctx.createGain();
    g.gain.value = opts.vol || 0.4;
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0);
  }

  const SOUNDS = {
    // 反射・破壊系
    paddle: () => tone(220, 0.06, { slide: 330, vol: 0.35 }),
    wall: () => tone(160, 0.04, { vol: 0.2 }),
    brick: () => tone(520, 0.05, { vol: 0.3 }),
    break: () => {
      tone(660, 0.07, { slide: 880, vol: 0.35 });
      noise(0.08, { vol: 0.15, high: true, freq: 2000 });
    },
    powerup: () => {
      tone(523, 0.07, { vol: 0.3 });
      tone(784, 0.09, { delay: 0.07, vol: 0.3 });
    },
    multi: () => {
      tone(440, 0.06, { vol: 0.3 });
      tone(554, 0.06, { delay: 0.06, vol: 0.3 });
      tone(659, 0.09, { delay: 0.12, vol: 0.3 });
    },
    life: () => tone(392, 0.4, { type: 'sawtooth', slide: 98, vol: 0.4 }),
    lost: () => tone(300, 0.15, { slide: 120, vol: 0.25 }),
    level: () => {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.09, { delay: i * 0.09, vol: 0.32 }));
    },
    // 進行系
    start: () => {
      [392, 523, 659].forEach((f, i) => tone(f, 0.1, { delay: i * 0.1, vol: 0.3, type: 'triangle' }));
      tone(784, 0.25, { delay: 0.3, vol: 0.32, type: 'triangle' });
    },
    over: () => {
      [523, 494, 466, 440].forEach((f, i) =>
        tone(f, 0.16, { delay: i * 0.15, vol: 0.28, type: 'sawtooth' })
      );
    },
    score: () => {
      tone(660, 0.08, { vol: 0.3 });
      tone(880, 0.12, { delay: 0.08, vol: 0.3 });
    },
    tick: () => tone(880, 0.04, { type: 'sine', vol: 0.2 }),
    // スネーク
    eat: () => tone(700, 0.05, { slide: 1100, vol: 0.3 }),
    die: () => {
      tone(200, 0.3, { type: 'sawtooth', slide: 60, vol: 0.4 });
      noise(0.2, { vol: 0.2, freq: 700 });
    },
    respawn: () => {
      tone(330, 0.06, { vol: 0.25, type: 'triangle' });
      tone(494, 0.08, { delay: 0.06, vol: 0.25, type: 'triangle' });
    },
    // キッチン
    chop: () => noise(0.05, { vol: 0.35, freq: 900 }),
    ding: () => {
      tone(1319, 0.3, { type: 'sine', vol: 0.35 });
      tone(1976, 0.2, { type: 'sine', vol: 0.12 });
    },
    burn: () => {
      tone(150, 0.35, { type: 'sawtooth', slide: 80, vol: 0.35 });
      noise(0.3, { vol: 0.2, freq: 500 });
    },
    serve: () => {
      [659, 784, 1047].forEach((f, i) => tone(f, 0.09, { delay: i * 0.07, vol: 0.35, type: 'triangle' }));
    },
    order: () => {
      tone(988, 0.07, { type: 'sine', vol: 0.22 });
      tone(1319, 0.09, { delay: 0.07, type: 'sine', vol: 0.22 });
    },
    expire: () => tone(330, 0.2, { slide: 165, vol: 0.3 }),
    pick: () => tone(600, 0.035, { type: 'sine', vol: 0.18 }),
    place: () => tone(420, 0.035, { type: 'sine', vol: 0.18 }),
  };

  function play(name) {
    const fn = SOUNDS[name];
    if (!fn) return;
    try {
      fn();
    } catch (err) {
      /* 音は落ちても致命的ではない */
    }
  }

  // ゲーム画面ツールバーにミュートボタンを追加
  function setupMuteButton() {
    const bar = document.querySelector('.game-toolbar');
    if (!bar || document.getElementById('btn-mute')) return;
    const btn = document.createElement('button');
    btn.id = 'btn-mute';
    btn.className = 'btn secondary';
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = '効果音のオン/オフ';
    btn.addEventListener('click', () => {
      muted = !muted;
      localStorage.setItem('netgame-muted', muted ? '1' : '0');
      btn.textContent = muted ? '🔇' : '🔊';
      if (!muted) play('score');
      btn.blur();
    });
    bar.insertBefore(btn, bar.lastElementChild);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupMuteButton);
  } else {
    setupMuteButton();
  }

  window.NetSfx = { play };
})();
