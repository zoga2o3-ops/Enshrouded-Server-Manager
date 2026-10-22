'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((res) => {
  if (res && typeof res === 'object' && 'error' in res && Object.keys(res).length === 1) {
    throw new Error(res.error);
  }
  return res;
});

contextBridge.exposeInMainWorld('esm', {
  list: () => call('servers:list'),
  get: (id) => call('servers:get', id),
  addExisting: (body) => call('servers:addExisting', body),
  installNew: (body) => call('servers:installNew', body),
  update: (id) => call('servers:update', id),
  remove: (id) => call('servers:remove', id),
  start: (id) => call('servers:start', id),
  stop: (id) => call('servers:stop', id),
  restart: (id) => call('servers:restart', id),
  setAutoRestart: (id, enabled) => call('servers:setAutoRestart', id, enabled),
  getConfig: (id) => call('servers:getConfig', id),
  saveConfig: (id, config) => call('servers:saveConfig', id, config),
  logs: (id) => call('servers:logs', id),
  readLog: (id, name) => call('servers:readLog', id, name),
  backups: (id) => call('servers:backups', id),
  createBackup: (id) => call('servers:createBackup', id),
  restoreBackup: (id, name) => call('servers:restoreBackup', id, name),
  deleteBackup: (id, name) => call('servers:deleteBackup', id, name),
  getPlayers: (id) => call('servers:getPlayers', id),
  probeQuery: (id) => call('servers:probeQuery', id),
  getSchedule: (id) => call('servers:getSchedule', id),
  saveSchedule: (id, body) => call('servers:saveSchedule', id, body),
  getSettings: () => call('settings:get'),
  saveSettings: (body) => call('settings:save', body),
  testAlerts: () => call('alerts:test'),
  checkBuild: (id) => call('servers:checkBuild', id),
  getLivemap: (id) => call('servers:getLivemap', id),
  installLivemap: (id) => call('servers:installLivemap', id),
  getJob: (id) => call('jobs:get', id),
  pickFolder: () => call('dialog:pickFolder'),
  openFolder: (folder) => call('shell:openFolder', folder),
});
