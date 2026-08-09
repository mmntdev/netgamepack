'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GAMES } = require('./games');
const RoomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

app.get('/api/games', (req, res) => {
  res.json(
    Object.values(GAMES).map((g) => ({
      id: g.meta.id,
      name: g.meta.name,
      description: g.meta.description,
      minPlayers: g.meta.minPlayers,
      maxPlayers: g.meta.maxPlayers,
      path: g.meta.path,
    }))
  );
});

const roomManager = new RoomManager(io);

app.get('/api/stats', (req, res) => {
  res.json(roomManager.stats());
});

io.on('connection', (socket) => {
  roomManager.handleConnection(socket);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`netgamepack listening on port ${PORT}`);
});

module.exports = { app, server, io };
