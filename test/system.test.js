'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServerManager, cpuPercent } = require('../electron/server-manager');

test('cpuPercent is the share of all cores used between two samples', () => {
  // 10 CPU-seconds over 10 seconds on an 8-core machine is 12.5%.
  assert.equal(cpuPercent(10, 0, 20, 10000, 8), 12.5);
  // One fully busy core on 8 cores is 12.5% too.
  assert.equal(cpuPercent(0, 0, 10, 10000, 8), 12.5);
});

test('cpuPercent needs a previous sample and a positive interval', () => {
  assert.equal(cpuPercent(null, 0, 5, 10000, 8), null, 'first sample has nothing to compare with');
  assert.equal(cpuPercent(5, 10000, 6, 10000, 8), null, 'no time has passed');
  assert.equal(cpuPercent(5, 0, 6, 10000, 0), null, 'no cores reported');
});

test('cpuPercent stays within 0 to 100', () => {
  assert.equal(cpuPercent(0, 0, 1000, 1000, 4), 100);
  assert.equal(cpuPercent(10, 0, 5, 10000, 4), 0, 'a counter that goes backwards reads as 0');
});

let tmp;
let manager;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-system-'));
  manager = createServerManager({ dataDir: path.join(tmp, 'data') });
});

afterEach(() => {
  manager.stopMonitor();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('close-to-tray is on by default and can be turned off', () => {
  assert.equal(manager.getSettings().general.closeToTray, true);
  assert.equal(manager.setGeneral({ closeToTray: false }).closeToTray, false);
  assert.equal(manager.getSettings().general.closeToTray, false);
});

test('saving Discord settings keeps the tray setting, and saving the tray setting keeps Discord', () => {
  manager.setGeneral({ closeToTray: false });
  manager.saveSettings({ discord: { url: 'https://discord.com/api/webhooks/123/abc', events: { crash: true } } });
  assert.equal(manager.getSettings().general.closeToTray, false, 'Discord save did not reset the tray setting');

  manager.setGeneral({ closeToTray: true });
  assert.equal(manager.getSettings().discord.url, 'https://discord.com/api/webhooks/123/abc', 'tray save did not drop the webhook');
});

test('a server that is stopped reports no CPU or memory', () => {
  const dir = path.join(tmp, 'server');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'enshrouded_server.exe'), 'stub');
  const { id } = manager.addExisting('A', dir);
  const view = manager.get(id);
  assert.equal(view.cpu_percent, null);
  assert.equal(view.ram_bytes, null);
});

test('reads the public build from SteamCMD app_info_print output', () => {
  // Trimmed from a real SteamCMD run for app 2278520.
  const output = [
    '"branches"',
    '\t\t{',
    '\t\t\t"public"',
    '\t\t\t{',
    '\t\t\t\t"buildid"\t\t"26083076"',
    '\t\t\t\t"timeupdated"\t\t"1792577220"',
    '\t\t\t}',
    '\t\t}',
  ].join('\n');
  const { parsePublicBuild } = require('../electron/server-manager');
  assert.equal(parsePublicBuild(output), '26083076');
  assert.equal(parsePublicBuild('no branches here'), '');
});

test('schedule accepts the game update options and rejects odd check intervals', () => {
  const { normalizeSchedule } = require('../electron/server-manager');
  const s = normalizeSchedule({ update_before_start: true, update_check_hours: 12, auto_install: false });
  assert.equal(s.update_before_start, true);
  assert.equal(s.update_check_hours, 12);
  assert.equal(s.auto_install, false);
  assert.throws(() => normalizeSchedule({ update_check_hours: 5 }), (e) => e.status === 400);
});

test('screen refresh defaults to 2 minutes and only accepts the listed intervals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-refresh-'));
  try {
    const m = createServerManager({ dataDir: path.join(dir, 'data') });
    assert.equal(m.getSettings().general.refreshSeconds, 120);
    assert.equal(m.setGeneral({ refreshSeconds: 30 }).refreshSeconds, 30);
    assert.throws(() => m.setGeneral({ refreshSeconds: 7 }), (e) => e.status === 400);
    assert.equal(m.getSettings().general.refreshSeconds, 30, 'a rejected value is not saved');
    m.stopMonitor();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
