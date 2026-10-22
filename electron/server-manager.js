// Server logic for the Enshrouded Server Manager client.
// Process supervision, SteamCMD install/update and config handling are adapted from
// ESM-Z (Enshrouded Server Manager by Zat). No Electron imports here, so it can be tested with plain Node.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync, execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { queryServer } = require('./a2s');

const APP_ID = '2278520';
const SERVER_EXE = 'enshrouded_server.exe';
const CONFIG_NAME = 'enshrouded_server.json';
const DEFAULT_QUERY_PORT = 15637;
const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
const FACTOR_FIELDS = [
  'playerHealthFactor', 'playerManaFactor', 'playerStaminaFactor',
  'resourceDropStackAmountFactor', 'experienceCombatFactor', 'experienceMiningFactor',
  'enemyDamageFactor', 'enemyHealthFactor', 'bossDamageFactor', 'bossHealthFactor',
];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Full UTC ISO string, so every timestamp parses back to the same moment on any machine.
const nowIso = () => new Date().toISOString();

// The Steam build ID SteamCMD recorded for the installed server, or '' when there is no manifest yet.
function installedBuild(serverPath) {
  try {
    const manifest = fs.readFileSync(path.join(serverPath, 'steamapps', `appmanifest_${APP_ID}.acf`), 'utf8');
    return manifest.match(/"buildid"\s+"(\d+)"/)?.[1] || '';
  } catch {
    return '';
  }
}

// Returns epoch ms for a saved timestamp, or null. Older builds saved UTC without the trailing Z,
// so a missing zone is read as UTC. Reading it as local time made uptime negative on machines west of UTC+0.
function parseStamp(value) {
  if (!value) return null;
  const text = /(Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function defaultConfig(name, queryPort = DEFAULT_QUERY_PORT) {
  const gameSettings = {};
  for (const f of FACTOR_FIELDS) gameSettings[f] = 1;
  Object.assign(gameSettings, {
    enableDurability: true,
    enableStarvingDebuff: false,
    tombstoneMode: 'AddBackpackMaterials',
    weatherFrequency: 'Normal',
    pacifyAllEnemies: false,
  });
  return {
    name,
    password: '',
    saveDirectory: './savegame',
    logDirectory: './logs',
    ip: '0.0.0.0',
    queryPort,
    slotCount: 16,
    tags: [],
    voiceChatMode: 'Proximity',
    enableVoiceChat: false,
    enableTextChat: false,
    gameSettingsPreset: 'Default',
    gameSettings,
    userGroups: [
      { name: 'Admin', password: 'ChangeMeAdmin', canKickBan: true, canAccessInventories: true,
        canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 },
      { name: 'Friends', password: '', canKickBan: false, canAccessInventories: true,
        canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 },
    ],
    bannedAccounts: [],
  };
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new ApiError(400, 'Config must be an object');
  const problems = [];
  if (!String(cfg.name || '').trim()) problems.push('name is required');
  if (!Number.isInteger(cfg.queryPort) || cfg.queryPort < 1024 || cfg.queryPort > 65535) problems.push('queryPort must be 1024-65535');
  if (!Number.isInteger(cfg.slotCount) || cfg.slotCount < 1 || cfg.slotCount > 64) problems.push('slotCount must be 1-64');
  for (const key of ['userGroups', 'bannedAccounts', 'tags']) {
    if (!Array.isArray(cfg[key])) problems.push(`${key} must be a list`);
  }
  if (!cfg.gameSettings || typeof cfg.gameSettings !== 'object') problems.push('gameSettings must be an object');
  if (problems.length) throw new ApiError(400, problems.join('; '));
  return cfg;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function downloadFile(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(downloadFile(new URL(res.headers.location, url).href, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Schedule and alert helpers. Pure functions, exported for tests.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const BACKUP_INTERVALS = [0, 60, 180, 360, 720, 1440]; // minutes; 0 means off
const DISCORD_URL_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const ALERT_EVENTS = ['start', 'stop', 'crash', 'restart', 'update', 'backup'];
const DEFAULT_SCHEDULE = {
  restart_times: [],
  update_before_restart: false,
  backup_interval_minutes: 0,
  backup_keep: 7,
  update_before_start: false,
  update_check_hours: 0, // 0 means never check on its own
  auto_install: true, // install a newer build when the server is stopped
};
const UPDATE_CHECK_HOURS = [0, 6, 12, 24];

// The public branch's build ID in `app_info_print` output. Returns '' if the output has no public build.
function parsePublicBuild(text) {
  const branches = text.indexOf('"branches"');
  if (branches < 0) return '';
  const publicAt = text.indexOf('"public"', branches);
  if (publicAt < 0) return '';
  return text.slice(publicAt).match(/"buildid"\s+"(\d+)"/)?.[1] || '';
}
const THEMES = ['dark', 'light', 'system'];
const REFRESH_SECONDS = [5, 10, 30, 60, 120, 300];
const boolOf = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function defaultSettings() {
  return {
    discord: { url: '', events: Object.fromEntries(ALERT_EVENTS.map((e) => [e, true])) },
    general: {
      startWithWindows: false,
      startMinimized: false,
      closeToTray: true,
      autoStartServers: true,
      desktopNotifications: true,
      refreshSeconds: 120, // how often the screen re-reads server status, players and CPU/RAM
      theme: 'dark',
      newInstallFolder: '',
    },
    serverDefaults: { ...DEFAULT_SCHEDULE, auto_restart: true },
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
const scheduleOf = (server) => ({ ...DEFAULT_SCHEDULE, ...(server.schedule || {}) });

function normalizeSchedule(input = {}) {
  const times = Array.isArray(input.restart_times) ? input.restart_times.map((t) => String(t).trim()) : [];
  const bad = times.find((t) => !TIME_RE.test(t));
  if (bad) throw new ApiError(400, `'${bad}' is not a valid time. Use 24-hour HH:MM.`);
  const interval = Number(input.backup_interval_minutes ?? 0);
  if (!BACKUP_INTERVALS.includes(interval)) throw new ApiError(400, 'Backup interval must be off, 1, 3, 6, 12 or 24 hours.');
  const keep = Number(input.backup_keep ?? DEFAULT_SCHEDULE.backup_keep);
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new ApiError(400, 'Keep between 1 and 100 automatic backups.');
  const checkHours = Number(input.update_check_hours ?? 0);
  if (!UPDATE_CHECK_HOURS.includes(checkHours)) throw new ApiError(400, 'Update checks must be off, or every 6, 12 or 24 hours.');
  return {
    restart_times: [...new Set(times)].sort(),
    update_before_restart: !!input.update_before_restart,
    backup_interval_minutes: interval,
    backup_keep: keep,
    update_before_start: !!input.update_before_start,
    update_check_hours: checkHours,
    auto_install: boolOf(input.auto_install, DEFAULT_SCHEDULE.auto_install),
  };
}

// Next scheduled restart after `now`, e.g. "04:00" or "04:00 tomorrow". Empty when none are set.
function nextRestart(schedule, now) {
  if (!schedule.restart_times.length) return '';
  const current = hhmm(now);
  const later = schedule.restart_times.find((t) => t > current);
  return later || `${schedule.restart_times[0]} tomorrow`;
}

// True when an automatic backup is due: the interval has passed since the last one.
function backupDue(schedule, lastAt, now) {
  if (!schedule.backup_interval_minutes || !lastAt) return false;
  return now.getTime() - new Date(lastAt).getTime() >= schedule.backup_interval_minutes * 60000;
}

// The server checks join passwords against its user groups, not the top-level "password" field (which the
// server drops on start). Anyone can join with the group left blank, so the Password field sets the blank group:
// the Friends group, or else the first group that has no password. Blank there means public.
function applyJoinPassword(cfg) {
  const groups = Array.isArray(cfg.userGroups) ? cfg.userGroups : [];
  const entry = groups.find((g) => g.name === 'Friends') || groups.find((g) => !String(g.password || '').trim());
  if (entry) entry.password = String(cfg.password || '').trim();
  return cfg;
}

// Posts a message to a Discord webhook. The URL is never logged.
function postDiscord(url, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: 'Enshrouded Server Manager', content });
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Discord returned HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Discord request timed out')));
    req.end(body);
  });
}

// CPU share of one process between two samples, as a percentage of all cores (0-100).
// cpuSeconds are total processor seconds, as Get-Process reports them.
function cpuPercent(prevCpuSeconds, prevAt, cpuSeconds, at, cores) {
  const elapsed = (at - prevAt) / 1000;
  if (prevCpuSeconds == null || elapsed <= 0 || cores < 1) return null;
  const pct = ((cpuSeconds - prevCpuSeconds) / (elapsed * cores)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

// Address to send queries to. A server bound to all interfaces is reached on this machine.
function queryHost(cfg) {
  return !cfg.ip || cfg.ip === '0.0.0.0' ? '127.0.0.1' : cfg.ip;
}

// Player lines in enshrouded_server.log, as the server writes them:
//   [I 00:00:43,956] [server] Player 'Zoga' logged in with Permissions:
//   [I 00:01:15,016] [server] Remove Player 'Zoga'
//   [I 00:00:01,646] [Session] 'HostOnline' (up)!     (a new session; anyone still listed has gone)
const PLAYER_PATTERNS = [
  { type: 'session', re: /\[Session\] 'HostOnline' \(up\)/ },
  { type: 'joined', re: /\[server\] Player '(.*)' logged in with Permissions/ },
  { type: 'left', re: /\[server\] Remove Player '(.*)'\s*$/ },
];

function parsePlayerLine(line) {
  for (const pattern of PLAYER_PATTERNS) {
    const match = line.match(pattern.re);
    if (match) return { type: pattern.type, name: match[1] || '' };
  }
  return null;
}

// Feeds a chunk of log text into a player state ({ partial, online, events }).
// A line can be split across two reads, so the unfinished last line waits for the next chunk.
function applyPlayerLog(state, chunk, now = new Date()) {
  const lines = (state.partial + chunk).split('\n');
  state.partial = lines.pop();
  for (const line of lines) {
    const event = parsePlayerLine(line);
    if (!event) continue;
    if (event.type === 'session') {
      state.online.clear();
      continue;
    }
    if (event.type === 'joined') state.online.set(event.name, now);
    else state.online.delete(event.name);
    state.events.push({ time: now.toISOString(), type: event.type, name: event.name });
  }
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  return state;
}

function newPlayerState(file) {
  return { file, offset: 0, partial: '', online: new Map(), events: [] };
}

function createServerManager({ dataDir, log = () => {}, onEvent = () => {}, livemapFolder = '' }) {
  const registryFile = path.join(dataDir, 'servers.json');
  const backupRoot = path.join(dataDir, 'backups');
  const steamcmdDir = path.join(dataDir, 'steamcmd');
  const steamcmdExe = path.join(steamcmdDir, 'steamcmd.exe');
  const defaultInstallRoot = path.join(dataDir, 'servers');
  const jobs = new Map();
  let controlChain = Promise.resolve();
  let steamcmdChain = Promise.resolve();
  let monitorTimer = null;
  let liveTimer = null;
  const live = new Map(); // server id -> latest query result, kept in memory only
  const usage = new Map(); // server id -> { cpu_percent, ram_bytes }, kept in memory only
  const usageSamples = new Map(); // server id -> last { cpuSeconds, at }, for the CPU share
  const presence = new Map(); // server id -> player state read from the server log, kept in memory only

  // Serialise start/stop so the monitor and the UI never race each other.
  const withControl = (fn) => {
    const run = controlChain.then(fn, fn);
    controlChain = run.catch(() => {});
    return run;
  };
  const withSteamcmd = (fn) => {
    const run = steamcmdChain.then(fn, fn);
    steamcmdChain = run.catch(() => {});
    return run;
  };

  // ---------------- registry
  const loadRegistry = () => readJson(registryFile, []);
  const saveRegistry = (items) => writeJsonAtomic(registryFile, items);

  function getServer(id) {
    const server = loadRegistry().find((s) => s.id === id);
    if (!server) throw new ApiError(404, 'Server not found');
    return server;
  }

  function updateServer(id, patch) {
    const items = loadRegistry();
    const server = items.find((s) => s.id === id);
    if (!server) throw new ApiError(404, 'Server not found');
    Object.assign(server, patch);
    saveRegistry(items);
    return server;
  }

  function addServer(name, folder) {
    const resolved = path.resolve(folder);
    const items = loadRegistry();
    if (items.some((s) => path.resolve(s.path) === resolved)) throw new ApiError(409, 'That folder is already managed');
    // New servers start with the defaults from the Settings page.
    const defaults = loadSettings().serverDefaults;
    const schedule = normalizeSchedule(defaults);
    const server = {
      id: crypto.randomBytes(5).toString('hex'),
      name,
      path: resolved,
      pid: 0,
      desired_running: false,
      auto_restart: defaults.auto_restart,
      schedule,
      last_auto_backup_at: schedule.backup_interval_minutes ? nowIso() : '',
      started_at: '',
      last_stopped_at: '',
      last_update_at: '',
      last_update_warning: '',
      created_at: nowIso(),
    };
    items.push(server);
    saveRegistry(items);
    return server;
  }

  // ---------------- process helpers (Windows: tasklist/taskkill, elsewhere: signals)
  function processIsServer(pid) {
    const n = Number(pid || 0);
    if (!n) return false;
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${n}`, '/FI', `IMAGENAME eq ${SERVER_EXE}`, '/NH'],
        { encoding: 'utf8', windowsHide: true }).stdout || '';
      return out.toLowerCase().includes(SERVER_EXE);
    }
    try {
      process.kill(n, 0);
      return true;
    } catch {
      return false;
    }
  }

  const isRunning = (server) => processIsServer(server.pid);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function stopProcess(pid, timeoutMs = 15000) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!processIsServer(pid)) return;
      await sleep(500);
    }
    log(`Graceful stop timed out for pid=${pid}; forcing`);
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  }

  // ---------------- config
  const configPath = (server) => path.join(server.path, CONFIG_NAME);
  const readConfig = (server) => readJson(configPath(server), null);
  const saveDirFor = (server) => path.resolve(server.path, (readConfig(server) || {}).saveDirectory || './savegame');

  function portInUseByRunning(port, exceptId) {
    return loadRegistry().find((other) => other.id !== exceptId && isRunning(other)
      && (readConfig(other) || {}).queryPort === port);
  }

  function saveConfig(id, cfg) {
    const server = getServer(id);
    validateConfig(cfg);
    applyJoinPassword(cfg);
    const clash = portInUseByRunning(cfg.queryPort, id);
    if (clash) throw new ApiError(409, `Query port ${cfg.queryPort} is already used by running server '${clash.name}'`);
    writeJsonAtomic(configPath(server), cfg);
    log(`Saved ${CONFIG_NAME} for ${server.name}`);
    return { ok: true, restart_required: isRunning(server) };
  }

  // ---------------- view model
  function serverView(server) {
    const running = isRunning(server);
    const cfg = readConfig(server) || {};
    const started = running ? server.started_at : '';
    const startedMs = parseStamp(started);
    const uptime = startedMs ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : 0;
    return {
      id: server.id,
      name: server.name,
      path: server.path,
      installed: fs.existsSync(path.join(server.path, SERVER_EXE)),
      build_id: installedBuild(server.path),
      latest_build: server.latest_build || '',
      update_pending: Boolean(server.update_pending),
      running,
      status: running ? 'running' : (server.desired_running ? 'starting' : 'stopped'),
      pid: running ? server.pid : 0,
      started_at: started,
      uptime_seconds: uptime,
      auto_restart: server.auto_restart !== false,
      query_port: cfg.queryPort ?? DEFAULT_QUERY_PORT,
      slot_count: cfg.slotCount ?? 16,
      last_update_at: server.last_update_at || '',
      last_update_warning: server.last_update_warning || '',
      next_restart: nextRestart(scheduleOf(server), new Date()),
      players: running ? (presence.get(server.id)?.online.size ?? live.get(server.id)?.players ?? null) : null,
      max_players: running ? (live.get(server.id)?.maxPlayers ?? cfg.slotCount ?? 16) : null,
      players_error: running ? (live.get(server.id)?.error || '') : '',
      cpu_percent: running ? (usage.get(server.id)?.cpu_percent ?? null) : null,
      ram_bytes: running ? (usage.get(server.id)?.ram_bytes ?? null) : null,
    };
  }

  // ---------------- start / stop / restart
  async function startServer(id) {
    return withControl(async () => {
      const server = getServer(id);
      if (isRunning(server)) {
        updateServer(id, { desired_running: true });
        return;
      }
      if (scheduleOf(server).update_before_start || server.update_pending) {
        // A failed update must not keep the server from starting on the build it already has.
        await runUpdateNow(id).catch(() => {});
      }
      const exe = path.join(server.path, SERVER_EXE);
      if (!fs.existsSync(exe)) throw new ApiError(400, `${SERVER_EXE} not found in ${server.path}. Install or point to the server first.`);
      if (!fs.existsSync(configPath(server))) {
        writeJsonAtomic(configPath(server), defaultConfig(server.name));
        log(`Created initial ${CONFIG_NAME} for ${server.name}`);
      }
      const port = (readConfig(server) || {}).queryPort;
      const clash = portInUseByRunning(port, id);
      if (clash) throw new ApiError(409, `Query port ${port} is already used by running server '${clash.name}'`);

      // Detached so the game keeps running if the client is closed or restarted.
      let child;
      try {
        child = spawn(exe, [], { cwd: server.path, detached: true, stdio: 'ignore', windowsHide: true });
      } catch (err) {
        throw new ApiError(500, `Could not launch the server: ${err.message}`);
      }
      child.on('error', (err) => log(`Failed to launch ${server.name}: ${err.message}`));
      child.unref();
      updateServer(id, { pid: child.pid, desired_running: true, started_at: nowIso() });
      log(`Started ${server.name} pid=${child.pid}`);
      await sleep(2000);
      if (!processIsServer(child.pid)) {
        updateServer(id, { pid: 0, desired_running: false });
        throw new ApiError(500, 'Server exited right after starting. The query port may be in use or blocked.');
      }
      notify('start', `**${server.name}** started.`);
    });
  }

  async function stopServer(id) {
    return withControl(async () => {
      const server = getServer(id);
      updateServer(id, { desired_running: false });
      if (isRunning(server)) {
        await stopProcess(server.pid);
        log(`Stopped ${server.name}`);
        notify('stop', `**${server.name}** stopped.`);
      }
      updateServer(id, { pid: 0, last_stopped_at: nowIso() });
    });
  }

  async function restartServer(id) {
    await stopServer(id);
    await startServer(id);
  }

  // ---------------- settings (general, notifications, server defaults, updates)
  const settingsFile = path.join(dataDir, 'app-settings.json');

  function loadSettings() {
    const stored = readJson(settingsFile, {});
    const base = defaultSettings();
    return {
      discord: {
        url: stored.discord?.url || '',
        events: { ...base.discord.events, ...(stored.discord?.events || {}) },
      },
      general: {
        ...base.general,
        closeToTray: stored.ui?.closeToTray ?? base.general.closeToTray, // older builds kept this under "ui"
        ...(stored.general || {}),
      },
      serverDefaults: { ...base.serverDefaults, ...(stored.serverDefaults || {}) },
    };
  }

  // Saves whichever sections are sent. Each section is validated before anything is written.
  function saveSettings(input) {
    const current = loadSettings();
    const next = { ...current };
    if (input?.discord) {
      const url = String(input.discord.url || '').trim();
      if (url && !DISCORD_URL_RE.test(url)) throw new ApiError(400, 'That is not a Discord webhook URL.');
      next.discord = {
        url,
        events: Object.fromEntries(ALERT_EVENTS.map((e) => [e, !!input.discord.events?.[e]])),
      };
    }
    if (input?.general) {
      const g = input.general;
      const theme = g.theme ?? current.general.theme;
      if (!THEMES.includes(theme)) throw new ApiError(400, 'Theme must be dark, light or system.');
      const refreshSeconds = Number(g.refreshSeconds ?? current.general.refreshSeconds);
      if (!REFRESH_SECONDS.includes(refreshSeconds)) throw new ApiError(400, 'Screen refresh must be 5 seconds, 10, 30, 1 minute, 2 minutes or 5 minutes.');
      const folder = String(g.newInstallFolder ?? current.general.newInstallFolder).trim();
      if (folder && !path.isAbsolute(folder)) throw new ApiError(400, 'The install folder must be a full path, such as D:\\Enshrouded.');
      next.general = {
        startWithWindows: boolOf(g.startWithWindows, current.general.startWithWindows),
        startMinimized: boolOf(g.startMinimized, current.general.startMinimized),
        closeToTray: boolOf(g.closeToTray, current.general.closeToTray),
        autoStartServers: boolOf(g.autoStartServers, current.general.autoStartServers),
        desktopNotifications: boolOf(g.desktopNotifications, current.general.desktopNotifications),
        refreshSeconds,
        theme,
        newInstallFolder: folder,
      };
    }
    if (input?.serverDefaults) {
      const s = input.serverDefaults;
      const schedule = normalizeSchedule({
        restart_times: s.restart_times,
        update_before_restart: s.update_before_restart,
        backup_interval_minutes: s.backup_interval_minutes,
        backup_keep: s.backup_keep,
      });
      next.serverDefaults = { ...schedule, auto_restart: boolOf(s.auto_restart, current.serverDefaults.auto_restart) };
    }
    writeJsonAtomic(settingsFile, next);
    log('Saved settings');
    return loadSettings();
  }

  function setGeneral(patch) {
    return saveSettings({ general: { ...loadSettings().general, ...patch } }).general;
  }

  // With "start servers when the client opens" off, servers that were running only come back if someone starts them.
  function applyAutoStartSetting() {
    if (loadSettings().general.autoStartServers) return;
    for (const server of loadRegistry()) {
      if (server.desired_running && !isRunning(server)) updateServer(server.id, { desired_running: false });
    }
  }

  function notify(event, message) {
    onEvent(event, message); // the desktop client uses this for tray notifications
    const { discord } = loadSettings();
    if (!discord.url || !discord.events[event]) return;
    postDiscord(discord.url, message).catch((err) => log(`Discord alert failed: ${err.message}`));
  }

  async function testDiscord() {
    const { discord } = loadSettings();
    if (!discord.url) throw new ApiError(400, 'Save a Discord webhook URL first.');
    await postDiscord(discord.url, 'Enshrouded Server Manager: test alert. Alerts are working.');
    return { ok: true };
  }

  // ---------------- schedule: restarts and automatic backups
  const scheduleBusy = new Set();
  const buildCheckBusy = new Set();
  const lastRestartMinute = new Map();

  function getSchedule(id) {
    const server = getServer(id);
    return { schedule: scheduleOf(server), last_auto_backup_at: server.last_auto_backup_at || '' };
  }

  function saveSchedule(id, input) {
    const server = getServer(id);
    const schedule = normalizeSchedule(input);
    const before = scheduleOf(server);
    const patch = { schedule };
    if (!schedule.backup_interval_minutes) patch.last_auto_backup_at = '';
    else if (schedule.backup_interval_minutes !== before.backup_interval_minutes || !server.last_auto_backup_at) {
      patch.last_auto_backup_at = nowIso(); // first automatic backup happens one interval from now
    }
    updateServer(id, patch);
    log(`Saved schedule for ${server.name}`);
    return getSchedule(id);
  }

  // Keeps the newest `backup_keep` automatic backups. Manual backups are never touched.
  function pruneAutoBackups(server) {
    const folder = path.join(backupRoot, server.id);
    if (!fs.existsSync(folder)) return;
    const autos = fs.readdirSync(folder)
      .filter((f) => f.startsWith('auto-') && f.endsWith('.zip'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(folder, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of autos.slice(scheduleOf(server).backup_keep)) {
      fs.rmSync(path.join(folder, old.name), { force: true });
      log(`Pruned old automatic backup ${old.name}`);
    }
  }

  function runAutoBackup(server) {
    try {
      const name = createBackup(server.id, { auto: true });
      pruneAutoBackups(getServer(server.id));
      notify('backup', `**${server.name}**: automatic backup ${name} created.`);
    } catch (err) {
      log(`Automatic backup failed for ${server.name}: ${err.message}`);
      notify('backup', `**${server.name}**: automatic backup failed: ${err.message}`);
    } finally {
      // Set even on failure, so a broken backup retries after the interval instead of every tick.
      updateServer(server.id, { last_auto_backup_at: nowIso() });
    }
  }

  // Stops the server, optionally checks for an update, then starts it again. Only runs on a running server.
  async function runScheduledRestart(server) {
    scheduleBusy.add(server.id);
    try {
      notify('restart', `**${server.name}**: scheduled restart starting.`);
      await stopServer(server.id);
      if (scheduleOf(server).update_before_restart) {
        const job = newJob('update', server.id);
        try {
          await steamcmdUpdate(job, server.path);
          updateServer(server.id, { last_update_at: nowIso(), last_update_warning: '', update_pending: false });
          notify('update', `**${server.name}**: update check finished.`);
        } catch (err) {
          // Start the existing install anyway, as ESM-Z does.
          updateServer(server.id, { last_update_warning: err.message });
          notify('update', `**${server.name}**: update check failed: ${err.message}`);
        }
      }
      await startServer(server.id);
    } catch (err) {
      log(`Scheduled restart failed for ${server.name}: ${err.message}`);
      notify('restart', `**${server.name}**: scheduled restart failed: ${err.message}`);
    } finally {
      scheduleBusy.delete(server.id);
    }
  }

  // Runs every few seconds: crash recovery, scheduled restarts and automatic backups.
  async function tick(now = new Date()) {
    for (const server of loadRegistry()) {
      if (server.desired_running && !isRunning(server)) {
        notify('crash', `**${server.name}** stopped unexpectedly.`);
        if (server.auto_restart !== false) {
          log(`${server.name} is no longer running; restarting`);
          try {
            await startServer(server.id);
          } catch (err) {
            log(`Auto-restart failed for ${server.name}: ${err.message}`);
            updateServer(server.id, { desired_running: false, pid: 0 });
          }
        } else {
          updateServer(server.id, { desired_running: false, pid: 0 });
        }
        continue;
      }
      if (scheduleBusy.has(server.id)) continue;

      const schedule = scheduleOf(server);
      if (schedule.update_check_hours && !buildCheckBusy.has(server.id)) {
        const last = parseStamp(server.latest_build_checked_at);
        if (last === null || now.getTime() - last >= schedule.update_check_hours * 3600e3) {
          buildCheckBusy.add(server.id);
          checkServerBuild(server.id).catch(() => {}).finally(() => buildCheckBusy.delete(server.id));
        }
      }
      if (isRunning(server) && schedule.restart_times.includes(hhmm(now))) {
        const minuteKey = `${now.toDateString()} ${hhmm(now)}`;
        if (lastRestartMinute.get(server.id) !== minuteKey) {
          lastRestartMinute.set(server.id, minuteKey);
          runScheduledRestart(server);
        }
      }
      if (backupDue(schedule, server.last_auto_backup_at, now)) runAutoBackup(server);
    }
  }

  // ---------------- players (query port; names come from the logs only if the format is confirmed)
  async function refreshLive(server) {
    const cfg = readConfig(server) || {};
    try {
      const info = await queryServer(queryHost(cfg), cfg.queryPort ?? DEFAULT_QUERY_PORT);
      live.set(server.id, { players: info.players, maxPlayers: info.maxPlayers, name: info.name, map: info.map, checked_at: nowIso(), error: '' });
    } catch (err) {
      live.set(server.id, { players: null, maxPlayers: null, checked_at: nowIso(), error: err.message });
    }
  }

  // Reads whatever the server has written since the last read. A shorter file means the log was restarted.
  function followPlayerLog(server) {
    const cfg = readConfig(server) || {};
    const file = path.resolve(server.path, cfg.logDirectory || './logs', 'enshrouded_server.log');
    if (!fs.existsSync(file)) return null;
    const size = fs.statSync(file).size;
    let state = presence.get(server.id);
    if (!state || state.file !== file || size < state.offset) {
      state = newPlayerState(file);
      presence.set(server.id, state);
    }
    if (size > state.offset) {
      const buf = Buffer.alloc(size - state.offset);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, buf.length, state.offset);
      } finally {
        fs.closeSync(fd);
      }
      state.offset = size;
      applyPlayerLog(state, buf.toString('utf8'));
    }
    return state;
  }

  // Reads CPU time and memory of the server process. Windows only; elsewhere the values stay empty.
  function sampleUsage(server) {
    return new Promise((resolve) => {
      if (process.platform !== 'win32' || !isRunning(server)) {
        usage.delete(server.id);
        usageSamples.delete(server.id);
        return resolve();
      }
      const script = `Get-Process -Id ${Number(server.pid)} | Select-Object CPU,WorkingSet64 | ConvertTo-Json -Compress`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 8000 }, (err, stdout) => {
          if (err) return resolve();
          let info = null;
          try {
            info = JSON.parse(stdout.trim() || 'null');
          } catch {
            return resolve();
          }
          const cpuSeconds = Number(info?.CPU);
          const ram = Number(info?.WorkingSet64);
          if (!Number.isFinite(cpuSeconds) || !Number.isFinite(ram)) return resolve();
          const at = Date.now();
          const prev = usageSamples.get(server.id);
          usageSamples.set(server.id, { cpuSeconds, at });
          usage.set(server.id, {
            cpu_percent: prev ? cpuPercent(prev.cpuSeconds, prev.at, cpuSeconds, at, os.cpus().length) : null,
            ram_bytes: ram,
          });
          resolve();
        });
    });
  }

  async function pollLive() {
    for (const server of loadRegistry()) {
      if (isRunning(server)) {
        await refreshLive(server);
        followPlayerLog(server);
        await sampleUsage(server);
      } else {
        live.delete(server.id);
        presence.delete(server.id);
        usage.delete(server.id);
        usageSamples.delete(server.id);
      }
    }
  }

  function getPlayers(id) {
    const server = getServer(id);
    const running = isRunning(server);
    const state = running ? followPlayerLog(server) : null;
    return {
      running,
      log_ready: Boolean(state),
      live: running ? (live.get(id) || null) : null,
      online: state ? [...state.online].map(([name, joined]) => ({ name, joined_at: joined.toISOString() })) : [],
      events: state ? state.events.slice(-50).reverse() : [],
    };
  }

  // One raw query, for checking what the query port actually sends back.
  async function probeQuery(id) {
    const server = getServer(id);
    const cfg = readConfig(server) || {};
    const host = queryHost(cfg);
    const port = cfg.queryPort ?? DEFAULT_QUERY_PORT;
    try {
      const reply = await queryServer(host, port, 3000);
      const { raw_hex, ...parsed } = reply;
      return { ok: true, host, port, parsed, raw_hex };
    } catch (err) {
      return { ok: false, host, port, error: err.message };
    }
  }

  function startMonitor(intervalMs = 10000) {
    monitorTimer = setInterval(() => {
      tick().catch((err) => log(`Monitor error: ${err.message}`));
    }, intervalMs);
    liveTimer = setInterval(() => {
      pollLive().catch((err) => log(`Player poll error: ${err.message}`));
    }, 10000);
  }

  // ---------------- jobs (install / update)
  function newJob(kind, serverId = '') {
    const job = { id: crypto.randomBytes(6).toString('hex'), kind, server_id: serverId, status: 'running', error: '', lines: [] };
    jobs.set(job.id, job);
    return job;
  }

  function jobLog(job, line) {
    job.lines.push(line);
    if (job.lines.length > 300) job.lines.splice(0, job.lines.length - 300);
    log(line);
  }

  function runJob(job, work) {
    Promise.resolve()
      .then(() => work(job))
      .then(() => { job.status = 'done'; })
      .catch((err) => {
        job.status = 'error';
        job.error = err.message;
        log(`Job ${job.kind} failed: ${err.message}`);
      });
  }

  async function ensureSteamcmd(job) {
    if (fs.existsSync(steamcmdExe)) return steamcmdExe;
    jobLog(job, 'Downloading SteamCMD');
    fs.mkdirSync(dataDir, { recursive: true });
    const archive = path.join(dataDir, 'steamcmd.zip');
    await downloadFile(STEAMCMD_URL, archive);
    new AdmZip(archive).extractAllTo(steamcmdDir, true);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(steamcmdExe)) throw new Error('SteamCMD download finished but steamcmd.exe is missing');
    return steamcmdExe;
  }

  // SteamCMD updates itself on first run and often needs a second pass.
  function steamcmdUpdate(job, installDir) {
    return withSteamcmd(async () => {
      const exe = await ensureSteamcmd(job);
      fs.mkdirSync(installDir, { recursive: true });
      const args = ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', APP_ID, 'validate', '+quit'];
      let lastCode = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        jobLog(job, `SteamCMD app_update ${APP_ID} (attempt ${attempt})`);
        lastCode = await new Promise((resolve, reject) => {
          const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          const onData = (buf) => buf.toString('utf8').split(/\r?\n/).forEach((l) => l.trim() && jobLog(job, l.trimEnd()));
          proc.stdout.on('data', onData);
          proc.stderr.on('data', onData);
          proc.on('error', reject);
          proc.on('close', resolve);
        });
        if (lastCode === 0 && fs.existsSync(path.join(installDir, SERVER_EXE))) return;
      }
      throw new Error(`SteamCMD did not finish (last exit code ${lastCode})`);
    });
  }

  function installNewServer({ name, folder }) {
    const serverName = String(name || '').trim() || 'Enshrouded Server';
    const newInstallFolder = loadSettings().general.newInstallFolder;
    const dir = String(folder || '').trim()
      || path.join(newInstallFolder || defaultInstallRoot, slugify(serverName));
    const job = newJob('install');
    runJob(job, async (j) => {
      await steamcmdUpdate(j, dir);
      if (!fs.existsSync(path.join(dir, CONFIG_NAME))) writeJsonAtomic(path.join(dir, CONFIG_NAME), defaultConfig(serverName));
      const server = addServer(serverName, dir);
      j.server_id = server.id;
      jobLog(j, `Registered server '${serverName}' at ${dir}`);
      tryInstallLivemap(server, j);
    });
    return job;
  }

  function updateExistingServer(id) {
    const server = getServer(id);
    if (isRunning(server)) throw new ApiError(409, 'Stop the server before checking for updates');
    const job = newJob('update', id);
    runJob(job, async (j) => {
      try {
        await steamcmdUpdate(j, server.path);
        updateServer(id, { last_update_at: nowIso(), last_update_warning: '' });
        notify('update', `**${server.name}**: update check finished.`);
      } catch (err) {
        updateServer(id, { last_update_warning: err.message });
        notify('update', `**${server.name}**: update check failed: ${err.message}`);
        throw err;
      }
    });
    return job;
  }

  // ---------------- game updates (SteamCMD build check)
  // Asks SteamCMD for the public branch's build ID. Read-only, so it can run while the server is up.
  function latestBuild() {
    return withSteamcmd(async () => {
      const exe = await ensureSteamcmd({ lines: [] });
      const output = await new Promise((resolve, reject) => {
        execFile(exe, ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', APP_ID, '+quit'],
          { windowsHide: true, timeout: 180000, maxBuffer: 20 * 1024 * 1024 },
          (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
      });
      const build = parsePublicBuild(output);
      if (!build) throw new Error('SteamCMD did not report a public build');
      return build;
    });
  }

  // Compares the installed build with the latest one. A stopped server with auto-install on is updated at once;
  // a running server is marked so the update is applied the next time it stops.
  async function checkServerBuild(id) {
    const server = getServer(id);
    try {
      const latest = await latestBuild();
      const installed = installedBuild(server.path);
      const available = Boolean(installed) && latest !== installed;
      updateServer(id, { latest_build: latest, latest_build_checked_at: nowIso(), update_pending: available });
      if (available && isRunning(server) && !server.update_pending) {
        notify('update', `**${server.name}**: build ${latest} is out. It installs the next time the server stops.`);
      }
      if (available && !isRunning(server) && scheduleOf(server).auto_install) {
        await runUpdateNow(id);
      }
      return { installed, latest, available };
    } catch (err) {
      updateServer(id, { latest_build_checked_at: nowIso() });
      log(`Build check failed for ${server.name}: ${err.message}`);
      throw err;
    }
  }

  // Runs SteamCMD for a stopped server and records the outcome on the server.
  async function runUpdateNow(id) {
    const server = getServer(id);
    const job = newJob('update', id);
    try {
      await steamcmdUpdate(job, server.path);
      updateServer(id, { last_update_at: nowIso(), last_update_warning: '', update_pending: false });
      notify('update', `**${server.name}**: updated to build ${installedBuild(server.path)}.`);
    } catch (err) {
      updateServer(id, { last_update_warning: err.message });
      notify('update', `**${server.name}**: update failed: ${err.message}`);
      throw err;
    }
  }

  // ---------------- backups
  // Millisecond stamp plus a random suffix, so a safety backup never overwrites an earlier one.
  const stamp = () => `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '')}-${crypto.randomBytes(2).toString('hex')}`;

  function createBackup(id, { auto = false } = {}) {
    const server = getServer(id);
    const folder = path.join(backupRoot, server.id);
    fs.mkdirSync(folder, { recursive: true });
    const zip = new AdmZip();
    if (fs.existsSync(configPath(server))) zip.addLocalFile(configPath(server), '', CONFIG_NAME);
    const saves = saveDirFor(server);
    if (fs.existsSync(saves)) zip.addLocalFolder(saves, 'savegame');
    const file = path.join(folder, `${auto ? 'auto-' : ''}${slugify(server.name)}-${stamp()}.zip`);
    zip.writeZip(file);
    log(`Created backup ${path.basename(file)} for ${server.name}`);
    return path.basename(file);
  }

  function backupFile(id, name) {
    if (path.basename(name) !== name || !name.endsWith('.zip')) throw new ApiError(400, 'Invalid backup name');
    const file = path.join(backupRoot, id, name);
    if (!fs.existsSync(file)) throw new ApiError(404, 'Backup not found');
    return file;
  }

  function listBackups(id) {
    getServer(id);
    const folder = path.join(backupRoot, id);
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder)
      .filter((f) => f.endsWith('.zip'))
      .map((name) => {
        const st = fs.statSync(path.join(folder, name));
        return { name, size: st.size, created: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  function restoreBackup(id, name) {
    const server = getServer(id);
    if (isRunning(server)) throw new ApiError(409, 'Stop the server before restoring a backup');
    const file = backupFile(id, name);
    createBackup(id); // safety copy of what is about to be replaced
    const zip = new AdmZip(file);
    for (const entry of zip.getEntries()) {
      const n = entry.entryName;
      if (n !== CONFIG_NAME && !n.startsWith('savegame/')) throw new ApiError(400, `Unexpected entry in backup: ${n}`);
      if (n.split('/').includes('..')) throw new ApiError(400, `Unsafe path in backup: ${n}`);
    }
    const tmp = fs.mkdtempSync(path.join(dataDir, 'restore-'));
    try {
      zip.extractAllTo(tmp, true);
      const saves = saveDirFor(server);
      if (fs.existsSync(path.join(tmp, 'savegame'))) {
        fs.rmSync(saves, { recursive: true, force: true });
        fs.cpSync(path.join(tmp, 'savegame'), saves, { recursive: true });
      }
      if (fs.existsSync(path.join(tmp, CONFIG_NAME))) {
        fs.copyFileSync(path.join(tmp, CONFIG_NAME), configPath(server));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    log(`Restored backup ${name} for ${server.name}`);
  }

  // ---------------- logs
  function listLogs(id) {
    const server = getServer(id);
    const folder = path.join(server.path, 'logs');
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder)
      .map((name) => ({ name, full: path.join(folder, name) }))
      .filter((f) => fs.statSync(f.full).isFile())
      .map((f) => {
        const st = fs.statSync(f.full);
        return { name: f.name, size: st.size, modified: st.mtime.toISOString(), mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ mtime, ...rest }) => rest);
  }

  function readLog(id, name, maxBytes = 80000) {
    const server = getServer(id);
    if (path.basename(name) !== name) throw new ApiError(400, 'Invalid log name');
    const file = path.join(server.path, 'logs', name);
    if (!fs.existsSync(file)) throw new ApiError(404, 'Log not found');
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---------------- public API
  function removeServer(id) {
    const server = getServer(id);
    if (isRunning(server)) throw new ApiError(409, 'Stop the server before removing it from the manager');
    saveRegistry(loadRegistry().filter((s) => s.id !== id));
    log(`Removed ${server.name} from the manager (files kept)`);
  }

  function addExistingServer(name, folder) {
    const dir = String(folder || '').trim();
    if (!dir || !fs.existsSync(path.join(dir, SERVER_EXE))) throw new ApiError(400, `No ${SERVER_EXE} found in that folder`);
    const server = addServer(String(name || '').trim() || 'Enshrouded Server', dir);
    tryInstallLivemap(server);
    return server;
  }

  // ---------------- live map (a server mod, installed from files placed in data\livemap-source)
  // The packaged app passes its bundled folder in; otherwise the files come from data\livemap-source.
  const livemapSource = livemapFolder || path.join(dataDir, 'livemap-source');
  const livemapDll = path.join(livemapSource, 'iphlpapi.dll');
  const livemapWeb = path.join(livemapSource, 'livemap');

  function livemapReady() {
    return fs.existsSync(livemapDll) && fs.existsSync(path.join(livemapWeb, 'index.html'));
  }

  // The share link and any "unknown server build" warning, from the most recent 64 KB of livemap.log.
  function readLivemapLog(serverPath) {
    const file = path.join(serverPath, 'livemap.log');
    if (!fs.existsSync(file)) return { link: '', build_problem: false };
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    let text = '';
    try {
      const start = Math.max(0, size - 65536);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const links = text.match(/https?:\/\/\S*key=\S+/g) || [];
    return {
      link: links.length ? links[links.length - 1] : '',
      build_problem: /unknown server build/i.test(text),
    };
  }

  // The address the app's own map view uses: this machine, the port and key from livemap.ini.
  // Port=auto means the server's query port, as the mod documents.
  function livemapLocalUrl(server) {
    const iniFile = path.join(server.path, 'livemap.ini');
    if (!fs.existsSync(iniFile)) return '';
    const ini = fs.readFileSync(iniFile, 'utf8');
    const key = ini.match(/^\s*Key\s*=\s*(\S+)/m)?.[1];
    let port = ini.match(/^\s*Port\s*=\s*(\S+)/m)?.[1];
    if (!key) return '';
    if (!port || port === 'auto') port = (readConfig(server) || {}).queryPort ?? DEFAULT_QUERY_PORT;
    return `http://127.0.0.1:${port}/?key=${key}`;
  }

  function getLivemap(id) {
    const server = getServer(id);
    const installed = fs.existsSync(path.join(server.path, 'iphlpapi.dll'))
      && fs.existsSync(path.join(server.path, 'livemap', 'index.html'));
    return {
      installed,
      source_ready: livemapReady(),
      source_folder: livemapSource,
      running: isRunning(server),
      local_url: livemapLocalUrl(server),
      ...readLivemapLog(server.path),
    };
  }

  // Copies the live map into a stopped server. A running server has the DLL locked, so it is refused.
  function installLivemap(id) {
    const server = getServer(id);
    if (isRunning(server)) throw new ApiError(409, 'Stop the server before installing the live map');
    if (!livemapReady()) {
      throw new ApiError(400, 'Live map files are missing from this build of the app.');
    }
    fs.copyFileSync(livemapDll, path.join(server.path, 'iphlpapi.dll'));
    fs.cpSync(livemapWeb, path.join(server.path, 'livemap'), { recursive: true });
    log(`Installed live map for ${server.name}`);
    return getLivemap(id);
  }

  // Run whenever a server is added. Missing files are reported in the job log, not treated as a failure.
  function tryInstallLivemap(server, job) {
    const say = (line) => (job ? jobLog(job, line) : log(line));
    if (!livemapReady()) {
      say('Live map not installed: its files are missing from this build of the app.');
      return;
    }
    try {
      installLivemap(server.id);
      say('Live map installed');
    } catch (err) {
      say(`Live map not installed: ${err.message}`);
    }
  }

  return {
    list: () => loadRegistry().map(serverView),
    get: (id) => serverView(getServer(id)),
    addExisting: (name, folder) => serverView(addExistingServer(name, folder)),
    installNew: installNewServer,
    update: updateExistingServer,
    remove: removeServer,
    start: startServer,
    stop: stopServer,
    restart: restartServer,
    setAutoRestart(id, enabled) {
      updateServer(id, { auto_restart: !!enabled });
      return serverView(getServer(id));
    },
    getConfig(id) {
      const server = getServer(id);
      return { config: readConfig(server) || defaultConfig(server.name), exists: fs.existsSync(configPath(server)) };
    },
    saveConfig,
    listLogs,
    readLog,
    listBackups,
    createBackup: (id) => ({ backup: createBackup(id) }),
    restoreBackup,
    deleteBackup(id, name) {
      getServer(id);
      fs.rmSync(backupFile(id, name), { force: true });
    },
    getJob(id) {
      const job = jobs.get(id);
      if (!job) throw new ApiError(404, 'Job not found');
      return { ...job, lines: [...job.lines] };
    },
    getSchedule,
    saveSchedule,
    checkBuild: checkServerBuild,
    getLivemap,
    installLivemap,
    getSettings: loadSettings,
    saveSettings,
    setGeneral,
    applyAutoStartSetting,
    testDiscord,
    tick,
    getPlayers,
    probeQuery,
    startMonitor,
    stopMonitor: () => {
      clearInterval(monitorTimer);
      clearInterval(liveTimer);
    },
    _steamcmdExe: steamcmdExe,
  };
}

module.exports = {
  createServerManager,
  applyJoinPassword,
  cpuPercent,
  parseStamp,
  parsePublicBuild,
  parsePlayerLine,
  applyPlayerLog,
  newPlayerState,
  normalizeSchedule,
  nextRestart,
  backupDue,
  ALERT_EVENTS,
  defaultConfig,
  validateConfig,
  ApiError,
  FACTOR_FIELDS,
  SERVER_EXE,
  CONFIG_NAME,
};
