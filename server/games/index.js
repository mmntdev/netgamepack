'use strict';

// ゲームレジストリ:新しいゲームを追加するには
// 1. server/games/<id>.js に { meta, Game } をエクスポートするモジュールを作成
// 2. ここで require してリストに追加
// 3. public/<id>/ にクライアントページを作成
const breakout = require('./breakout');
const edges = require('./edges');
const kitchen = require('./kitchen');
const kitchenbattle = require('./kitchenbattle');
const polygon = require('./polygon');
const snake = require('./snake');
const pong = require('./pong');

const GAMES = {};
for (const mod of [breakout, edges, kitchen, kitchenbattle, polygon, snake, pong]) {
  GAMES[mod.meta.id] = mod;
}

module.exports = { GAMES };
