'use strict';

// ゲームレジストリ:新しいゲームを追加するには
// 1. server/games/<id>.js に { meta, Game } をエクスポートするモジュールを作成
// 2. ここで require してリストに追加
// 3. public/<id>/ にクライアントページを作成
const breakout = require('./breakout');
const pong = require('./pong');

const GAMES = {};
for (const mod of [breakout, pong]) {
  GAMES[mod.meta.id] = mod;
}

module.exports = { GAMES };
