'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, defaultConfig, SERVER_TAGS } = require('../electron/server-manager');

test('the game tag list has the 19 known tags', () => {
  assert.equal(SERVER_TAGS.length, 19);
  assert.ok(SERVER_TAGS.includes('Roleplay'));
});

test('known tags pass validation', () => {
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig('A'), tags: ['English', 'Roleplay', 'LookingForPlayers'] }));
});

test('custom tags are refused with the tag named in the message', () => {
  assert.throws(() => validateConfig({ ...defaultConfig('A'), tags: ['My clan'] }),
    (e) => e.status === 400 && /My clan/.test(e.message));
});
