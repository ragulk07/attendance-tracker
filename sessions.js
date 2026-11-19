const crypto = require('node:crypto');
const { CookieJar } = require('tough-cookie');

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle expiry

class SessionStore {
  constructor(ttlMs = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
    this.sessions = new Map(); // token -> { jar, lastActive, username }
  }

  /**
   * Generate a random 32-byte token (hex encoded, 64 chars)
   */
  generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Create or replace a session
   * @param {string} username 
   * @returns {{ token: string, jar: CookieJar }}
   */
  createSession(username) {
    this.cleanup();
    const token = this.generateToken();
    const jar = new CookieJar();
    this.sessions.set(token, {
      token,
      username,
      jar,
      lastActive: Date.now()
    });
    return { token, jar };
  }

  /**
   * Get an active session and refresh idle timer
   * @param {string} token 
   * @returns {{ token: string, jar: CookieJar, username: string } | null}
   */
  getSession(token) {
    if (!token || typeof token !== 'string') return null;
    const session = this.sessions.get(token);
    if (!session) return null;

    const now = Date.now();
    if (now - session.lastActive > this.ttlMs) {
      this.sessions.delete(token);
      return null;
    }

    // Refresh idle expiry
    session.lastActive = now;
    return session;
  }

  /**
   * Destroy a session
   * @param {string} token 
   */
  destroySession(token) {
    if (token) {
      this.sessions.delete(token);
    }
  }

  /**
   * Clean up expired sessions
   */
  cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions.entries()) {
      if (now - session.lastActive > this.ttlMs) {
        this.sessions.delete(token);
      }
    }
  }

  /**
   * Count active sessions
   */
  size() {
    this.cleanup();
    return this.sessions.size;
  }
}

module.exports = {
  SessionStore,
  SESSION_TTL_MS
};
