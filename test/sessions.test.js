const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../sessions');

test('SessionStore generates 32-byte (64 hex char) random tokens', () => {
  const store = new SessionStore();
  const token = store.generateToken();
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('SessionStore creates, retrieves, refreshes, and destroys sessions', () => {
  const store = new SessionStore(1000); // 1 second TTL for test
  const { token, jar } = store.createSession('testuser');

  assert.ok(token);
  assert.ok(jar);
  assert.equal(store.size(), 1);

  const session = store.getSession(token);
  assert.ok(session);
  assert.equal(session.username, 'testuser');

  store.destroySession(token);
  assert.equal(store.getSession(token), null);
  assert.equal(store.size(), 0);
});

test('SessionStore expires sessions after idle period', async () => {
  const store = new SessionStore(50); // 50ms TTL
  const { token } = store.createSession('user1');

  assert.ok(store.getSession(token));

  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(store.getSession(token), null);
  assert.equal(store.size(), 0);
});
