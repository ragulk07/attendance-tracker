const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server');

test('GET /healthz returns ok and uptime', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
  } finally {
    server.close();
  }
});

test('POST /api/login fails cleanly on invalid body without crashing', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '' })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.code, 'LOGIN_FAILED');
  } finally {
    server.close();
  }
});

test('Protected routes reject unauthorized requests with SESSION_EXPIRED', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview?batch=3`);
    assert.equal(res.status, 401);
    assert.ok(res.headers.get('cache-control')?.includes('no-store'));
    const body = await res.json();
    assert.equal(body.code, 'SESSION_EXPIRED');

    // /api/sync should also reject unauthorized requests
    const syncRes = await fetch(`http://127.0.0.1:${port}/api/sync?batch=3`);
    assert.equal(syncRes.status, 401);
    const syncBody = await syncRes.json();
    assert.equal(syncBody.code, 'SESSION_EXPIRED');
  } finally {
    server.close();
  }
});

test('GET /api/sync returns 400 when batch parameter is missing', async () => {
  const server = app.listen(0);
  const port = server.address().port;

  try {
    // Create valid session
    const { token } = app.sessionStore.createSession('testuser');
    const res = await fetch(`http://127.0.0.1:${port}/api/sync`, {
      headers: {
        'Cookie': `${app.SESSION_COOKIE_NAME}=${token}`
      }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('Batch is required') || body.error.includes('Required'));
  } finally {
    server.close();
  }
});
