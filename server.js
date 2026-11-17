'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/ping', (req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 30000 });

const rooms = new Map(); // code -> room

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}
const newId = () => crypto.randomBytes(5).toString('hex');
const cleanName = n => String(n || '').trim().replace(/\s+/g, ' ').slice(0, 16);

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, connected: p.sockets.size > 0 }));
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    const payload = {
      code: room.code,
      me: p.id,
      hostId: room.hostId,
      players: publicPlayers(room),
      settings: room.settings,
      game: room.game ? room.game.viewFor(p.id) : null,
    };
    for (const sid of p.sockets) io.to(sid).emit('state', payload);
  }
}

function ensureHost(room) {
  if (!room.players.some(p => p.id === room.hostId)) {
    const next = room.players.find(p => p.sockets.size > 0) || room.players[0];
    room.hostId = next ? next.id : null;
  }
}

io.on('connection', socket => {
  let room = null;
  let player = null;

  const err = msg => socket.emit('err', msg);

  function attach(r, p) {
    room = r; player = p;
    p.sockets.add(socket.id);
    socket.join(r.code);
    broadcast(r);
  }

  socket.on('create', ({ name, token } = {}) => {
    name = cleanName(name);
    if (!name) return err('Zadej jméno.');
    if (!token) return err('Chybí token.');
    const code = newCode();
    const r = { code, players: [], hostId: null, settings: { memoryAid: false }, game: null, lastActive: Date.now() };
    const p = { id: newId(), token, name, sockets: new Set() };
    r.players.push(p);
    r.hostId = p.id;
    rooms.set(code, r);
    attach(r, p);
  });

  socket.on('join', ({ code, name, token } = {}) => {
    code = String(code || '').trim().toUpperCase();
    name = cleanName(name);
    const r = rooms.get(code);
    if (!r) return err('Místnost s tímto kódem neexistuje (server se mohl restartovat — založte novou).');
    let p = r.players.find(x => x.token === token);
    if (!p && name) {
      // take over a disconnected seat with the same name (e.g. switched phone/browser)
      p = r.players.find(x => x.name.toLowerCase() === name.toLowerCase() && x.sockets.size === 0);
      if (p) p.token = token;
    }
    if (!p) {
      if (!name) return err('Zadej jméno.');
      if (r.game) return err('Hra už běží. Připojit se může jen hráč, který v ní už je (stejné jméno).');
      if (r.players.length >= MAX_PLAYERS) return err('Místnost je plná (max 6 hráčů).');
      if (r.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return err('Tohle jméno už v místnosti někdo má.');
      p = { id: newId(), token, name, sockets: new Set() };
      r.players.push(p);
    }
    attach(r, p);
  });

  function guard(fn) {
    return (data = {}) => {
      if (!room || !player) return err('Nejsi v žádné místnosti.');
      try {
        fn(data);
        broadcast(room);
      } catch (e) {
        if (e instanceof GameError) err(e.message);
        else { console.error(e); err('Něco se pokazilo.'); }
      }
    };
  }
  const isHost = () => room && player && room.hostId === player.id;

  socket.on('settings', guard(({ memoryAid }) => {
    if (!isHost()) throw new GameError('Nastavení mění jen zakladatel.');
    if (room.game && room.game.phase !== 'gameEnd') throw new GameError('Během hry nastavení měnit nejde.');
    room.settings.memoryAid = !!memoryAid;
  }));

  socket.on('kick', guard(({ pid }) => {
    if (!isHost()) throw new GameError('Vyhazovat může jen zakladatel.');
    if (room.game) throw new GameError('Během hry nejde nikoho vyhodit.');
    const target = room.players.find(p => p.id === pid);
    if (!target || target.id === player.id) return;
    for (const sid of target.sockets) io.to(sid).emit('kicked');
    room.players = room.players.filter(p => p.id !== pid);
  }));

  socket.on('leave', () => {
    if (!room || !player) return;
    if (!room.game || room.game.phase === 'gameEnd') {
      room.players = room.players.filter(p => p.id !== player.id);
      ensureHost(room);
    } else {
      player.sockets.delete(socket.id);
    }
    socket.leave(room.code);
    const r = room;
    room = null; player = null;
    if (r.players.length === 0) rooms.delete(r.code);
    else broadcast(r);
  });

  socket.on('start', guard(() => {
    if (!isHost()) throw new GameError('Hru spouští zakladatel.');
    if (room.game && room.game.phase !== 'gameEnd') throw new GameError('Hra už běží.');
    if (room.players.length < 2) throw new GameError('Potřebujete aspoň 2 hráče.');
    room.game = new Game(room.players.map(p => ({ id: p.id, name: p.name })), room.settings);
  }));

  socket.on('toLobby', guard(() => {
    if (!isHost()) throw new GameError('Jen zakladatel.');
    if (room.game && room.game.phase !== 'gameEnd') throw new GameError('Hra ještě běží.');
    room.game = null;
  }));

  socket.on('nextRound', guard(() => {
    if (!room.game) throw new GameError('Žádná hra.');
    room.game.nextRound();
  }));

  socket.on('act', guard(({ type, cardId, cardIds, myCardId, otherCardId }) => {
    const g = room.game;
    if (!g) throw new GameError('Hra neběží.');
    const pid = player.id;
    switch (type) {
      case 'peekChoose': return g.peekChoose(pid, cardId);
      case 'peekDone': return g.peekDone(pid);
      case 'drawDeck': return g.drawDeck(pid);
      case 'drawDiscard': return g.drawDiscard(pid);
      case 'undoDiscard': return g.undoDiscardTake(pid);
      case 'kabo': return g.callKabo(pid);
      case 'discard': return g.discardDrawn(pid);
      case 'swap': return g.swap(pid, cardIds);
      case 'effect': return g.useEffect(pid, { cardId, myCardId, otherCardId });
      case 'skipEffect': return g.skipEffect(pid);
      case 'ack': return g.ackReveal(pid);
      default: throw new GameError('Neznámá akce.');
    }
  }));

  socket.on('chat', ({ text } = {}) => {
    if (!room || !player) return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    io.to(room.code).emit('chat', { name: player.name, text, at: Date.now() });
  });

  socket.on('disconnect', () => {
    if (!room || !player) return;
    player.sockets.delete(socket.id);
    broadcast(room);
  });
});

// drop rooms nobody has touched for 6 hours
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [code, r] of rooms) {
    const anyone = r.players.some(p => p.sockets.size > 0);
    if (!anyone && r.lastActive < cutoff) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Kabo běží na http://localhost:${PORT}`));
