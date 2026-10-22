'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage,
} = require('electron');
const { createServerManager, ApiError } = require('./server-manager');

// Only one copy runs at a time. A second launch brings the open window forward instead.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.exit(0);
app.setAppUserModelId('com.enshrouded.servermanager'); // lets Windows attribute the notifications to this app

// The portable build sets PORTABLE_EXECUTABLE_DIR to the folder holding the .exe, so its data travels with it.
// From source (npm start) data goes to the normal per-user app data folder.
const baseDir = process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('userData');
const dataDir = path.join(baseDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'manager.log');
const log = (message) => {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
};

function showNotification(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// Server events that deserve a desktop notification. Crashes are the only ones for now.
function onServerEvent(event, message) {
  if (!manager.getSettings().general.desktopNotifications) return;
  if (event === 'crash') showNotification('Server stopped unexpectedly', message.replace(/\*\*/g, ''));
}

// The live map ships inside the app (see package.json extraResources). From source it comes from data\livemap-source.
const livemapFolder = app.isPackaged ? path.join(process.resourcesPath, 'livemap-bundle') : '';
const manager = createServerManager({ dataDir, log, onEvent: onServerEvent, livemapFolder });

// Starts the client with Windows. The portable build's real path is the .exe the user double-clicks.
function applyLoginItem() {
  const launchPath = process.env.PORTABLE_EXECUTABLE_FILE || (app.isPackaged ? process.execPath : null);
  if (!launchPath) return;
  const { general } = manager.getSettings();
  app.setLoginItemSettings({
    openAtLogin: general.startWithWindows,
    path: launchPath,
    args: general.startMinimized ? ['--hidden'] : [],
  });
}

// Every renderer call goes through one handler so errors reach the UI as messages.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (!(err instanceof ApiError)) log(`${channel} failed: ${err.stack || err.message}`);
      return { error: err instanceof ApiError ? err.message : (err.message || 'Unexpected error') };
    }
  });
}

handle('servers:list', () => manager.list());
handle('servers:get', (id) => manager.get(id));
handle('servers:addExisting', (body) => manager.addExisting(body.name, body.path));
handle('servers:installNew', (body) => manager.installNew(body));
handle('servers:update', (id) => manager.update(id));
handle('servers:remove', (id) => manager.remove(id));
handle('servers:start', async (id) => { await manager.start(id); return manager.get(id); });
handle('servers:stop', async (id) => { await manager.stop(id); return manager.get(id); });
handle('servers:restart', async (id) => { await manager.restart(id); return manager.get(id); });
handle('servers:setAutoRestart', (id, enabled) => manager.setAutoRestart(id, enabled));
handle('servers:getConfig', (id) => manager.getConfig(id));
handle('servers:saveConfig', (id, cfg) => manager.saveConfig(id, cfg));
handle('servers:logs', (id) => manager.listLogs(id));
handle('servers:readLog', (id, name) => ({ name, content: manager.readLog(id, name) }));
handle('servers:backups', (id) => manager.listBackups(id));
handle('servers:createBackup', (id) => manager.createBackup(id));
handle('servers:restoreBackup', (id, name) => manager.restoreBackup(id, name));
handle('servers:deleteBackup', (id, name) => manager.deleteBackup(id, name));
handle('servers:getPlayers', (id) => manager.getPlayers(id));
handle('servers:probeQuery', (id) => manager.probeQuery(id));
handle('servers:getSchedule', (id) => manager.getSchedule(id));
handle('servers:saveSchedule', (id, body) => manager.saveSchedule(id, body));
handle('servers:checkBuild', (id) => manager.checkBuild(id));
handle('servers:getLivemap', (id) => manager.getLivemap(id));
handle('servers:installLivemap', (id) => manager.installLivemap(id));
handle('settings:get', () => manager.getSettings());
handle('settings:save', (body) => {
  const saved = manager.saveSettings(body);
  applyLoginItem();
  return saved;
});
handle('alerts:test', () => manager.testDiscord());
handle('jobs:get', (id) => manager.getJob(id));
handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Select Enshrouded server folder' });
  return result.canceled ? null : result.filePaths[0];
});
handle('shell:openFolder', (folder) => shell.openPath(folder));

// ---------------------------------------------------------------- window and tray

let mainWindow = null;
let tray = null;
let quitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#161c20',
    title: 'Enshrouded Server Manager',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // With "keep running in tray" on, the close button hides the window. Servers are detached either way.
  mainWindow.on('close', (event) => {
    if (!quitting && manager.getSettings().general.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  quitting = true;
  app.quit();
}

async function runFromTray(action, id) {
  try {
    await manager[action](id);
  } catch (err) {
    showNotification(`Could not ${action} the server`, err.message);
  }
  refreshTray();
}

function buildTrayMenu(servers) {
  const serverItems = servers.length
    ? servers.map((s) => ({
      label: `${s.name}: ${s.running ? `running${s.players != null ? `, ${s.players} online` : ''}` : 'stopped'}`,
      submenu: [
        { label: s.running ? 'Restart' : 'Start', enabled: s.installed, click: () => runFromTray(s.running ? 'restart' : 'start', s.id) },
        { label: 'Stop', enabled: s.running, click: () => runFromTray('stop', s.id) },
      ],
    }))
    : [{ label: 'No servers yet', enabled: false }];
  return Menu.buildFromTemplate([
    { label: 'Show manager', click: showWindow },
    { type: 'separator' },
    ...serverItems,
    { type: 'separator' },
    {
      label: 'Close button keeps running in tray',
      type: 'checkbox',
      checked: manager.getSettings().general.closeToTray,
      click: (item) => {
        manager.setGeneral({ closeToTray: item.checked });
        refreshTray();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: quitApp },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const servers = manager.list();
  const running = servers.filter((s) => s.running).length;
  tray.setToolTip(`Enshrouded Server Manager: ${running} of ${servers.length} running`);
  tray.setContextMenu(buildTrayMenu(servers));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'tray.png')));
  tray.on('click', showWindow);
  refreshTray();
}

app.whenReady().then(() => {
  if (!hasLock) return;
  const startHidden = process.argv.includes('--hidden');
  manager.applyAutoStartSetting();
  applyLoginItem();
  manager.startMonitor();
  createWindow();
  if (startHidden) mainWindow.hide();
  createTray();
  setInterval(refreshTray, 10000);
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
});

// Reached only when the window really closes (close-to-tray is off, or the app is quitting).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
