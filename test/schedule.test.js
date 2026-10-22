'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createServerManager, normalizeSchedule, nextRestart, backupDue, ALERT_EVENTS, SERVER_EXE,
} = require('../electron/server-manager');

let tmp;
let dataDir;
let manager;
let serverDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-sched-'));
  dataDir = path.join(tmp, 'data');
  manager = createServerManager({ dataDir });
  serverDir = path.join(tmp, 'server');
  fs.mkdirSync(path.join(serverDir, 'savegame'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, SERVER_EXE), 'stub');
  fs.writeFileSync(path.join(serverDir, 'savegame', 'world.db'), 'world');
});

afterEach(() => {
  manager.stopMonitor();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('normalizeSchedule sorts and de-duplicates restart times', () => {
  const s = normalizeSchedule({ restart_times: ['18:30', '04:00', '04:00'], backup_interval_minutes: 60, backup_keep: 3 });
  assert.deepEqual(s.restart_times, ['04:00', '18:30']);
  assert.equal(s.backup_interval_minutes, 60);
  assert.equal(s.backup_keep, 3);
});

test('normalizeSchedule rejects bad times, intervals and retention counts', () => {
  assert.throws(() => normalizeSchedule({ restart_times: ['4:00'] }), (e) => e.status === 400);
  assert.throws(() => normalizeSchedule({ restart_times: ['24:00'] }), (e) => e.status === 400);
  assert.throws(() => normalizeSchedule({ backup_interval_minutes: 5 }), (e) => e.status === 400);
  assert.throws(() => normalizeSchedule({ backup_keep: 0 }), (e) => e.status === 400);
});

test('nextRestart picks the next time today, or the first one tomorrow', () => {
  const schedule = normalizeSchedule({ restart_times: ['04:00', '18:30'] });
  assert.equal(nextRestart(schedule, new Date(2026, 9, 21, 10, 0)), '18:30');
  assert.equal(nextRestart(schedule, new Date(2026, 9, 21, 19, 0)), '04:00 tomorrow');
  assert.equal(nextRestart(normalizeSchedule({}), new Date()), '');
});

test('backupDue compares against the last automatic backup', () => {
  const schedule = normalizeSchedule({ backup_interval_minutes: 60 });
  const now = new Date();
  assert.equal(backupDue(schedule, new Date(now - 2 * 3600e3).toISOString(), now), true);
  assert.equal(backupDue(schedule, new Date(now - 30 * 60e3).toISOString(), now), false);
  assert.equal(backupDue(schedule, '', now), false, 'no last backup means the schedule was never enabled');
  assert.equal(backupDue(normalizeSchedule({}), new Date(0).toISOString(), now), false, 'interval off');
});

test('saving a schedule starts the backup clock and returns it', () => {
  const { id } = manager.addExisting('A', serverDir);
  const res = manager.saveSchedule(id, { restart_times: ['04:00'], backup_interval_minutes: 180, backup_keep: 5 });
  assert.deepEqual(res.schedule.restart_times, ['04:00']);
  assert.ok(res.last_auto_backup_at, 'first automatic backup is scheduled one interval from now');
  assert.equal(manager.get(id).next_restart, nextRestart(res.schedule, new Date()));

  const off = manager.saveSchedule(id, { backup_interval_minutes: 0 });
  assert.equal(off.last_auto_backup_at, '');
});

test('automatic backups are pruned to the keep count and manual backups are never removed', () => {
  const { id } = manager.addExisting('A', serverDir);
  const manual = manager.createBackup(id).backup;
  manager.saveSchedule(id, { backup_interval_minutes: 60, backup_keep: 2 });

  // Force three automatic backups to be due, one tick each.
  for (let i = 0; i < 3; i += 1) {
    const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8'));
    registry.find((s) => s.id === id).last_auto_backup_at = new Date(Date.now() - 5 * 3600e3).toISOString();
    fs.writeFileSync(path.join(dataDir, 'servers.json'), JSON.stringify(registry));
    tickNow();
  }

  const names = manager.listBackups(id).map((b) => b.name);
  assert.equal(names.filter((n) => n.startsWith('auto-')).length, 2);
  assert.ok(names.includes(manual), 'manual backup kept');
});

// tick() is async, but with a stopped server it reaches the backup check without awaiting,
// so the backup has been written by the time this returns.
function tickNow() {
  manager.tick(new Date());
}

test('alert settings default to all events on and a blank URL', () => {
  const settings = manager.getSettings();
  assert.equal(settings.discord.url, '');
  for (const event of ALERT_EVENTS) assert.equal(settings.discord.events[event], true);
});

test('only Discord webhook URLs are accepted', () => {
  assert.throws(() => manager.saveSettings({ discord: { url: 'https://example.com/hook' } }), (e) => e.status === 400);
  const saved = manager.saveSettings({
    discord: { url: 'https://discord.com/api/webhooks/123456/abc_DEF-ghi', events: { crash: true, backup: false } },
  });
  assert.equal(saved.discord.url, 'https://discord.com/api/webhooks/123456/abc_DEF-ghi');
  assert.equal(saved.discord.events.backup, false);
  assert.equal(saved.discord.events.crash, true);
});

test('the test alert needs a saved URL first', async () => {
  await assert.rejects(manager.testDiscord(), (e) => e.status === 400);
});

