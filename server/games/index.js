'use strict';

// ゲームレジストリ:新しいゲームを追加するには
// 1. server/games/<id>.js に { meta, Game } をエクスポートするモジュールを作成
// 2. ここで require してリストに追加
// 3. public/<id>/ にクライアントページを作成
const boids = require('./boids');
const breakout = require('./breakout');
const camo = require('./camo');
const edges = require('./edges');
const kitchen = require('./kitchen');
const kitchenbattle = require('./kitchenbattle');
const polygon = require('./polygon');
const snake = require('./snake');
const pong = require('./pong');

const GAMES = {};
for (const mod of [boids, breakout, camo, edges, kitchen, kitchenbattle, polygon, snake, pong]) {
  GAMES[mod.meta.id] = mod;
}

module.exports = { GAMES };
