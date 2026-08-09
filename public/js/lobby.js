/* NetGame 共通クライアント:ロビー(ルーム作成/参加/待機)とゲーム画面遷移を管理する。
 * 各ゲームページは NetGame.createClient() を呼び、スナップショットを読んで描画する。 */
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function showScreen(name) {
    for (const s of document.querySelectorAll('[data-screen]')) {
      s.classList.toggle('hidden', s.dataset.screen !== name);
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  const PLAYER_COLORS = [
    '#38bdf8',
    '#f472b6',
    '#a3e635',
    '#fbbf24',
    '#c084fc',
    '#f87171',
    '#34d399',
    '#fb923c',
  ];

  function createClient(opts) {
    const gameId = opts.gameId;
    const socket = io();

    const state = {
      you: null,
      role: null,
      inRoom: false,
      pendingJoin: false,
      lobby: null,
      playing: false,
      prevSnap: null,
      currSnap: null,
      prevAt: 0,
      currAt: 0,
      lastInputAt: 0,
      lastInputJson: '',
      pendingInput: null,
      inputTimer: null,
    };

    // ---- URL の ?room=XXXX を参加欄にプリセット ----
    const params = new URLSearchParams(location.search);
    const presetRoom = (params.get('room') || '').toUpperCase().slice(0, 4);
    if (presetRoom && $('input-room')) $('input-room').value = presetRoom;

    // ---- 名前の保存/復元 ----
    const savedName = localStorage.getItem('netgame-name') || '';
    if ($('input-name')) $('input-name').value = savedName;

    function myName() {
      const v = ($('input-name') && $('input-name').value.trim()) || '';
      if (v) localStorage.setItem('netgame-name', v);
      return v;
    }

    function setError(msg) {
      if ($('menu-error')) $('menu-error').textContent = msg || '';
    }

    function enterRoomScreen() {
      showScreen('room');
      renderRoom();
    }

    function backToMenu(msg) {
      state.inRoom = false;
      state.playing = false;
      state.lobby = null;
      state.prevSnap = null;
      state.currSnap = null;
      hideResult();
      showScreen('menu');
      if (msg) setError(msg);
    }

    function isHost() {
      return state.lobby && state.lobby.hostId === state.you;
    }

    function renderRoom() {
      const lobby = state.lobby;
      if (!lobby) return;

      if ($('room-code')) $('room-code').textContent = lobby.roomId;
      if ($('room-game-name')) $('room-game-name').textContent = lobby.gameName;
      if ($('game-room-code')) $('game-room-code').textContent = lobby.roomId;

      const list = $('player-list');
      if (list) {
        list.textContent = '';
        lobby.players.forEach((p, i) => {
          const li = document.createElement('li');
          const dot = document.createElement('span');
          dot.className = 'p-color';
          dot.style.background =
            p.role === 'player' ? PLAYER_COLORS[i % PLAYER_COLORS.length] : '#475077';
          const name = document.createElement('span');
          name.className = 'p-name';
          name.textContent = p.name + (p.id === state.you ? '(あなた)' : '');
          const tag = document.createElement('span');
          tag.className = 'p-tag';
          const tags = [];
          if (p.id === lobby.hostId) tags.push('ホスト');
          if (p.role === 'spectator') tags.push('観戦');
          tag.textContent = tags.join(' / ');
          li.appendChild(dot);
          li.appendChild(name);
          li.appendChild(tag);
          list.appendChild(li);
        });
      }

      const playerCount = lobby.players.filter((p) => p.role === 'player').length;
      const btnStart = $('btn-start');
      const hint = $('room-hint');
      if (btnStart) {
        btnStart.classList.toggle('hidden', !isHost());
        btnStart.disabled = playerCount < lobby.minPlayers;
      }
      if (hint) {
        if (lobby.status === 'playing') {
          hint.textContent = 'ゲーム進行中です…';
        } else if (playerCount < lobby.minPlayers) {
          hint.textContent = `対戦相手を待っています(あと${lobby.minPlayers - playerCount}人)`;
        } else if (isHost()) {
          hint.textContent = '準備ができたら「ゲーム開始」を押してください';
        } else {
          hint.textContent = 'ホストがゲームを開始するのを待っています…';
        }
      }
    }

    function showResult(result) {
      const overlay = $('overlay-result');
      if (!overlay) return;
      overlay.classList.remove('hidden');
      if ($('result-title')) {
        $('result-title').textContent = (result && result.title) || 'ゲーム終了';
      }
      const rows = $('result-rows');
      if (rows) {
        rows.textContent = '';
        const items = (result && result.rows) || [];
        items.forEach((r) => {
          const div = document.createElement('div');
          div.className = 'row';
          const n = document.createElement('span');
          n.textContent = r.name;
          const s = document.createElement('span');
          s.className = 'score';
          s.textContent = String(r.score);
          div.appendChild(n);
          div.appendChild(s);
          rows.appendChild(div);
        });
      }
      updateResultButtons();
    }

    function updateResultButtons() {
      const btnAgain = $('btn-again');
      const hint = $('result-hint');
      if (btnAgain) btnAgain.classList.toggle('hidden', !isHost());
      if (hint) {
        hint.textContent = isHost() ? '' : 'ホストが再開すると自動で次のゲームが始まります';
      }
    }

    function hideResult() {
      const overlay = $('overlay-result');
      if (overlay) overlay.classList.add('hidden');
    }

    // ---- socket イベント ----
    socket.on('room:update', (lobby) => {
      if (!state.inRoom && !state.pendingJoin) return;
      state.lobby = lobby;
      // サーバー側でロールが変わる(観戦者→プレイヤー繰り上げ等)ことがあるため再同期する
      const me = lobby.players.find((p) => p.id === state.you);
      if (me && me.role !== state.role) {
        const promoted = state.role === 'spectator' && me.role === 'player';
        state.role = me.role;
        if (promoted) toast('プレイヤーに繰り上がりました!');
      }
      renderRoom();
      updateResultButtons();
    });

    socket.on('game:start', () => {
      if (!state.inRoom && !state.pendingJoin) return;
      state.playing = true;
      state.prevSnap = null;
      state.currSnap = null;
      hideResult();
      showScreen('game');
      if (opts.onGameStart) opts.onGameStart();
    });

    socket.on('game:state', (snap) => {
      if (!state.playing && (state.inRoom || state.pendingJoin)) {
        // 途中参加などで start を取りこぼした場合の保険
        state.playing = true;
        hideResult();
        showScreen('game');
      }
      state.prevSnap = state.currSnap;
      state.prevAt = state.currAt;
      state.currSnap = snap;
      state.currAt = performance.now();
      if (opts.onGameState) opts.onGameState(snap);
    });

    socket.on('game:over', (payload) => {
      state.playing = false;
      showResult(payload && payload.result);
      if (opts.onGameOver) opts.onGameOver(payload && payload.result);
    });

    socket.on('room:closed', (payload) => {
      toast((payload && payload.reason) || 'ルームが閉じられました');
      backToMenu();
    });

    socket.on('disconnect', () => {
      if (state.inRoom || state.pendingJoin) {
        toast('サーバーとの接続が切れました');
        backToMenu('接続が切れました。もう一度参加してください');
      }
    });

    // ---- 操作 ----
    function handleAck(res) {
      state.pendingJoin = false;
      if (!res || !res.ok) {
        setError((res && res.error) || 'エラーが発生しました');
        return;
      }
      setError('');
      state.you = res.you;
      state.role = res.role;
      state.inRoom = true;
      state.lobby = res.lobby;
      if (res.lobby && res.lobby.status === 'playing') {
        state.playing = true;
        showScreen('game');
        if (opts.onGameStart) opts.onGameStart();
      } else {
        enterRoomScreen();
      }
      if (res.role === 'spectator') toast('満員のため観戦モードで参加しました');
    }

    if ($('btn-create')) {
      $('btn-create').addEventListener('click', () => {
        state.pendingJoin = true;
        socket.emit('room:create', { gameId, name: myName() }, handleAck);
      });
    }

    if ($('btn-join')) {
      const join = () => {
        const roomId = ($('input-room') && $('input-room').value.trim().toUpperCase()) || '';
        if (roomId.length !== 4) {
          setError('4文字のルームコードを入力してください');
          return;
        }
        state.pendingJoin = true;
        socket.emit('room:join', { roomId, name: myName() }, handleAck);
      };
      $('btn-join').addEventListener('click', join);
      if ($('input-room')) {
        $('input-room').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') join();
        });
      }
    }

    if ($('btn-start')) {
      $('btn-start').addEventListener('click', () => {
        socket.emit('room:start', {}, (res) => {
          if (res && !res.ok) toast(res.error || '開始できませんでした');
        });
      });
    }

    if ($('btn-again')) {
      $('btn-again').addEventListener('click', () => {
        socket.emit('room:start', {}, (res) => {
          if (res && !res.ok) toast(res.error || '再開できませんでした');
        });
      });
    }

    if ($('btn-back-room')) {
      $('btn-back-room').addEventListener('click', () => {
        hideResult();
        showScreen('room');
        renderRoom();
      });
    }

    for (const btnId of ['btn-leave-room', 'btn-leave-game']) {
      if ($(btnId)) {
        $(btnId).addEventListener('click', () => {
          socket.emit('room:leave', {}, () => {});
          backToMenu();
        });
      }
    }

    if ($('btn-copy-link')) {
      $('btn-copy-link').addEventListener('click', async () => {
        if (!state.lobby) return;
        const url = `${location.origin}${location.pathname}?room=${state.lobby.roomId}`;
        try {
          await navigator.clipboard.writeText(url);
          toast('招待リンクをコピーしました');
        } catch (err) {
          toast(`招待リンク: ${url}`);
        }
      });
    }

    // ---- ゲームページ向け API ----
    return {
      socket,
      colors: PLAYER_COLORS,
      get you() {
        return state.you;
      },
      get role() {
        return state.role;
      },
      get lobby() {
        return state.lobby;
      },
      get playing() {
        return state.playing;
      },
      /** 30Hz スロットリング + 差分送信つきの入力送信(最後の値はトレーリング送信で必ず届く) */
      sendInput(data) {
        if (!state.playing || state.role !== 'player') return;
        const json = JSON.stringify(data);
        if (json === state.lastInputJson && !state.pendingInput) return;
        const now = performance.now();
        const wait = 33 - (now - state.lastInputAt);
        if (wait > 0) {
          state.pendingInput = data;
          if (!state.inputTimer) {
            state.inputTimer = setTimeout(() => {
              state.inputTimer = null;
              const d = state.pendingInput;
              state.pendingInput = null;
              if (!d || !state.playing || state.role !== 'player') return;
              const j = JSON.stringify(d);
              if (j === state.lastInputJson) return;
              state.lastInputAt = performance.now();
              state.lastInputJson = j;
              socket.emit('game:input', d);
            }, wait + 2);
          }
          return;
        }
        state.pendingInput = null;
        state.lastInputAt = now;
        state.lastInputJson = json;
        socket.emit('game:input', data);
      },
      /** 補間用:直近2スナップショットと補間係数 */
      getRenderState() {
        const { prevSnap, currSnap, prevAt, currAt } = state;
        if (!currSnap) return null;
        let alpha = 1;
        if (prevSnap && currAt > prevAt) {
          alpha = (performance.now() - currAt) / (currAt - prevAt);
          alpha = Math.max(0, Math.min(1.25, alpha));
        }
        return { prev: prevSnap, curr: currSnap, alpha };
      },
      toast,
    };
  }

  window.NetGame = { createClient, PLAYER_COLORS };
})();
