'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const { queryServer, parseInfo, INFO_REQUEST } = require('../electron/a2s');

// Builds an A2S_INFO reply the way a Source-style server sends it.
function infoReply({ name = 'Test Keep', map = 'world', players = 3, maxPlayers = 16, bots = 0 } = {}) {
  const parts = [
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]),
    Buffer.from(`${name}\0${map}\0enshrouded\0Enshrouded\0`, 'utf8'),
    Buffer.from([0x00, 0x00]), // app id
    Buffer.from([players, maxPlayers, bots, 0x64, 0x6c, 0x00, 0x00]),
    Buffer.from('1.0.0\0', 'utf8'),
  ];
  return Buffer.concat(parts);
}

// Starts a fake query port. `handler(msg, rinfo)` returns the reply to send, or null to stay silent.
function fakeServer(handler) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      const reply = handler(msg);
      if (reply) sock.send(reply, rinfo.port, rinfo.address);
    });
    sock.bind(0, '127.0.0.1', () => resolve(sock));
  });
}

test('parses player count, max players and name from an A2S_INFO reply', async () => {
  const sock = await fakeServer((msg) => (msg.equals(INFO_REQUEST) ? infoReply({ players: 5 }) : null));
  try {
    const info = await queryServer('127.0.0.1', sock.address().port, 1000);
    assert.equal(info.players, 5);
    assert.equal(info.maxPlayers, 16);
    assert.equal(info.name, 'Test Keep');
    assert.equal(info.map, 'world');
    assert.match(info.raw_hex, /^ffffffff49/);
  } finally {
    sock.close();
  }
});

test('answers a challenge reply by repeating the request with the challenge', async () => {
  const challenge = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const sock = await fakeServer((msg) => {
    if (msg.equals(INFO_REQUEST)) return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge]);
    if (msg.equals(Buffer.concat([INFO_REQUEST, challenge]))) return infoReply({ players: 2 });
    return null;
  });
  try {
    const info = await queryServer('127.0.0.1', sock.address().port, 1000);
    assert.equal(info.players, 2);
  } finally {
    sock.close();
  }
});

test('rejects when nothing answers', async () => {
  const sock = await fakeServer(() => null);
  try {
    await assert.rejects(queryServer('127.0.0.1', sock.address().port, 300), /No reply/);
  } finally {
    sock.close();
  }
});

test('rejects a truncated or foreign reply', () => {
  assert.throws(() => parseInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17, 0x41])), /cut short/);
  assert.throws(() => parseInfo(Buffer.from('not a query reply')), /A2S_INFO/);
});
