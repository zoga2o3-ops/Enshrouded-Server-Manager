'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createServerManager, parsePlayerLine, applyPlayerLog, newPlayerState, SERVER_EXE,
} = require('../electron/server-manager');

// Lines copied from a real enshrouded_server.log.
const REAL_LINES = {
  handle: "[I 00:00:43,954] [server] Machine '1': Player '0(0)' logged in",
  joined: "[I 00:00:43,956] [server] Player 'Zoga' logged in with Permissions:",
  left: "[I 00:01:15,016] [server] Remove Player 'Zoga'",
  session: "[I 00:00:01,646] [Session] 'HostOnline' (up)!",
  unrelated: '[I 00:00:30,512] -------------- Session ----------------',
};

test('parses join, leave and session lines from the real log', () => {
  assert.deepEqual(parsePlayerLine(REAL_LINES.joined), { type: 'joined', name: 'Zoga' });
  assert.deepEqual(parsePlayerLine(REAL_LINES.left), { type: 'left', name: 'Zoga' });
  assert.deepEqual(parsePlayerLine(REAL_LINES.session), { type: 'session', name: '' });
});

test('ignores the handle line and other session noise', () => {
  assert.equal(parsePlayerLine(REAL_LINES.handle), null, 'the handle is not the player name');
  assert.equal(parsePlayerLine(REAL_LINES.unrelated), null);
});

test('handles Windows line endings and names with apostrophes', () => {
  assert.deepEqual(parsePlayerLine(`${REAL_LINES.left}\r`), { type: 'left', name: 'Zoga' });
  assert.deepEqual(parsePlayerLine("[I 00:00:43,956] [server] Player 'Mo'Rat' logged in with Permissions:"),
    { type: 'joined', name: "Mo'Rat" });
});

test('tracks who is online across chunks, including a line split between reads', () => {
  const state = newPlayerState('x');
  const text = `${REAL_LINES.joined}\n${REAL_LINES.session}\n${REAL_LINES.joined.replace('Zoga', 'Bob')}\n`;
  // Cut the text in the middle of the second join line.
  const cut = text.indexOf('Bob') + 1;
  applyPlayerLog(state, text.slice(0, cut));
  assert.deepEqual([...state.online.keys()], [], 'the session line clears anyone listed before it');
  applyPlayerLog(state, text.slice(cut));
  assert.deepEqual([...state.online.keys()], ['Bob']);

  applyPlayerLog(state, `${REAL_LINES.left.replace('Zoga', 'Bob')}\n`);
  assert.deepEqual([...state.online.keys()], []);
  assert.deepEqual(state.events.map((e) => `${e.type}:${e.name}`), ['joined:Zoga', 'joined:Bob', 'left:Bob']);
});

test('keeps only the most recent events', () => {
  const state = newPlayerState('x');
  let text = '';
  for (let i = 0; i < 250; i += 1) text += `${REAL_LINES.joined.replace('Zoga', `P${i}`)}\n`;
  applyPlayerLog(state, text);
  assert.equal(state.events.length, 200);
  assert.equal(state.events[199].name, 'P249');
});

// ---- manager view

let tmp;
let manager;
let serverDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-players-'));
  manager = createServerManager({ dataDir: path.join(tmp, 'data') });
  serverDir = path.join(tmp, 'server');
  fs.mkdirSync(path.join(serverDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, SERVER_EXE), 'stub');
});

afterEach(() => {
  manager.stopMonitor();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('saved timestamps without a zone are read as UTC, so uptime cannot go negative', () => {
  const { parseStamp } = require('../electron/server-manager');
  // "2026-10-21T16:48:03" was written by an older build in UTC.
  assert.equal(parseStamp('2026-10-21T16:48:03'), Date.UTC(2026, 9, 21, 16, 48, 3));
  assert.equal(parseStamp('2026-10-21T16:48:03Z'), Date.UTC(2026, 9, 21, 16, 48, 3));
  assert.equal(parseStamp('2026-10-21T12:48:03-04:00'), Date.UTC(2026, 9, 21, 16, 48, 3));
  assert.equal(parseStamp(''), null);
  assert.equal(parseStamp('not a date'), null);
});

test('a stopped server reports no online players, even with a log on disk', () => {
  const { id } = manager.addExisting('A', serverDir);
  fs.writeFileSync(path.join(serverDir, 'logs', 'enshrouded_server.log'), `${REAL_LINES.joined}\n`);
  const view = manager.getPlayers(id);
  assert.equal(view.running, false);
  assert.deepEqual(view.online, []);
  assert.deepEqual(view.events, []);
});
