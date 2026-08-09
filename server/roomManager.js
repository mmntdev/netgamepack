'use strict';

const { GAMES } = require('./games');

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 4;
const MAX_ROOMS = 300;
const MAX_SPECTATORS = 6;
const TICK_HZ = 60;
const SNAPSHOT_EVERY = 3; // 60Hz 物理 / 20Hz 配信
const MAX_NAME_LEN = 12;

function sanitizeName(raw, fallback) {
  const name = String(raw == null ? '' : raw)
    .slice(0, 100)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, MAX_NAME_LEN);
  return name || fallback;
}

class Room {
  constructor(id, gameMod) {
    this.id = id;
    this.gameMod = gameMod;
    this.clients = new Map(); // socketId -> { id, name, role: 'player'|'spectator' }
    this.hostId = null;
    this.status = 'waiting'; // 'waiting' | 'playing'
    this.game = null;
    this.interval = null;
    this.tickCount = 0;
    this.lastResult = null;
  }

  get players() {
    return [...this.clients.values()].filter((c) => c.role === 'player');
  }

  lobbyState() {
    return {
      roomId: this.id,
      gameId: this.gameMod.meta.id,
      gameName: this.gameMod.meta.name,
      minPlayers: this.gameMod.meta.minPlayers,
      maxPlayers: this.gameMod.meta.maxPlayers,
      status: this.status,
      hostId: this.hostId,
      lastResult: this.lastResult,
      players: [...this.clients.values()].map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
      })),
    };
  }
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
  }

  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.clients.size;
    return { rooms: this.rooms.size, players };
  }

  generateRoomId() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let id = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) {
        id += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
      }
      if (!this.rooms.has(id)) return id;
    }
    return null;
  }

  handleConnection(socket) {
    socket.data.roomId = null;

    socket.on('room:create', (payload, ack) => {
      this.safeAck(ack, () => this.createRoom(socket, payload));
    });
    socket.on('room:join', (payload, ack) => {
      this.safeAck(ack, () => this.joinRoom(socket, payload));
    });
    socket.on('room:leave', (payload, ack) => {
      this.safeAck(ack, () => {
        this.leaveRoom(socket);
        return { ok: true };
      });
    });
    socket.on('room:start', (payload, ack) => {
      this.safeAck(ack, () => this.startGame(socket));
    });
    // ack のないハンドラも try/catch で守り、ゲームモジュールの例外でプロセスが落ちないようにする
    socket.on('game:input', (payload) => {
      try {
        const room = this.roomOf(socket);
        if (!room || room.status !== 'playing' || !room.game) return;
        const client = room.clients.get(socket.id);
        if (!client || client.role !== 'player') return;
        room.game.handleInput(socket.id, payload);
      } catch (err) {
        console.error('input error:', err);
      }
    });
    socket.on('disconnect', () => {
      try {
        this.leaveRoom(socket);
      } catch (err) {
        console.error('disconnect error:', err);
      }
    });
  }

  safeAck(ack, fn) {
    let res;
    try {
      res = fn();
    } catch (err) {
      console.error('room error:', err);
      res = { ok: false, error: 'サーバーエラーが発生しました' };
    }
    if (typeof ack === 'function') ack(res);
  }

  roomOf(socket) {
    return socket.data.roomId ? this.rooms.get(socket.data.roomId) : null;
  }

  createRoom(socket, payload) {
    if (socket.data.roomId) this.leaveRoom(socket);
    const gameId = payload && payload.gameId;
    const gameMod =
      typeof gameId === 'string' && Object.prototype.hasOwnProperty.call(GAMES, gameId)
        ? GAMES[gameId]
        : null;
    if (!gameMod) return { ok: false, error: '指定されたゲームが見つかりません' };
    if (this.rooms.size >= MAX_ROOMS) {
      return { ok: false, error: 'サーバーが満員です。しばらくしてからお試しください' };
    }
    const roomId = this.generateRoomId();
    if (!roomId) return { ok: false, error: 'ルームを作成できませんでした' };

    const room = new Room(roomId, gameMod);
    this.rooms.set(roomId, room);
    return this.addClientToRoom(socket, room, payload);
  }

  joinRoom(socket, payload) {
    if (socket.data.roomId) this.leaveRoom(socket);
    const rawId = payload && payload.roomId;
    const roomId = String(rawId || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(roomId)) {
      return { ok: false, error: 'ルームコードは4文字で入力してください' };
    }
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'ルームが見つかりません。コードを確認してください' };
    return this.addClientToRoom(socket, room, payload);
  }

  addClientToRoom(socket, room, payload) {
    const meta = room.gameMod.meta;
    if (room.clients.size >= meta.maxPlayers + MAX_SPECTATORS) {
      return { ok: false, error: 'このルームは満員です' };
    }
    const name = sanitizeName(
      payload && payload.name,
      `プレイヤー${room.clients.size + 1}`
    );

    let role = 'spectator';
    const activePlayers = room.players.length;
    if (activePlayers < meta.maxPlayers) {
      if (room.status === 'waiting' || meta.allowJoinInProgress) {
        role = 'player';
      }
    }

    const client = { id: socket.id, name, role };
    room.clients.set(socket.id, client);
    if (!room.hostId) room.hostId = socket.id;
    socket.data.roomId = room.id;
    socket.join(room.id);

    // ゲーム進行中にプレイヤーとして参加(ブロック崩しの途中参加)
    if (room.status === 'playing' && room.game && role === 'player') {
      room.game.addPlayer({ id: socket.id, name });
    }

    this.broadcastRoom(room);
    if (room.status === 'playing' && room.game) {
      socket.emit('game:start', { gameId: meta.id });
      socket.emit('game:state', room.game.serialize());
    }
    return { ok: true, roomId: room.id, you: socket.id, role, lobby: room.lobbyState() };
  }

  leaveRoom(socket) {
    const room = this.roomOf(socket);
    socket.data.roomId = null;
    if (!room) return;

    room.clients.delete(socket.id);
    socket.leave(room.id);

    if (room.game) {
      room.game.removePlayer(socket.id);
    }

    if (room.clients.size === 0) {
      this.destroyRoom(room);
      return;
    }

    if (room.hostId === socket.id) {
      // 可能ならプレイヤーへ、いなければ観戦者へホストを移譲
      const firstPlayer = room.players[0];
      room.hostId = firstPlayer ? firstPlayer.id : room.clients.keys().next().value;
    }

    // 進行中のゲームの後始末。全プレイヤー退出時も必ず game:over を配信して
    // 観戦者が固まった画面に取り残されないようにする
    if (room.status === 'playing' && room.game) {
      if (room.game.playerCount === 0 && !room.game.finished) {
        room.game.finished = true;
        room.game.result = { title: 'プレイヤーが全員退出しました', rows: [] };
      }
      if (room.game.finished) {
        this.endGame(room);
      }
    }

    // 待機中(ゲーム終了直後を含む)なら観戦者を繰り上げてプレイヤーに
    if (room.status === 'waiting') {
      const meta = room.gameMod.meta;
      for (const c of room.clients.values()) {
        if (room.players.length >= meta.maxPlayers) break;
        if (c.role === 'spectator') c.role = 'player';
      }
    }

    this.broadcastRoom(room);
  }

  startGame(socket) {
    const room = this.roomOf(socket);
    if (!room) return { ok: false, error: 'ルームに参加していません' };
    if (room.hostId !== socket.id) {
      return { ok: false, error: 'ゲームを開始できるのはホストだけです' };
    }
    if (room.status === 'playing') {
      return { ok: false, error: 'ゲームは既に進行中です' };
    }
    const meta = room.gameMod.meta;
    const players = room.players;
    if (players.length < meta.minPlayers) {
      return { ok: false, error: `開始には${meta.minPlayers}人以上のプレイヤーが必要です` };
    }

    room.game = new room.gameMod.Game(players.map((p) => ({ id: p.id, name: p.name })));
    room.status = 'playing';
    room.lastResult = null;
    room.tickCount = 0;
    this.io.to(room.id).emit('game:start', { gameId: meta.id });
    this.broadcastRoom(room);
    this.startLoop(room);
    return { ok: true };
  }

  startLoop(room) {
    this.stopLoop(room);
    const dt = 1 / TICK_HZ;
    room.interval = setInterval(() => {
      try {
        this.tickRoom(room, dt);
      } catch (err) {
        console.error(`tick error in room ${room.id}:`, err);
        if (room.game) {
          room.game.finished = true;
          room.game.result = { title: 'エラーによりゲームを終了しました', rows: [] };
        }
        this.endGame(room);
      }
    }, 1000 / TICK_HZ);
  }

  stopLoop(room) {
    if (room.interval) {
      clearInterval(room.interval);
      room.interval = null;
    }
  }

  tickRoom(room, dt) {
    if (!room.game || room.status !== 'playing') {
      this.stopLoop(room);
      return;
    }
    room.game.tick(dt);
    room.tickCount++;
    if (room.game.finished) {
      this.io.to(room.id).emit('game:state', room.game.serialize());
      this.endGame(room);
      return;
    }
    if (room.tickCount % SNAPSHOT_EVERY === 0) {
      this.io.to(room.id).emit('game:state', room.game.serialize());
    }
  }

  endGame(room) {
    this.stopLoop(room);
    const result = room.game && room.game.result;
    room.lastResult = result || null;
    room.status = 'waiting';
    room.game = null;
    this.io.to(room.id).emit('game:over', { result });
    this.broadcastRoom(room);
  }

  destroyRoom(room) {
    this.stopLoop(room);
    this.rooms.delete(room.id);
  }

  broadcastRoom(room) {
    this.io.to(room.id).emit('room:update', room.lobbyState());
  }
}

module.exports = RoomManager;
