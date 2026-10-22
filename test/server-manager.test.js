'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServerManager, defaultConfig, ApiError, SERVER_EXE, CONFIG_NAME } = require('../electron/server-manager');

let tmp;
let manager;
let serverDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-test-'));
  manager = createServerManager({ dataDir: path.join(tmp, 'data') });
  serverDir = path.join(tmp, 'server');
  fs.mkdirSync(path.join(serverDir, 'savegame'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, SERVER_EXE), 'not really a server');
  fs.writeFileSync(path.join(serverDir, 'savegame', 'world.db'), 'world-v1');
});

afterEach(() => {
  manager.stopMonitor();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('adding a folder without the server exe is rejected', () => {
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => manager.addExisting('X', empty), (err) => err instanceof ApiError && err.status === 400);
});

test('adding a valid folder registers it as stopped', () => {
  const server = manager.addExisting('Valhalla', serverDir);
  assert.equal(server.name, 'Valhalla');
  assert.equal(server.running, false);
  assert.equal(server.installed, true);
  assert.equal(server.query_port, 15637);
  assert.equal(manager.list().length, 1);
});

test('the same folder cannot be added twice', () => {
  manager.addExisting('A', serverDir);
  assert.throws(() => manager.addExisting('B', serverDir), (err) => err.status === 409);
});

test('config is created with defaults on first read and saves back', () => {
  const { id } = manager.addExisting('A', serverDir);
  const first = manager.getConfig(id);
  assert.equal(first.exists, false);
  assert.equal(first.config.slotCount, 16);

  const cfg = { ...first.config, name: 'Renamed', slotCount: 8 };
  const res = manager.saveConfig(id, cfg);
  assert.equal(res.restart_required, false);
  const saved = JSON.parse(fs.readFileSync(path.join(serverDir, CONFIG_NAME), 'utf8'));
  assert.equal(saved.name, 'Renamed');
  assert.equal(saved.slotCount, 8);
});

test('invalid config is rejected with a clear message', () => {
  const { id } = manager.addExisting('A', serverDir);
  const bad = { ...defaultConfig('A'), queryPort: 80, slotCount: 0 };
  assert.throws(() => manager.saveConfig(id, bad), (err) => err.status === 400 && /queryPort/.test(err.message) && /slotCount/.test(err.message));
});

test('backups capture config and saves, and restore brings them back', () => {
  const { id } = manager.addExisting('A', serverDir);
  manager.saveConfig(id, defaultConfig('A'));
  const name = manager.createBackup(id).backup;
  assert.equal(manager.listBackups(id)[0].name, name);

  // Change the world, then restore the old copy.
  fs.writeFileSync(path.join(serverDir, 'savegame', 'world.db'), 'world-v2');
  fs.writeFileSync(path.join(serverDir, 'savegame', 'new.db'), 'extra');
  manager.restoreBackup(id, name);

  assert.equal(fs.readFileSync(path.join(serverDir, 'savegame', 'world.db'), 'utf8'), 'world-v1');
  assert.equal(fs.existsSync(path.join(serverDir, 'savegame', 'new.db')), false);
  assert.equal(manager.listBackups(id).length, 2, 'restore takes a safety backup first');

  manager.deleteBackup(id, name);
  assert.equal(manager.listBackups(id).some((b) => b.name === name), false);
});

test('backup names cannot escape the backup folder', () => {
  const { id } = manager.addExisting('A', serverDir);
  assert.throws(() => manager.deleteBackup(id, '../../servers.json'), (err) => err.status === 400);
});

test('logs are listed newest first and read as text', () => {
  const { id } = manager.addExisting('A', serverDir);
  fs.mkdirSync(path.join(serverDir, 'logs'));
  fs.writeFileSync(path.join(serverDir, 'logs', 'server.log'), 'line one\nline two\n');
  assert.equal(manager.listLogs(id)[0].name, 'server.log');
  assert.match(manager.readLog(id, 'server.log'), /line two/);
  assert.throws(() => manager.readLog(id, '..\\..\\secret.txt'), (err) => err.status === 400);
});

test('stopping a server that is not running just records it as stopped', async () => {
  const { id } = manager.addExisting('A', serverDir);
  await manager.stop(id);
  const view = manager.get(id);
  assert.equal(view.running, false);
  assert.equal(view.status, 'stopped');
});

test('a server that exits right away reports a start error', async () => {
  const { id } = manager.addExisting('A', serverDir);
  // The fake exe is plain text, so launching it fails straight away.
  await assert.rejects(manager.start(id), (err) => err instanceof ApiError);
  assert.equal(manager.get(id).running, false);
});

test('removing a stopped server keeps its files', () => {
  const { id } = manager.addExisting('A', serverDir);
  manager.remove(id);
  assert.equal(manager.list().length, 0);
  assert.equal(fs.existsSync(path.join(serverDir, SERVER_EXE)), true);
});
