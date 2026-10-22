'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServerManager, SERVER_EXE } = require('../electron/server-manager');

let tmp;
let dataDir;
let serverDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-livemap-'));
  dataDir = path.join(tmp, 'data');
  serverDir = path.join(tmp, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, SERVER_EXE), 'stub');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Stands in for the files the user places in data\livemap-source. Contents are placeholders.
function placeLivemapSource() {
  const source = path.join(dataDir, 'livemap-source');
  fs.mkdirSync(path.join(source, 'livemap'), { recursive: true });
  fs.writeFileSync(path.join(source, 'iphlpapi.dll'), 'placeholder dll');
  fs.writeFileSync(path.join(source, 'livemap', 'index.html'), '<!doctype html>');
}

test('adding a server with no live map files skips the install without failing', () => {
  const manager = createServerManager({ dataDir });
  const server = manager.addExisting('A', serverDir);
  assert.equal(fs.existsSync(path.join(serverDir, 'iphlpapi.dll')), false);
  const lm = manager.getLivemap(server.id);
  assert.equal(lm.installed, false);
  assert.equal(lm.source_ready, false);
  manager.stopMonitor();
});

test('adding a server installs the live map when the files are in place', () => {
  placeLivemapSource();
  const manager = createServerManager({ dataDir });
  const server = manager.addExisting('A', serverDir);
  assert.equal(fs.existsSync(path.join(serverDir, 'iphlpapi.dll')), true);
  assert.equal(fs.existsSync(path.join(serverDir, 'livemap', 'index.html')), true);
  assert.equal(manager.getLivemap(server.id).installed, true);
  manager.stopMonitor();
});

test('the install button copies the files into an existing server', () => {
  const manager = createServerManager({ dataDir });
  const server = manager.addExisting('A', serverDir);
  placeLivemapSource();
  assert.equal(manager.getLivemap(server.id).installed, false);
  manager.installLivemap(server.id);
  assert.equal(manager.getLivemap(server.id).installed, true);
  manager.stopMonitor();
});

test('installing without the source files explains what is missing', () => {
  const manager = createServerManager({ dataDir });
  const server = manager.addExisting('A', serverDir);
  assert.throws(() => manager.installLivemap(server.id), (e) => e.status === 400 && /missing/.test(e.message));
  manager.stopMonitor();
});

test('the share link and build warning are read from livemap.log', () => {
  const manager = createServerManager({ dataDir });
  const server = manager.addExisting('A', serverDir);
  fs.writeFileSync(path.join(serverDir, 'livemap.log'),
    'livemap starting\nhttp://203.0.113.5:15637/?key=ourmap\nunknown server build (TimeDateStamp 1, SizeOfImage 0x1), not hooking\n');
  const lm = manager.getLivemap(server.id);
  assert.equal(lm.link, 'http://203.0.113.5:15637/?key=ourmap');
  assert.equal(lm.build_problem, true);
  manager.stopMonitor();
});

test('the in-app map address uses the key and port from livemap.ini', () => {
  const manager = createServerManager({ dataDir });
  const server = manager.addExisting('A', serverDir);
  fs.writeFileSync(path.join(serverDir, 'livemap.ini'), '[livemap]\nEnabled=1\nPort=auto\nKey=ourmap\n');
  assert.equal(manager.getLivemap(server.id).local_url, 'http://127.0.0.1:15637/?key=ourmap');
  fs.writeFileSync(path.join(serverDir, 'livemap.ini'), '[livemap]\nPort=16000\nKey=ourmap\n');
  assert.equal(manager.getLivemap(server.id).local_url, 'http://127.0.0.1:16000/?key=ourmap');
  manager.stopMonitor();
});
