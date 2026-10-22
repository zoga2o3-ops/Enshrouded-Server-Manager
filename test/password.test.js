'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyJoinPassword } = require('../electron/server-manager');

test('the Password field sets the blank join group and leaves Admin alone', () => {
  const cfg = {
    password: 'merk123',
    userGroups: [{ name: 'Admin', password: 'ChangeMeAdmin' }, { name: 'Friends', password: '' }],
  };
  applyJoinPassword(cfg);
  assert.equal(cfg.userGroups[1].password, 'merk123');
  assert.equal(cfg.userGroups[0].password, 'ChangeMeAdmin');
  cfg.password = '';
  applyJoinPassword(cfg);
  assert.equal(cfg.userGroups[1].password, '', 'clearing the password makes the join public again');
});
