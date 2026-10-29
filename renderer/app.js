'use strict';

// Renderer for the Enshrouded Server Manager client. Talks to the main process through window.esm.
// World settings schema. Keys are the gameSettings names in enshrouded_server.json.
// kind: pct = factor shown as a percentage (0.75 -> 75%), minutes = duration stored in nanoseconds,
// bool = switch, enum = dropdown. Presets other than Custom are built into the server and ignore these values.
const MIN_NS = 60e9;
const PRESET_NAMES = ['Relaxed', 'Default', 'Hard', 'Survival', 'Custom'];
const GAME_SECTIONS = [
  { title: 'Player', items: [
    { key: 'playerHealthFactor', label: 'Player health', kind: 'pct' },
    { key: 'playerManaFactor', label: 'Player mana', kind: 'pct' },
    { key: 'playerStaminaFactor', label: 'Player stamina', kind: 'pct' },
    { key: 'playerBodyHeatFactor', label: 'Frost resistance duration', kind: 'pct' },
    { key: 'playerDivingTimeFactor', label: 'Diving time', kind: 'pct' },
    { key: 'shroudTimeFactor', label: 'Shroud time', kind: 'pct' },
  ] },
  { title: 'Survival', items: [
    { key: 'enableDurability', label: 'Weapon durability', kind: 'bool', def: true },
    { key: 'enableStarvingDebuff', label: 'Starvation mode', kind: 'bool', def: false },
    { key: 'foodBuffDurationFactor', label: 'Food buff duration', kind: 'pct' },
    { key: 'fromHungerToStarving', label: 'Time until starving', kind: 'minutes', min: 1, max: 60, def: 10 * MIN_NS },
    { key: 'tombstoneMode', label: 'Loot loss on death', kind: 'enum', def: 'AddBackpackMaterials', options: [
      ['NoTombstone', 'Keep all'], ['AddBackpackMaterials', 'Default'], ['Everything', 'Lose all'],
    ] },
  ] },
  { title: 'World', items: [
    { key: 'dayTimeDuration', label: 'Day length', kind: 'minutes', min: 5, max: 120, def: 30 * MIN_NS },
    { key: 'nightTimeDuration', label: 'Night length', kind: 'minutes', min: 1, max: 60, def: 12 * MIN_NS },
    { key: 'weatherFrequency', label: 'Harsh weather', kind: 'enum', def: 'Normal', options: [
      ['Disabled', 'Off'], ['Rare', 'Rare'], ['Normal', 'Normal'], ['Often', 'Often'],
    ] },
    { key: 'fishingDifficulty', label: 'Fishing difficulty', kind: 'enum', def: 'Normal', options: [
      ['VeryEasy', 'Very easy'], ['Easy', 'Easy'], ['Normal', 'Normal'], ['Hard', 'Hard'], ['VeryHard', 'Very hard'],
    ] },
    { key: 'enableGliderTurbulences', label: 'Glider turbulence', kind: 'bool', def: true },
    { key: 'miningDamageFactor', label: 'Mining damage', kind: 'pct' },
    { key: 'plantGrowthSpeedFactor', label: 'Plant growth speed', kind: 'pct' },
    { key: 'resourceDropStackAmountFactor', label: 'Resource drop amount', kind: 'pct' },
    { key: 'factoryProductionSpeedFactor', label: 'Factory speed', kind: 'pct' },
  ] },
  { title: 'Progression', items: [
    { key: 'experienceCombatFactor', label: 'Combat XP', kind: 'pct' },
    { key: 'experienceMiningFactor', label: 'Mining XP', kind: 'pct' },
    { key: 'experienceExplorationQuestsFactor', label: 'Quest XP', kind: 'pct' },
    { key: 'perkCostFactor', label: 'Perk cost', kind: 'pct' },
    { key: 'perkUpgradeRecyclingFactor', label: 'Perk upgrade recycling', kind: 'pct' },
  ] },
  { title: 'Enemies', items: [
    { key: 'enemyDamageFactor', label: 'Enemy damage', kind: 'pct' },
    { key: 'enemyHealthFactor', label: 'Enemy health', kind: 'pct' },
    { key: 'enemyStaminaFactor', label: 'Enemy stamina', kind: 'pct' },
    { key: 'enemyPerceptionRangeFactor', label: 'Enemy perception range', kind: 'pct' },
    { key: 'bossDamageFactor', label: 'Boss damage', kind: 'pct' },
    { key: 'bossHealthFactor', label: 'Boss health', kind: 'pct' },
    { key: 'threatBonus', label: 'Threat bonus', kind: 'pct' },
    { key: 'pacifyAllEnemies', label: 'Pacify all enemies', kind: 'bool', def: false },
    // Off/Default/High are the wiki's labels. The mapping to Easy/Normal/Hard is inferred, so check it in game.
    { key: 'curseModifier', label: 'Curse chance', kind: 'enum', def: 'Normal', options: [
      ['Easy', 'Off'], ['Normal', 'Default'], ['Hard', 'High'],
    ] },
  ] },
];

// Values from the Enshrouded wiki's World Settings page (https://enshrouded.wiki.gg/wiki/World_Settings).
// Factors are percentages and durations are minutes; the helper below converts them to config units.
// Settings the wiki does not list for a preset are left out, so they keep the value from the file.
const PRESET_VALUES = {
  Relaxed: {
    enemyDamageFactor: 50, bossDamageFactor: 50, enemyHealthFactor: 50, bossHealthFactor: 50,
    enemyStaminaFactor: 50, enemyPerceptionRangeFactor: 75,
    playerHealthFactor: 200, playerManaFactor: 200, playerStaminaFactor: 200, playerBodyHeatFactor: 200,
    experienceMiningFactor: 125, experienceExplorationQuestsFactor: 100, experienceCombatFactor: 150,
    shroudTimeFactor: 150, foodBuffDurationFactor: 150, factoryProductionSpeedFactor: 200,
    plantGrowthSpeedFactor: 200, perkUpgradeRecyclingFactor: 100, miningDamageFactor: 150,
    resourceDropStackAmountFactor: 150, dayTimeDuration: 30, nightTimeDuration: 12,
    tombstoneMode: 'NoTombstone', enableDurability: false, enableStarvingDebuff: false,
    weatherFrequency: 'Rare', enableGliderTurbulences: false, pacifyAllEnemies: false, curseModifier: 'Easy',
  },
  Default: {
    enemyDamageFactor: 100, bossDamageFactor: 100, enemyHealthFactor: 100, bossHealthFactor: 100,
    enemyStaminaFactor: 100, enemyPerceptionRangeFactor: 100,
    playerHealthFactor: 100, playerManaFactor: 100, playerStaminaFactor: 100, playerBodyHeatFactor: 100,
    experienceMiningFactor: 100, experienceExplorationQuestsFactor: 100, experienceCombatFactor: 100,
    shroudTimeFactor: 100, foodBuffDurationFactor: 100, factoryProductionSpeedFactor: 100,
    plantGrowthSpeedFactor: 100, perkUpgradeRecyclingFactor: 50, miningDamageFactor: 100,
    resourceDropStackAmountFactor: 100, dayTimeDuration: 30, nightTimeDuration: 12,
    tombstoneMode: 'AddBackpackMaterials', enableDurability: true, enableStarvingDebuff: false,
    weatherFrequency: 'Normal', enableGliderTurbulences: true, pacifyAllEnemies: false, curseModifier: 'Normal',
  },
  Hard: {
    enemyDamageFactor: 150, bossDamageFactor: 100, enemyHealthFactor: 100, bossHealthFactor: 150,
    enemyStaminaFactor: 100, enemyPerceptionRangeFactor: 100,
    playerHealthFactor: 100, playerManaFactor: 100, playerStaminaFactor: 100, playerBodyHeatFactor: 100,
    experienceMiningFactor: 75, experienceExplorationQuestsFactor: 100, experienceCombatFactor: 50,
    shroudTimeFactor: 100, foodBuffDurationFactor: 90, factoryProductionSpeedFactor: 100,
    plantGrowthSpeedFactor: 100, perkUpgradeRecyclingFactor: 50, miningDamageFactor: 100,
    resourceDropStackAmountFactor: 100, dayTimeDuration: 30, nightTimeDuration: 12,
    tombstoneMode: 'AddBackpackMaterials', enableDurability: true, enableStarvingDebuff: false,
    weatherFrequency: 'Normal', enableGliderTurbulences: true, pacifyAllEnemies: false, curseModifier: 'Normal',
  },
  Survival: {
    enemyDamageFactor: 150, bossDamageFactor: 100, enemyHealthFactor: 100, bossHealthFactor: 150,
    enemyStaminaFactor: 100, enemyPerceptionRangeFactor: 100,
    playerHealthFactor: 75, playerManaFactor: 100, playerStaminaFactor: 100, playerBodyHeatFactor: 75,
    experienceMiningFactor: 75, experienceExplorationQuestsFactor: 100, experienceCombatFactor: 50,
    shroudTimeFactor: 100, foodBuffDurationFactor: 70, factoryProductionSpeedFactor: 100,
    plantGrowthSpeedFactor: 100, perkUpgradeRecyclingFactor: 30, miningDamageFactor: 75,
    resourceDropStackAmountFactor: 75, dayTimeDuration: 30, nightTimeDuration: 20, fromHungerToStarving: 10,
    tombstoneMode: 'Everything', enableDurability: true, enableStarvingDebuff: true,
    weatherFrequency: 'Often', enableGliderTurbulences: true, pacifyAllEnemies: false, curseModifier: 'Hard',
  },
};

// Returns gameSettings with a preset's values applied on top of `base`, in config units.
function presetGameSettings(preset, base) {
  const kinds = Object.fromEntries(GAME_SECTIONS.flatMap((s) => s.items).map((i) => [i.key, i.kind]));
  const values = { ...base };
  for (const [key, v] of Object.entries(PRESET_VALUES[preset] || {})) {
    if (kinds[key] === 'pct') values[key] = v / 100;
    else if (kinds[key] === 'minutes') values[key] = v * MIN_NS;
    else values[key] = v;
  }
  return values;
}

// The values the server is using right now: a built-in preset's values, or the saved custom values.
function effectiveGameSettings(cfg) {
  const base = cfg.gameSettings || {};
  return PRESET_VALUES[cfg.gameSettingsPreset] ? presetGameSettings(cfg.gameSettingsPreset, base) : base;
}
// Muted badge colours for server initials, chosen to sit with the gold accent.
const ACCENTS = ['#7d6330', '#3d6b5c', '#5a4d7d', '#7a4438', '#34596d', '#6a5f2e'];

const state = {
  route: { name: 'servers' },
  servers: [],
  busy: {},
  settingsDraft: null,
  settingsAdvanced: false,
  logName: '',
  tab: 'overview',
  settingsMeta: {},  // running, exists and serverId for the settings form on screen
  scheduleFor: '',   // server id the schedule draft belongs to
  scheduleDraft: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- icons

const ICONS = {
  grid: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/>',
  plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  restart: '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>',
  moon: '<path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="2" fill="none"/>',
  folder: '<path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',
  download: '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>',
  trash: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
  archive: '<path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>',
  restore: '<path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>',
  file: '<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
  search: '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l5 5" stroke="currentColor" stroke-width="2"/>',
  refresh: '<path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/>',
  settings: '<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>',
  bell: '<path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>',
};

const BACKUP_OPTIONS = [[0, 'Off'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Every 24 hours']];
const EVENT_LABELS = [
  ['start', 'Server started'], ['stop', 'Server stopped'], ['crash', 'Server crashed'],
  ['restart', 'Scheduled restart'], ['update', 'Update check'], ['backup', 'Automatic backup'],
];

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, el.dataset.size || 20); });
}

// ---------------------------------------------------------------- helpers

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function call(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    toast(err.message, 'error');
    throw err;
  }
}

function fmtUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

// CPU share of the server process. Empty until a second sample exists, which takes one refresh.
const fmtPercent = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);

// Memory in use by the server process.
const fmtRam = (bytes) => {
  if (bytes == null) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
};

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Older saved timestamps have no UTC marker; read them as UTC, as the backend does.
const fmtDate = (iso) => (iso ? new Date(/(Z|[+-]\d{2}:\d{2})$/i.test(iso) ? iso : `${iso}Z`).toLocaleString() : '—');

function accentFor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function statusChip(server) {
  const map = {
    running: ['chip-running', 'Running'],
    starting: ['chip-starting', 'Starting'],
    stopped: ['chip-stopped', 'Stopped'],
  };
  const [cls, label] = map[server.status] || map.stopped;
  return `<span class="chip ${cls}"><span class="dot dot-${server.status}"></span>${label}</span>`;
}

function setModal(html) {
  const root = $('#modal-root');
  root.innerHTML = html ? `<div class="modal-overlay" data-close-modal="1">${html}</div>` : '';
  hydrateIcons(root);
}

function closeModal() { setModal(''); }

// ---------------------------------------------------------------- data

async function refreshServers() {
  state.servers = await window.esm.list();
  return state.servers;
}

// ---------------------------------------------------------------- views

function renderNav() {
  const active = { add: 'add', settings: 'settings' }[state.route.name] || 'servers';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === active));
}

async function render() {
  renderNav();
  const view = $('#view');
  const prev = view.innerHTML;
  if (state.route.name === 'servers') await renderServerList(view, prev);
  if (state.route.name === 'detail') await renderDetail(view);
  if (state.route.name === 'settings') await renderSettings(view);
  if (state.route.name === 'add') { location.hash = '#/servers'; openAddModal(); }
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'servers' && parts[1]) {
    return { name: 'detail', id: parts[1], tab: parts[2] || 'overview' };
  }
  if (parts[0] === 'add') return { name: 'add' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'servers' };
}

// ---- server list

async function renderServerList(view) {
  const servers = await refreshServers();
  const running = servers.filter((s) => s.running).length;
  const html = `
    <header class="page-head">
      <div>
        <h1>Servers</h1>
        <p class="summary">${servers.length} server${servers.length === 1 ? '' : 's'} · ${running} running</p>
      </div>
      <div class="row">
        <button class="btn btn-primary" data-action="open-add"> ${icon('plus', 16)} Add Server</button>
      </div>
    </header>
    ${servers.length === 0 ? emptyState() : `<div class="server-list">${servers.map(serverCard).join('')}</div>`}
  `;
  view.innerHTML = html;
  hydrateIcons(view);
}

function emptyState() {
  return `
    <div class="panel empty">
      <div class="empty-icon">${icon('folder', 34)}</div>
      <h2>No servers yet</h2>
      <p class="subtle" style="max-width:460px;margin:0.4rem auto 1.3rem">
        Point the client at an existing Enshrouded dedicated server folder, or let it install one with SteamCMD.
      </p>
      <button class="btn btn-primary" data-action="open-add">${icon('plus', 16)} Add Server</button>
    </div>`;
}

function serverCard(s) {
  const busy = state.busy[s.id];
  const accent = accentFor(s.id);
  const initial = esc((s.name || '?').trim().charAt(0).toUpperCase());
  const missing = !s.installed ? `<span class="chip chip-missing">Not installed</span>` : '';
  const controls = s.running
    ? `<button class="btn btn-ghost" data-action="restart" data-id="${s.id}" title="Restart" ${busy ? 'disabled' : ''}>${icon('restart', 16)}</button>
       <button class="btn btn-danger" data-action="stop" data-id="${s.id}" title="Stop" ${busy ? 'disabled' : ''}>${icon('stop', 16)}</button>`
    : `<button class="btn btn-primary" data-action="start" data-id="${s.id}" ${busy || !s.installed ? 'disabled' : ''}>${icon('play', 16)} ${busy === 'start' ? 'Starting…' : 'Start'}</button>`;
  return `
    <div class="panel server-card" style="border-left-color:${accent}">
      <div class="server-icon" style="background:${accent}">${initial}</div>
      <div class="server-main">
        <div class="server-title">
          <a href="#/servers/${s.id}">${esc(s.name)}</a>
          ${statusChip(s)}
          ${missing}
        </div>
        <div class="server-sub">Query port ${esc(s.query_port)} · ${esc(s.slot_count)} slots${s.running ? ` · PID ${s.pid}` : ''}${s.next_restart ? ` · Restarts ${esc(s.next_restart)}` : ''}</div>
      </div>
      <div class="stats">
        <div><div class="stat-value">${s.running ? fmtUptime(s.uptime_seconds) : '—'}</div><div class="stat-label">Uptime</div></div>
        <div><div class="stat-value">${s.running && s.players != null ? `${s.players}/${s.max_players}` : '—'}</div><div class="stat-label">Online</div></div>
        <div><div class="stat-value">${fmtPercent(s.cpu_percent)}</div><div class="stat-label">CPU</div></div>
        <div><div class="stat-value">${fmtRam(s.ram_bytes)}</div><div class="stat-label">RAM</div></div>
      </div>
      <div class="server-actions">
        ${controls}
        <a class="btn btn-ghost" href="#/servers/${s.id}">Manage</a>
      </div>
    </div>`;
}

// ---- detail

async function renderDetail(view) {
  const { id, tab } = state.route;
  let server;
  try {
    server = await window.esm.get(id);
  } catch {
    toast('Server not found', 'error');
    location.hash = '#/servers';
    return;
  }
  const tabs = [['overview', 'Overview'], ['players', 'Players'], ['map', 'Map'], ['schedule', 'Schedule'], ['settings', 'Settings'], ['logs', 'Logs'], ['backups', 'Backups']];
  const busy = state.busy[id];
  const header = `
    <a class="back" href="#/servers">← Servers</a>
    <header class="page-head" style="margin-top:0.6rem">
      <div>
        <div class="row" style="gap:0.7rem">
          <div class="server-icon" style="background:${accentFor(id)};width:40px;height:40px;font-size:1rem">${esc(server.name.charAt(0).toUpperCase())}</div>
          <h1>${esc(server.name)}</h1>
          ${statusChip(server)}
        </div>
        <p class="summary">${esc(server.path)}</p>
      </div>
      <div class="row wrap">
        ${server.running
          ? `<button class="btn btn-ghost" data-action="restart" data-id="${id}" ${busy ? 'disabled' : ''}>${icon('restart', 16)} Restart</button>
             <button class="btn btn-danger" data-action="stop" data-id="${id}" ${busy ? 'disabled' : ''}>${icon('stop', 16)} Stop</button>`
          : `<button class="btn btn-primary" data-action="start" data-id="${id}" ${busy || !server.installed ? 'disabled' : ''}>${icon('play', 16)} Start</button>`}
      </div>
    </header>
    <nav class="tabs">
      ${tabs.map(([key, label]) => `<button class="tab ${tab === key ? 'active' : ''}" data-tab="${key}">${label}</button>`).join('')}
    </nav>
    <div class="tab-body" id="tab-body"></div>`;
  view.innerHTML = header;
  const body = $('#tab-body', view);
  if (tab === 'overview') body.innerHTML = overviewTab(server, await loadPlayersSafe(server.id), await loadLivemapSafe(server.id));
  if (tab === 'players') await playersTab(body, server.id);
  if (tab === 'map') await mapTab(body, server);
  if (tab === 'schedule') await scheduleTab(body, server.id);
  if (tab === 'settings') await settingsTab(body, server);
  if (tab === 'logs') await logsTab(body, server);
  if (tab === 'backups') await backupsTab(body, server);
  hydrateIcons(view);
}

// The overview refreshes every few seconds, so a failed player read should not blank the whole tab.
async function loadPlayersSafe(serverId) {
  try {
    return await window.esm.getPlayers(serverId);
  } catch {
    return null;
  }
}

// Summary of who is online, for the Overview tab. Names come from the server log; the count falls back to the query port.
function onlinePanel(serverId, players) {
  let count = 'Checking…';
  let body = '<p class="subtle small" style="margin:0">Players appear once the server is running.</p>';
  if (players && !players.running) {
    count = 'Server stopped';
  } else if (players?.log_ready) {
    count = `${players.online.length}`;
    body = players.online.length
      ? `<ul class="name-list">${players.online.map((p) => `<li><span>${esc(p.name)}</span><span class="subtle small">seen ${fmtDate(p.joined_at)}</span></li>`).join('')}</ul>`
      : '<p class="subtle" style="margin:0">Nobody is online.</p>';
  } else if (players?.live?.error) {
    count = 'No reply';
    body = `<p class="small" style="color:var(--red);font-weight:700;margin:0">${esc(players.live.error)}</p>`;
  } else if (players?.live) {
    count = `${players.live.players} / ${players.live.maxPlayers}`;
    body = '<p class="subtle small" style="margin:0">Count from the query port. Names appear once the server log is read.</p>';
  }
  return `
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <div class="row" style="margin-bottom:0.6rem">
        <div class="grow">
          <div class="info-label">Online now</div>
          <div class="players-count" style="font-size:1.6rem">${esc(count)}</div>
        </div>
        <a class="btn btn-ghost btn-sm" href="#/servers/${serverId}/players">Players</a>
      </div>
      ${body}
    </div>`;
}

async function loadLivemapSafe(serverId) {
  try {
    return await window.esm.getLivemap(serverId);
  } catch {
    return null;
  }
}

// Live map status, share link and install button for the Overview tab.
function livemapPanel(s, lm) {
  if (!lm) return '';
  let status = 'Not installed';
  if (lm.installed) status = 'Installed';
  else if (!lm.source_ready) status = `Not installed. Put iphlpapi.dll and the livemap folder in ${lm.source_folder}`;
  const warning = lm.build_problem
    ? '<p class="small" style="color:var(--red);font-weight:700;margin:0.6rem 0 0">The live map reports an unknown server build. It won\'t show players until its author adds this build.</p>'
    : '';
  const link = lm.link
    ? `<div class="row" style="margin-top:0.7rem"><input class="input mono" id="livemap-link" readonly value="${esc(lm.link)}"><button class="btn btn-ghost" data-action="copy-livemap">Copy</button></div>`
    : '<p class="subtle small" style="margin:0.6rem 0 0">The share link appears here after the server has started with the live map.</p>';
  const label = lm.installed ? 'Reinstall live map' : 'Install live map';
  const disabled = lm.running || !lm.source_ready ? 'disabled' : '';
  const hint = lm.running ? ' Stop the server to install or reinstall.' : '';
  return `
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <div class="row" style="margin-bottom:0.4rem">
        <h3 class="grow">Live map</h3>
        <button class="btn btn-ghost btn-sm" data-action="install-livemap" data-id="${s.id}" ${disabled}>${label}</button>
      </div>
      <p class="small subtle" style="margin:0">Status: ${esc(status)}.${esc(hint)}</p>
      <p class="small subtle" style="margin:0.6rem 0 0">Share the link below with friends so they can watch the live map. Anyone with the link can see where every player is, so only share it with people you trust.</p>
      ${warning}${link}
    </div>`;
}

function overviewTab(s, players, livemap) {
  return `
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <div class="info-grid">
        <div><div class="info-label">Status</div><div class="info-value">${s.running ? 'Running' : 'Stopped'}</div></div>
        <div><div class="info-label">Uptime</div><div class="info-value">${s.running ? fmtUptime(s.uptime_seconds) : '—'}</div></div>
        <div><div class="info-label">PID</div><div class="info-value">${s.running ? s.pid : '—'}</div></div>
        <div><div class="info-label">Query port</div><div class="info-value">${esc(s.query_port)}</div></div>
        <div><div class="info-label">Slots</div><div class="info-value">${esc(s.slot_count)}</div></div>
        <div><div class="info-label">Players online</div><div class="info-value">${s.running && s.players != null ? `${s.players} / ${s.max_players}` : '—'}</div></div>
        <div><div class="info-label">Build</div><div class="info-value">${esc(s.build_id || '—')}${s.latest_build && s.latest_build !== s.build_id ? ` <span class="subtle small">→ ${esc(s.latest_build)} available</span>` : ''}</div></div>
        <div><div class="info-label">CPU</div><div class="info-value">${fmtPercent(s.cpu_percent)}</div></div>
        <div><div class="info-label">RAM</div><div class="info-value">${fmtRam(s.ram_bytes)}</div></div>
        <div><div class="info-label">Next restart</div><div class="info-value">${esc(s.next_restart || 'Not scheduled')}</div></div>
        <div><div class="info-label">Last update</div><div class="info-value">${fmtDate(s.last_update_at)}</div></div>
      </div>
      ${s.last_update_warning ? `<p class="small" style="color:var(--red);margin:1rem 0 0;font-weight:700">Last update warning: ${esc(s.last_update_warning)}</p>` : ''}
      <div class="row wrap" style="margin-top:1.1rem">
        <button class="btn btn-ghost" data-action="open-folder" data-path="${esc(s.path)}">${icon('folder', 16)} Open folder</button>
        <button class="btn btn-ghost" data-action="update" data-id="${s.id}" ${s.running || state.busy[s.id] ? 'disabled' : ''} title="${s.running ? 'Stop the server first' : ''}">${icon('download', 16)} Check for updates</button>
        <label class="check" style="margin-left:auto">
          <input type="checkbox" data-action="auto-restart" data-id="${s.id}" ${s.auto_restart ? 'checked' : ''}> Restart automatically after a crash
        </label>
      </div>
    </div>
    ${onlinePanel(s.id, players)}
    ${livemapPanel(s, livemap)}
    <div class="panel panel-pad danger-zone">
      <div class="row wrap">
        <div class="grow">
          <h3>Remove from manager</h3>
          <p class="subtle small" style="margin:0.25rem 0 0">Removes the server from this client only. Server files stay on disk.</p>
        </div>
        <button class="btn btn-danger" data-action="remove" data-id="${s.id}" ${s.running ? 'disabled' : ''}>${icon('trash', 16)} Remove</button>
      </div>
    </div>`;
}

// ---- map tab: the live map page, shown inside the app. Not part of the periodic refresh, so it doesn't reload.

async function mapTab(body, server) {
  const lm = await loadLivemapSafe(server.id);
  if (!lm) {
    body.innerHTML = '<p class="subtle">The live map status could not be read.</p>';
    return;
  }
  if (!lm.installed) {
    body.innerHTML = `
      <div class="panel panel-pad">
        <h3>Live map is not installed</h3>
        <p class="subtle small" style="margin:0.4rem 0 0.9rem">Install it from the Overview, or from the button below while the server is stopped.</p>
        <button class="btn btn-primary" data-action="install-livemap" data-id="${server.id}" ${lm.running || !lm.source_ready ? 'disabled' : ''}>Install live map</button>
      </div>`;
    return;
  }
  if (!lm.running || !lm.local_url) {
    body.innerHTML = '<div class="panel panel-pad"><p class="subtle" style="margin:0">Start the server to see the live map.</p></div>';
    return;
  }
  body.innerHTML = `<iframe class="livemap-frame" title="Live map" src="${esc(lm.local_url)}"></iframe>`;
}

// ---- players tab: names and join/leave events from the server log, count from the log or the query port

async function playersTab(body, serverId) {
  const data = await window.esm.getPlayers(serverId);
  const snap = data.live;
  let count = 'Checking…';
  if (!data.running) count = 'Server stopped';
  else if (data.log_ready) count = `${data.online.length}`;
  else if (snap?.error) count = 'No reply';
  else if (snap) count = `${snap.players} / ${snap.maxPlayers}`;

  const names = !data.running
    ? '<p class="subtle">The server is stopped.</p>'
    : !data.log_ready
      ? '<p class="subtle">Names come from the server log. Start the server and the list fills in once it writes its log.</p>'
      : data.online.length
        ? `<ul class="name-list">${data.online.map((p) => `<li><span>${esc(p.name)}</span><span class="subtle small">seen ${fmtDate(p.joined_at)}</span></li>`).join('')}</ul>`
        : '<p class="subtle">Nobody is online.</p>';
  const events = data.events.length
    ? data.events.map((e) => `${fmtDate(e.time)}   ${e.type}   ${e.name}`).join('\n')
    : 'No join or leave events yet.';

  body.innerHTML = `
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <div class="row wrap" style="gap:2rem">
        <div>
          <div class="info-label">Online now</div>
          <div class="players-count">${esc(count)}</div>
          ${snap?.error && !data.log_ready ? `<div class="small" style="color:var(--red);font-weight:700;max-width:420px">${esc(snap.error)}</div>` : ''}
          <div class="small subtle">${data.log_ready ? 'Counted from the server log' : (snap?.checked_at ? `Query checked ${fmtDate(snap.checked_at)}` : '')}</div>
        </div>
        ${snap?.name ? `<div><div class="info-label">Name (from query)</div><div class="info-value">${esc(snap.name)}</div></div>` : ''}
        <div class="row grow wrap" style="justify-content:flex-end">
          <button class="btn btn-ghost" data-action="refresh-players">${icon('refresh', 16)} Refresh</button>
          <button class="btn btn-ghost" data-action="probe-query">Probe query port</button>
        </div>
      </div>
    </div>
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3 style="margin-bottom:0.5rem">Online</h3>
      ${names}
    </div>
    <div class="panel panel-pad">
      <h3 style="margin-bottom:0.5rem">Recent join and leave events</h3>
      <div class="console" style="height:220px">${esc(events)}</div>
    </div>
    <div class="panel panel-pad" id="probe-out" style="margin-top:1rem;display:none"></div>`;
}

// ---- schedule tab

// Keeps the draft in state while the tab is open, so adding a time does not reload and lose unsaved edits.
async function scheduleTab(body, serverId) {
  if (state.scheduleFor !== serverId || !state.scheduleDraft) {
    const { schedule, last_auto_backup_at } = await window.esm.getSchedule(serverId);
    state.scheduleFor = serverId;
    state.scheduleDraft = structuredClone(schedule);
    state.scheduleDraft.last_auto_backup_at = last_auto_backup_at;
  }
  const d = state.scheduleDraft;
  const server = await window.esm.get(serverId);
  body.innerHTML = `
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3>Daily restarts</h3>
      <p class="small subtle" style="margin:0.2rem 0 0.8rem">The server restarts at each time, in this computer's local time. Only running servers restart.</p>
      <div class="row wrap" style="margin-bottom:0.8rem">
        ${d.restart_times.length
          ? d.restart_times.map((t) => `<span class="chip chip-ok time-chip">${esc(t)}<button class="icon-btn" data-action="remove-restart-time" data-time="${esc(t)}" title="Remove">✕</button></span>`).join('')
          : '<span class="subtle small">No restart times set.</span>'}
      </div>
      <div class="row wrap">
        <input class="input" type="time" id="new-time" style="width:150px">
        <button class="btn btn-ghost" data-action="add-restart-time">Add time</button>
      </div>
      <label class="check" style="margin-top:0.9rem">
        <input type="checkbox" id="update-first" ${d.update_before_restart ? 'checked' : ''}> Check for updates before each restart
      </label>
    </div>
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3>Automatic backups</h3>
      <p class="small subtle" style="margin:0.2rem 0 0.9rem">Automatic backups are named auto-…, and the oldest are removed past the keep count. Manual backups are never removed. A backup taken while the server runs can catch a save mid-write, so a restart time is the safer moment.</p>
      <div class="form-grid">
        <div class="field"><label class="label">How often</label>
          <select class="select" id="backup-interval">
            ${BACKUP_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === d.backup_interval_minutes ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="label">Automatic backups to keep</label>
          <input class="input" type="number" min="1" max="100" id="backup-keep" value="${esc(d.backup_keep)}">
        </div>
      </div>
      <p class="small subtle" style="margin:0">${d.last_auto_backup_at ? `Last automatic backup: ${fmtDate(d.last_auto_backup_at)}` : 'No automatic backup yet.'}</p>
    </div>
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3>Game updates</h3>
      <p class="small subtle" style="margin:0.2rem 0 0.9rem">Updates go through SteamCMD. The server must be stopped to update, so a newer build waits for the next stop while the server runs.</p>
      <div class="info-grid" style="margin-bottom:0.9rem">
        <div><div class="info-label">Installed build</div><div class="info-value">${esc(server.build_id || '—')}</div></div>
        <div><div class="info-label">Latest build</div><div class="info-value">${esc(server.latest_build || 'Not checked yet')}</div></div>
        <div><div class="info-label">Status</div><div class="info-value">${server.update_pending ? 'Update waiting for the next stop' : (server.latest_build && server.latest_build !== server.build_id ? 'Newer build available' : 'Up to date or not checked')}</div></div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="label">Check for new builds</label>
          <select class="select" id="s-checkhours">
            ${UPDATE_HOUR_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === d.update_check_hours ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="label">&nbsp;</label>
          <button class="btn btn-ghost" data-action="check-build" data-id="${server.id}">${icon('refresh', 16)} Check now</button>
        </div>
      </div>
      <div class="row wrap" style="gap:1.4rem">
        <label class="check"><input type="checkbox" id="s-updbefore" ${d.update_before_start ? 'checked' : ''}> Update before every start</label>
        <label class="check"><input type="checkbox" id="s-autoinstall" ${d.auto_install ? 'checked' : ''}> Install new builds when the server is stopped</label>
      </div>
    </div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn btn-primary" data-action="save-schedule">Save schedule</button>
    </div>`;
}

// Copies what is on screen into the draft, so a re-render does not drop unsaved changes.
function readScheduleForm() {
  const draft = state.scheduleDraft;
  const first = $('#update-first');
  if (!draft || !first) return;
  draft.update_before_restart = first.checked;
  draft.backup_interval_minutes = Number($('#backup-interval').value);
  draft.backup_keep = Number($('#backup-keep').value);
  draft.update_check_hours = Number($('#s-checkhours').value);
  draft.update_before_start = $('#s-updbefore').checked;
  draft.auto_install = $('#s-autoinstall').checked;
}

// ---- settings page: general, notifications (Discord) and defaults for new servers

const THEME_OPTIONS = ['dark', 'light', 'system'];
const REFRESH_OPTIONS = [[5, 'Every 5 seconds'], [10, 'Every 10 seconds'], [30, 'Every 30 seconds'], [60, 'Every minute'], [120, 'Every 2 minutes (default)'], [300, 'Every 5 minutes']];
const UPDATE_HOUR_OPTIONS = [[0, 'Never'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Every 24 hours']];

async function renderSettings(view) {
  const { general: g, discord, serverDefaults: d } = await window.esm.getSettings();
  const check = (id, on) => `<input type="checkbox" id="${id}" ${on ? 'checked' : ''}>`;
  view.innerHTML = `
    <header class="page-head">
      <div>
        <h1>Settings</h1>
        <p class="summary">Client options, notifications and the defaults for new servers.</p>
      </div>
    </header>

    <div class="save-bar">
      <button class="btn btn-ghost" data-action="test-alerts">Send test Discord alert</button>
      <button class="btn btn-primary" data-action="save-settings">Save settings</button>
    </div>

    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3 style="margin-bottom:0.8rem">General</h3>
      <div class="form-grid">
        <div class="field"><label class="label">Theme</label>
          <select class="select" id="g-theme">
            ${THEME_OPTIONS.map((t) => `<option value="${t}" ${g.theme === t ? 'selected' : ''}>${t[0].toUpperCase()}${t.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="label">Screen refresh</label>
          <select class="select" id="g-refresh">
            ${REFRESH_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === g.refreshSeconds ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="label">Folder for new installs</label>
          <div class="row">
            <input class="input" id="g-folder" value="${esc(g.newInstallFolder)}" placeholder="Empty uses the app data folder">
            <button class="btn btn-ghost" data-action="pick-install-folder">Browse</button>
          </div>
        </div>
      </div>
      <div class="row wrap" style="gap:1.4rem">
        <label class="check">${check('g-startup', g.startWithWindows)} Start with Windows</label>
        <label class="check">${check('g-minimized', g.startMinimized)} Start minimized to the tray</label>
        <label class="check">${check('g-tray', g.closeToTray)} Closing the window keeps it in the tray</label>
        <label class="check">${check('g-autostart', g.autoStartServers)} Start servers that were running when the client closed</label>
      </div>
    </div>

    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3 style="margin-bottom:0.8rem">Notifications</h3>
      <label class="check">${check('g-desktop', g.desktopNotifications)} Show a Windows notification when a server crashes</label>
      <h3 style="margin:1.2rem 0 0.5rem">Discord</h3>
      <p class="small subtle" style="margin:0 0 0.8rem">In Discord, open the channel settings, then Integrations, then Webhooks, and copy the URL. Anyone with the URL can post to that channel, so keep it private.</p>
      <div class="field" style="margin:0 0 0.9rem">
        <label class="label">Webhook URL</label>
        <input class="input mono" id="alert-url" value="${esc(discord.url)}" placeholder="https://discord.com/api/webhooks/…">
      </div>
      <div class="form-grid">
        ${EVENT_LABELS.map(([key, label]) => `<label class="check"><input type="checkbox" data-alert-event="${key}" ${discord.events[key] ? 'checked' : ''}> ${label}</label>`).join('')}
      </div>
    </div>

    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3>Defaults for new servers</h3>
      <p class="small subtle" style="margin:0.2rem 0 0.9rem">These apply to servers you add or install from now on. Existing servers keep their own settings.</p>
      <div class="form-grid">
        <div class="field"><label class="label">Automatic backups</label>
          <select class="select" id="d-interval">
            ${BACKUP_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === d.backup_interval_minutes ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="label">Automatic backups to keep</label>
          <input class="input" type="number" min="1" max="100" id="d-keep" value="${esc(d.backup_keep)}">
        </div>
        <div class="field"><label class="label">Restart times (comma separated, 24-hour)</label>
          <input class="input" id="d-times" value="${esc(d.restart_times.join(', '))}" placeholder="04:00, 16:30">
        </div>
        <div class="field"><label class="label">Check for game updates</label>
          <select class="select" id="d-checkhours">
            ${UPDATE_HOUR_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === d.update_check_hours ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row wrap" style="gap:1.4rem">
        <label class="check">${check('d-autorestart', d.auto_restart)} Restart after a crash</label>
        <label class="check">${check('d-updbefore', d.update_before_start)} Update before every start</label>
        <label class="check">${check('d-updrestart', d.update_before_restart)} Update before each scheduled restart</label>
        <label class="check">${check('d-autoinstall', d.auto_install)} Install new builds when the server is stopped</label>
      </div>
    </div>

  `;
}

function collectSettingsForm() {
  const on = (id) => $(`#${id}`).checked;
  const events = {};
  document.querySelectorAll('[data-alert-event]').forEach((el) => { events[el.dataset.alertEvent] = el.checked; });
  return {
    discord: { url: $('#alert-url').value.trim(), events },
    general: {
      theme: $('#g-theme').value,
      refreshSeconds: Number($('#g-refresh').value),
      newInstallFolder: $('#g-folder').value.trim(),
      startWithWindows: on('g-startup'),
      startMinimized: on('g-minimized'),
      closeToTray: on('g-tray'),
      autoStartServers: on('g-autostart'),
      desktopNotifications: on('g-desktop'),
    },
    serverDefaults: {
      auto_restart: on('d-autorestart'),
      backup_interval_minutes: Number($('#d-interval').value),
      backup_keep: Number($('#d-keep').value),
      restart_times: $('#d-times').value.split(',').map((t) => t.trim()).filter(Boolean),
      update_check_hours: Number($('#d-checkhours').value),
      update_before_start: on('d-updbefore'),
      update_before_restart: on('d-updrestart'),
      auto_install: on('d-autoinstall'),
    },
  };
}

async function settingsTab(body, server) {
  const { config, exists } = await window.esm.getConfig(server.id);
  state.settingsDraft = structuredClone(config);
  state.settingsMeta = { running: server.running, exists, serverId: server.id };
  paintSettings(body);
}

// Draws the settings from state.settingsDraft. Used for fresh loads and for changes made on screen.
// Server tags the game accepts. Keep in step with SERVER_TAGS in electron/server-manager.js.
const SERVER_TAG_GROUPS = [
  ['Language', ['English', 'German', 'French', 'Italian', 'Japanese', 'Korean', 'Polish', 'Portuguese', 'Russian',
    'Spanish', 'Thai', 'Turkish', 'Ukrainian', 'Chinese', 'Taiwanese']],
  ['Playstyle', ['BaseBuilding', 'Exploration', 'Roleplay']],
  ['Availability', ['LookingForPlayers']],
];
const SERVER_TAG_LIST = SERVER_TAG_GROUPS.flatMap(([, tags]) => tags);

function paintSettings(body) {
  const { running, exists, serverId } = state.settingsMeta;
  const cfg = state.settingsDraft;
  const unknownTags = (cfg.tags || []).filter((t) => !SERVER_TAG_LIST.includes(t));
  const adv = state.settingsAdvanced;
  body.innerHTML = `
    <div class="save-bar">
      <span class="small subtle">${running ? 'Changes apply after a restart' : 'Changes apply the next time the server starts'}</span>
      <button class="btn btn-primary" data-action="save-config" data-id="${serverId}">Save settings</button>
    </div>
    ${running ? '<p class="small" style="color:var(--yellow);font-weight:700">The server is running. Changes apply after a restart.</p>' : ''}
    ${exists ? '' : '<p class="small subtle">No enshrouded_server.json yet. Saving creates it.</p>'}
    <div class="seg">
      <button class="${adv ? '' : 'active'}" data-settings-mode="form">Form</button>
      <button class="${adv ? 'active' : ''}" data-settings-mode="json">Raw JSON</button>
    </div>
    ${adv ? `
      <textarea class="textarea" id="cfg-json">${esc(JSON.stringify(cfg, null, 2))}</textarea>
      <p class="small subtle">Edit user groups, bans and any other field directly. Invalid JSON is rejected on save.</p>`
    : `
      <div class="panel panel-pad" style="margin-bottom:1rem">
        <h3 style="margin-bottom:0.8rem">General</h3>
        <div class="form-grid">
          <div class="field"><label class="label">Server name</label><input class="input" name="name" value="${esc(cfg.name)}"></div>
          <div class="field"><label class="label">Password</label><input class="input" name="password" value="${esc(cfg.password)}" placeholder="Leave blank for public"></div>
          <div class="field"><label class="label">Query port</label><input class="input" type="number" name="queryPort" min="1024" max="65535" value="${esc(cfg.queryPort)}"></div>
          <div class="field"><label class="label">Slots</label><input class="input" type="number" name="slotCount" min="1" max="64" value="${esc(cfg.slotCount)}"></div>
          <div class="field"><label class="label">Bind IP</label><input class="input" name="ip" value="${esc(cfg.ip)}"></div>
          <div class="field"><label class="label">Save directory</label><input class="input" name="saveDirectory" value="${esc(cfg.saveDirectory)}"></div>
          <div class="field"><label class="label">Log directory</label><input class="input" name="logDirectory" value="${esc(cfg.logDirectory)}"></div>
        </div>
        <div class="row wrap" style="gap:1.4rem">
          <label class="check"><input type="checkbox" name="enableVoiceChat" ${cfg.enableVoiceChat ? 'checked' : ''}> Voice chat</label>
          <label class="check"><input type="checkbox" name="enableTextChat" ${cfg.enableTextChat ? 'checked' : ''}> Text chat</label>
        </div>
        <h3 style="margin:1.1rem 0 0.4rem">Server tags</h3>
        <p class="small subtle" style="margin:0 0 0.6rem">Tags shown in the server browser. Only the game's own tags work; the game rejects anything else.</p>
        ${unknownTags.length ? `<p class="small" style="color:var(--yellow);font-weight:700;margin:0 0 0.6rem">Not on the game's list, removed when you save: ${esc(unknownTags.join(', '))}</p>` : ''}
        ${SERVER_TAG_GROUPS.map(([title, tags]) => `
          <div class="small subtle" style="margin:0.5rem 0 0.2rem">${title}</div>
          <div class="row wrap" style="gap:0.9rem">
            ${tags.map((t) => `<label class="check"><input type="checkbox" data-tag="${t}" ${(cfg.tags || []).includes(t) ? 'checked' : ''}> ${t}</label>`).join('')}
          </div>`).join('')}
      </div>
      ${gameSettingsPanel(effectiveGameSettings(cfg))}`}
    </div>`;
  syncPresetUI();
}

// ---- world settings (presets and sliders)

function gameSettingsPanel(gs) {
  return `
    <div class="panel panel-pad" style="margin-bottom:1rem">
      <h3>World settings</h3>
      <p class="small subtle" style="margin:0.2rem 0 0.8rem">Pick a preset, or choose Custom to set each value. Presets are built into the server, so the sliders stay locked unless Custom is selected.</p>
      <div class="row wrap" style="gap:0.4rem">
        ${PRESET_NAMES.map((p) => `<button class="btn" data-action="set-preset" data-preset="${p}">${p}</button>`).join('')}
        <button class="btn btn-ghost" id="apply-preset" data-action="apply-preset" style="margin-left:auto">Apply to Custom</button>
      </div>
      <p class="small subtle" id="preset-note" style="margin:0.7rem 0 0"></p>
    </div>
    ${GAME_SECTIONS.map((section) => `
      <div class="panel panel-pad" style="margin-bottom:1rem">
        <h3 style="margin-bottom:0.2rem">${section.title}</h3>
        ${section.items.map((item) => gameRow(item, gs)).join('')}
      </div>`).join('')}
    <p class="small subtle">Other settings, such as user groups and bans, are in Raw JSON.</p>`;
}

function gameRow(item, gs) {
  const raw = gs[item.key] ?? item.def ?? (item.kind === 'pct' ? 1 : item.kind === 'bool' ? false : item.options?.[0][0]);
  const label = `<div class="gs-label">${esc(item.label)}</div>`;
  if (item.kind === 'bool') {
    return `<div class="gs-row">${label}
      <label class="switch"><input type="checkbox" data-gs="${item.key}" data-kind="bool" ${raw ? 'checked' : ''}><span></span></label>
      <span class="gs-value" data-gs-value="${item.key}">${raw ? 'On' : 'Off'}</span></div>`;
  }
  if (item.kind === 'enum') {
    const options = item.options.some(([v]) => v === raw) ? item.options : [...item.options, [raw, raw]];
    return `<div class="gs-row">${label}
      <select class="select" data-gs="${item.key}" data-kind="enum">
        ${options.map(([v, l]) => `<option value="${esc(v)}" ${v === raw ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select><span></span></div>`;
  }
  // Sliders: percentages for factors, whole minutes for durations.
  const isMinutes = item.kind === 'minutes';
  const value = isMinutes ? Math.round(Number(raw) / MIN_NS) : Math.round(Number(raw) * 100);
  const min = isMinutes ? item.min : 0;
  const max = isMinutes ? Math.max(item.max, value) : Math.max(200, Math.ceil(value / 50) * 50);
  const step = isMinutes ? 1 : 5;
  return `<div class="gs-row">${label}
    <input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-gs="${item.key}" data-kind="${item.kind}">
    <span class="gs-value" data-gs-value="${item.key}">${isMinutes ? `${value} min` : `${value}%`}</span></div>`;
}

// Locks the sliders unless the preset is Custom, highlights the active preset and explains which one is in use.
function syncPresetUI() {
  const preset = state.settingsDraft?.gameSettingsPreset || 'Default';
  const custom = preset === 'Custom';
  document.querySelectorAll('[data-preset]').forEach((b) => {
    b.className = `btn ${b.dataset.preset === preset ? 'btn-primary' : 'btn-ghost'}`;
  });
  document.querySelectorAll('[data-gs]').forEach((c) => { c.disabled = !custom; });
  const apply = $('#apply-preset');
  if (apply) apply.disabled = custom;
  const note = $('#preset-note');
  if (note) {
    note.textContent = custom
      ? 'Custom is active. The server uses the values below.'
      : `${preset} is active. The sliders show its built-in values from the wiki. Choose Custom, or use Apply to Custom, to edit them.`;
  }
}

// Updates the value label beside a control while it moves.
function onGameSettingChange(e) {
  const el = e.target.closest?.('[data-gs]');
  if (!el || el.disabled) return;
  el.dataset.dirty = '1'; // only changed controls are written back, so untouched values keep their exact stored form
  const label = document.querySelector(`[data-gs-value="${el.dataset.gs}"]`);
  if (!label) return;
  if (el.dataset.kind === 'bool') label.textContent = el.checked ? 'On' : 'Off';
  else if (el.dataset.kind === 'minutes') label.textContent = `${el.value} min`;
  else if (el.dataset.kind === 'pct') label.textContent = `${el.value}%`;
}

function readSettingsForm(root) {
  const cfg = state.settingsDraft;
  root.querySelectorAll('[name]').forEach((el) => {
    const key = el.name;
    if (el.type === 'checkbox') {
      cfg[key] = el.checked;
    } else if (el.type === 'number') {
      cfg[key] = Number(el.value);
    } else {
      cfg[key] = el.value;
    }
  });
  if (root.querySelector('[data-tag]')) {
    cfg.tags = [...root.querySelectorAll('[data-tag]:checked')].map((el) => el.dataset.tag);
  }
  root.querySelectorAll('[data-gs][data-dirty]').forEach((el) => {
    const key = el.dataset.gs;
    if (el.dataset.kind === 'bool') cfg.gameSettings[key] = el.checked;
    else if (el.dataset.kind === 'enum') cfg.gameSettings[key] = el.value;
    else if (el.dataset.kind === 'minutes') cfg.gameSettings[key] = Number(el.value) * MIN_NS;
    else cfg.gameSettings[key] = Number(el.value) / 100;
  });
  return cfg;
}

async function logsTab(body, server) {
  const logs = await window.esm.logs(server.id);
  if (!state.logName || !logs.some((l) => l.name === state.logName)) state.logName = logs[0]?.name || '';
  body.innerHTML = `
    <div class="split">
      <div class="panel panel-pad">
        <div class="row" style="margin-bottom:0.5rem"><h3 class="grow">Files</h3>
          <button class="icon-btn" data-action="refresh-log" title="Refresh">${icon('refresh', 16)}</button></div>
        <div class="file-list">
          ${logs.length ? logs.map((l) => `
            <button class="file-item ${l.name === state.logName ? 'active' : ''}" data-log="${esc(l.name)}">
              ${esc(l.name)}<div class="small" style="opacity:0.7">${fmtBytes(l.size)} · ${fmtDate(l.modified)}</div>
            </button>`).join('') : '<p class="subtle small">No log files yet. Start the server once to create them.</p>'}
        </div>
      </div>
      <div id="log-view"><div class="console" id="console">${state.logName ? 'Loading…' : 'Select a log file.'}</div></div>
    </div>`;
  if (state.logName) await loadLog(server.id);
}

async function loadLog(id) {
  const el = $('#console');
  if (!el) return;
  const res = await window.esm.readLog(id, state.logName);
  el.textContent = res.content || '(empty)';
  el.scrollTop = el.scrollHeight;
}

async function backupsTab(body, server) {
  const backups = await window.esm.backups(server.id);
  body.innerHTML = `
    <div class="panel panel-pad">
      <div class="row wrap" style="margin-bottom:0.8rem">
        <div class="grow">
          <h3>Backups</h3>
          <p class="small subtle" style="margin:0.2rem 0 0">Each backup holds enshrouded_server.json and the save folder. Restoring needs the server stopped; the current save is backed up first.</p>
        </div>
        <button class="btn btn-primary" data-action="create-backup" data-id="${server.id}">${icon('archive', 16)} Create backup</button>
      </div>
      ${backups.length === 0 ? '<p class="subtle">No backups yet.</p>' : `
      <table class="list">
        <thead><tr><th>Name</th><th>Size</th><th>Created</th><th></th></tr></thead>
        <tbody>
          ${backups.map((b) => `
            <tr>
              <td class="mono">${esc(b.name)}</td>
              <td>${fmtBytes(b.size)}</td>
              <td>${fmtDate(b.created)}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn btn-ghost btn-sm" data-action="restore-backup" data-id="${server.id}" data-name="${esc(b.name)}" ${server.running ? 'disabled title="Stop the server first"' : ''}>${icon('restore', 14)} Restore</button>
                <button class="btn btn-ghost btn-sm" data-action="delete-backup" data-id="${server.id}" data-name="${esc(b.name)}">${icon('trash', 14)}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
}

// ---------------------------------------------------------------- modals

function openAddModal(mode = 'existing') {
  setModal(`
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>Add Server</h2><button class="icon-btn" data-action="close-modal" title="Close">✕</button></div>
      <div class="seg">
        <button class="${mode === 'existing' ? 'active' : ''}" data-add-mode="existing">Existing folder</button>
        <button class="${mode === 'install' ? 'active' : ''}" data-add-mode="install">Install new</button>
      </div>
      ${mode === 'existing' ? `
        <div class="field"><label class="label">Name</label><input class="input" id="add-name" placeholder="My Enshrouded Server"></div>
        <div class="field"><label class="label">Server folder</label>
          <div class="row"><input class="input" id="add-path" placeholder="Folder containing enshrouded_server.exe">
          <button class="btn btn-ghost" data-action="pick-folder" data-target="add-path">Browse</button></div>
        </div>
        <p class="small subtle">Use this if the server is already installed. The folder must contain enshrouded_server.exe.</p>
        <div class="modal-foot"><button class="btn btn-ghost" data-action="close-modal">Cancel</button>
          <button class="btn btn-primary" data-action="submit-existing">Add server</button></div>
      ` : `
        <div class="field"><label class="label">Name</label><input class="input" id="add-name" placeholder="My Enshrouded Server"></div>
        <div class="field"><label class="label">Install folder (optional)</label>
          <div class="row"><input class="input" id="add-path" placeholder="Leave empty to use the app data folder">
          <button class="btn btn-ghost" data-action="pick-folder" data-target="add-path">Browse</button></div>
        </div>
        <p class="small subtle">Downloads SteamCMD if needed and installs the Enshrouded dedicated server (app ${'2278520'}). This can take 10 to 20 minutes.</p>
        <div class="modal-foot"><button class="btn btn-ghost" data-action="close-modal">Cancel</button>
          <button class="btn btn-primary" data-action="submit-install">Install</button></div>
      `}
    </div>`);
  $('#add-name')?.focus();
}

function openJobModal(title, jobId, onDone) {
  setModal(`
    <div class="modal modal-wide" role="dialog">
      <div class="modal-head"><h2>${esc(title)}</h2></div>
      <div class="progress" id="job-bar"></div>
      <div class="console" id="job-log" style="height:320px">Starting…</div>
      <div class="modal-foot">
        <button class="btn btn-ghost" data-action="close-modal">Hide</button>
        <button class="btn btn-primary" id="job-done" disabled>Done</button>
      </div>
    </div>`);
  const tick = async () => {
    let job;
    try {
      job = await window.esm.getJob(jobId);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const logEl = $('#job-log');
    if (!logEl) return; // modal closed
    logEl.textContent = job.lines.join('\n') || 'Working…';
    logEl.scrollTop = logEl.scrollHeight;
    const bar = $('#job-bar');
    if (job.status === 'running') {
      setTimeout(tick, 1000);
      return;
    }
    bar.className = `progress ${job.status === 'done' ? 'done' : 'error'}`;
    const doneBtn = $('#job-done');
    doneBtn.disabled = false;
    doneBtn.onclick = closeModal;
    if (job.status === 'error') {
      logEl.textContent += `\n\nFailed: ${job.error}`;
      toast(`${title} failed`, 'error');
    } else {
      toast(`${title} finished`, 'success');
    }
    onDone?.(job);
  };
  tick();
}

// ---------------------------------------------------------------- actions

async function runAction(action, el) {
  const id = el.dataset.id;
  switch (action) {
    case 'open-add': location.hash = '#/add'; return openAddModal();
    case 'close-modal': return closeModal();
    case 'start':
    case 'stop':
    case 'restart': {
      state.busy[id] = action;
      render();
      try {
        const res = await call(window.esm[action], id);
        const done = { start: 'started', stop: 'stopped', restart: 'restarted' }[action];
        toast(`${res.name} ${done}`, 'success');
      } catch { /* toast shown by call() */ } finally {
        delete state.busy[id];
        render();
      }
      return;
    }
    case 'update': {
      const job = await call(window.esm.update, id);
      return openJobModal('Check for updates', job.id, () => render());
    }
    case 'remove': {
      if (!confirm('Remove this server from the manager? Files stay on disk.')) return;
      await call(window.esm.remove, id);
      toast('Server removed from the manager', 'success');
      location.hash = '#/servers';
      return;
    }
    case 'auto-restart': {
      await call(window.esm.setAutoRestart, id, el.checked);
      toast(el.checked ? 'Auto-restart on' : 'Auto-restart off', 'info');
      return;
    }
    case 'open-folder':
      return window.esm.openFolder(el.dataset.path);
    case 'save-config': {
      let config;
      if (state.settingsAdvanced) {
        try {
          config = JSON.parse($('#cfg-json').value);
        } catch {
          return toast('Raw JSON is not valid', 'error');
        }
      } else {
        config = readSettingsForm($('#tab-body'));
      }
      const res = await call(window.esm.saveConfig, id, config);
      toast(res.restart_required ? 'Saved. Restart the server to apply.' : 'Settings saved', 'success');
      state.settingsDraft = config;
      return render();
    }
    case 'refresh-players':
      return render();
    case 'install-livemap': {
      await call(window.esm.installLivemap, id);
      toast('Live map installed. It starts with the server.', 'success');
      return render();
    }
    case 'copy-livemap': {
      const link = $('#livemap-link')?.value || '';
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied', 'success');
      } catch {
        toast('Could not copy the link', 'error');
      }
      return;
    }
    case 'probe-query': {
      const res = await window.esm.probeQuery(state.route.id);
      const out = $('#probe-out');
      out.style.display = 'block';
      out.innerHTML = res.ok
        ? `<h3>Probe reply</h3>
           <p class="small subtle">${esc(res.host)}:${esc(res.port)}</p>
           <div class="console" style="height:auto;max-height:280px">${esc(JSON.stringify(res.parsed, null, 2))}\n\nRaw reply (hex):\n${esc(res.raw_hex)}</div>`
        : `<h3>Probe failed</h3><p class="small" style="color:var(--red);font-weight:700">${esc(res.error)}</p>`;
      return;
    }
    case 'set-preset': {
      readSettingsFromAny();
      state.settingsDraft.gameSettingsPreset = el.dataset.preset;
      return paintSettings($('#tab-body'));
    }
    case 'apply-preset': {
      // Copies the preset's values into the custom settings, then switches to Custom so they can be edited.
      readSettingsFromAny();
      const draft = state.settingsDraft;
      draft.gameSettings = presetGameSettings(draft.gameSettingsPreset, draft.gameSettings || {});
      draft.gameSettingsPreset = 'Custom';
      return paintSettings($('#tab-body'));
    }
    case 'add-restart-time': {
      const value = $('#new-time').value;
      if (!value) return toast('Pick a time first', 'error');
      readScheduleForm();
      if (state.scheduleDraft.restart_times.includes(value)) return toast('That time is already set', 'info');
      state.scheduleDraft.restart_times = [...state.scheduleDraft.restart_times, value].sort();
      return scheduleTab($('#tab-body'), state.route.id);
    }
    case 'remove-restart-time': {
      readScheduleForm();
      state.scheduleDraft.restart_times = state.scheduleDraft.restart_times.filter((t) => t !== el.dataset.time);
      return scheduleTab($('#tab-body'), state.route.id);
    }
    case 'save-schedule': {
      readScheduleForm();
      await call(window.esm.saveSchedule, state.route.id, state.scheduleDraft);
      state.scheduleDraft = null;
      toast('Schedule saved', 'success');
      return render();
    }
    case 'save-settings': {
      const saved = await call(window.esm.saveSettings, collectSettingsForm());
      applyTheme(saved.general.theme);
      scheduleRefresh(saved.general.refreshSeconds);
      toast('Settings saved', 'success');
      return render();
    }
    case 'test-alerts': {
      // Save the form first so the test uses what is on screen.
      await call(window.esm.saveSettings, collectSettingsForm());
      await call(window.esm.testAlerts);
      return toast('Test Discord alert sent', 'success');
    }
    case 'pick-install-folder': {
      const folder = await call(window.esm.pickFolder);
      if (folder) $('#g-folder').value = folder;
      return;
    }
    case 'check-build': {
      const res = await call(window.esm.checkBuild, id);
      toast(res.available ? `Build ${res.latest} is out` : `Up to date (build ${res.installed})`, res.available ? 'info' : 'success');
      return render();
    }
    case 'refresh-log':
      return render();
    case 'create-backup': {
      await call(window.esm.createBackup, id);
      toast('Backup created', 'success');
      return render();
    }
    case 'restore-backup': {
      if (!confirm(`Restore ${el.dataset.name}? The current save is backed up first.`)) return;
      await call(window.esm.restoreBackup, id, el.dataset.name);
      toast('Backup restored', 'success');
      return render();
    }
    case 'delete-backup': {
      if (!confirm(`Delete ${el.dataset.name}?`)) return;
      await call(window.esm.deleteBackup, id, el.dataset.name);
      return render();
    }
    case 'pick-folder': {
      const folder = await call(window.esm.pickFolder);
      if (folder) $(`#${el.dataset.target}`).value = folder;
      return;
    }
    case 'submit-existing': {
      const name = $('#add-name').value;
      const path = $('#add-path').value;
      const server = await call(window.esm.addExisting, { name, path });
      toast(`Added ${server.name}`, 'success');
      closeModal();
      location.hash = `#/servers/${server.id}`;
      return;
    }
    case 'submit-install': {
      const name = $('#add-name').value;
      const folder = $('#add-path').value;
      const job = await call(window.esm.installNew, { name, folder });
      closeModal();
      return openJobModal('Install server', job.id, (done) => {
        if (done.server_id) location.hash = `#/servers/${done.server_id}`;
        else render();
      });
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------- wiring

document.addEventListener('click', (e) => {
  const modalBg = e.target.closest('[data-close-modal]');
  if (modalBg && e.target === modalBg) return closeModal();

  const tab = e.target.closest('[data-tab]');
  if (tab) {
    location.hash = `#/servers/${state.route.id}/${tab.dataset.tab}`;
    return;
  }
  const mode = e.target.closest('[data-settings-mode]');
  if (mode) {
    const toJson = mode.dataset.settingsMode === 'json';
    if (!toJson) {
      // Leaving raw JSON: keep whatever is valid in the textarea.
      const raw = $('#cfg-json');
      if (raw) {
        try { state.settingsDraft = JSON.parse(raw.value); } catch { return toast('Fix the JSON before switching to Form', 'error'); }
      }
    } else {
      readSettingsFromAny();
    }
    state.settingsAdvanced = toJson;
    return paintSettings($('#tab-body'));
  }
  const addMode = e.target.closest('[data-add-mode]');
  if (addMode) return openAddModal(addMode.dataset.addMode);
  const logBtn = e.target.closest('[data-log]');
  if (logBtn) {
    state.logName = logBtn.dataset.log;
    document.querySelectorAll('.file-item').forEach((el) => el.classList.toggle('active', el === logBtn));
    return loadLog(state.route.id).catch((err) => toast(err.message, 'error'));
  }
  const actionEl = e.target.closest('[data-action]');
  if (actionEl && actionEl.tagName !== 'INPUT') {
    e.preventDefault();
    return runAction(actionEl.dataset.action, actionEl).catch(() => {});
  }
});

document.addEventListener('input', onGameSettingChange);
document.addEventListener('change', onGameSettingChange);
document.addEventListener('change', (e) => {
  const el = e.target.closest('input[data-action="auto-restart"]');
  if (el) runAction('auto-restart', el).catch(() => {});
});

function readSettingsFromAny() {
  const body = $('#tab-body');
  if (!body || state.settingsAdvanced) return;
  readSettingsForm(body);
}

const THEME_KEY = 'esm-theme';
// 'system' follows Windows, so it is resolved to dark or light before it is applied.
function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.dataset.theme = resolved;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
}

$('#theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

window.addEventListener('hashchange', () => {
  state.route = parseHash();
  state.settingsAdvanced = state.settingsAdvanced && state.route.tab === 'settings';
  state.scheduleDraft = null; // unsaved schedule edits do not survive leaving the tab
  render().catch((err) => toast(err.message, 'error'));
});

async function boot() {
  // The saved setting wins; the last choice from the sidebar toggle is the fallback.
  let theme = 'dark';
  try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* default */ }
  let settings = null;
  try { settings = await window.esm.getSettings(); } catch { /* keep the fallback */ }
  if (settings) theme = settings.general.theme;
  applyTheme(theme);
  hydrateIcons(document.querySelector('.bottom-nav'));
  state.route = parseHash();
  if (!location.hash) location.hash = '#/servers';
  await render();
  scheduleRefresh(settings?.general.refreshSeconds ?? DEFAULT_REFRESH_SECONDS);
}

// Live status: re-reads what is on screen at the interval set in Settings, without rebuilding open forms.
const DEFAULT_REFRESH_SECONDS = 120;
let refreshTimer = null;

function refreshScreen() {
  if (state.route.name === 'servers' && !document.querySelector('.modal')) render();
  if (state.route.name === 'detail' && state.route.tab === 'overview' && !document.querySelector('.modal')) render();
  // Keep the probe result on screen; re-rendering the tab would clear it.
  const probeOpen = $('#probe-out')?.style.display === 'block';
  if (state.route.name === 'detail' && state.route.tab === 'players' && !probeOpen && !document.querySelector('.modal')) render();
}

function scheduleRefresh(seconds) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshScreen, seconds * 1000);
}

boot();
