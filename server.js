const express = require('express');
const path = require('node:path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { z } = require('zod');

const { SessionStore, SESSION_TTL_MS } = require('./sessions');
const {
  login,
  getOverview,
  getAttendance,
  PortalError,
  ERROR_CODES
} = require('./portalAdapter');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_COOKIE_NAME = 'sec_session_token';

// Trust proxy for reverse proxies (Render, Cloudflare, etc.)
app.set('trust proxy', 1);

// Initialize Session Store
const sessionStore = new SessionStore(SESSION_TTL_MS);

// ═══════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true
}));

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Rate limit for login (30 attempts per 15 minutes, skipping successful logins)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Please wait 15 minutes before trying again.',
    code: ERROR_CODES.LOGIN_FAILED
  }
});

// Access Control: Optional ALLOWED_USERNAMES
const allowedUsernames = process.env.ALLOWED_USERNAMES
  ? process.env.ALLOWED_USERNAMES.split(',').map(u => u.trim().toLowerCase()).filter(Boolean)
  : null;

// Validation Schemas
const LoginSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  password: z.string().min(1, 'Password is required')
});

const OverviewQuerySchema = z.object({
  batch: z.string().min(1, 'Batch is required')
});

const AttendanceQuerySchema = z.object({
  batch: z.string().min(1, 'Batch is required'),
  subject: z.string().min(1, 'Subject is required')
});

// Helper for sending structured JSON errors
function sendError(res, status, message, code) {
  return res.status(status).json({
    error: message,
    code: code || ERROR_CODES.PORTAL_UNAVAILABLE
  });
}

// Session Authentication Middleware
function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return sendError(res, 401, 'No active session. Please sign in.', ERROR_CODES.SESSION_EXPIRED);
  }

  const session = sessionStore.getSession(token);
  if (!session) {
    res.clearCookie(SESSION_COOKIE_NAME);
    return sendError(res, 401, 'Session expired. Please sign in again.', ERROR_CODES.SESSION_EXPIRED);
  }

  req.session = session;
  next();
}

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// Health check endpoint
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Login endpoint
app.post('/api/login', loginLimiter, async (req, res) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.issues[0]?.message || 'Invalid request', ERROR_CODES.LOGIN_FAILED);
  }

  const { username, password } = parsed.data;

  // Check optional ALLOWED_USERNAMES whitelist
  if (allowedUsernames && !allowedUsernames.includes(username.toLowerCase())) {
    return sendError(res, 403, 'Username not authorized to access this instance.', ERROR_CODES.LOGIN_FAILED);
  }

  try {
    // Create new in-memory session
    const { token, jar } = sessionStore.createSession(username);

    // Call portal adapter (password is passed once, never stored or logged)
    const result = await login(jar, username, password);

    // Set HttpOnly, Secure, SameSite=Lax cookie
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS
    });

    res.json({ batches: result.batches });
  } catch (err) {
    const code = err instanceof PortalError ? err.code : ERROR_CODES.LOGIN_FAILED;
    const status = (code === ERROR_CODES.PORTAL_UNAVAILABLE) ? 502 : 401;
    sendError(res, status, err.message, code);
  }
});

// Overview endpoint
app.get('/api/overview', requireAuth, async (req, res) => {
  const parsed = OverviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.issues[0]?.message || 'Invalid query parameters', ERROR_CODES.PORTAL_CHANGED);
  }

  try {
    const overview = await getOverview(req.session.jar, parsed.data.batch);
    res.json(overview);
  } catch (err) {
    const code = err instanceof PortalError ? err.code : ERROR_CODES.PORTAL_UNAVAILABLE;
    const status = code === ERROR_CODES.SESSION_EXPIRED ? 401 : (code === ERROR_CODES.BATCH_NOT_FOUND ? 404 : 502);
    sendError(res, status, err.message, code);
  }
});

// Attendance endpoint
app.get('/api/attendance', requireAuth, async (req, res) => {
  const parsed = AttendanceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.issues[0]?.message || 'Invalid query parameters', ERROR_CODES.PORTAL_CHANGED);
  }

  try {
    const attendance = await getAttendance(req.session.jar, parsed.data.batch, parsed.data.subject);
    res.json(attendance);
  } catch (err) {
    const code = err instanceof PortalError ? err.code : ERROR_CODES.PORTAL_UNAVAILABLE;
    const status = code === ERROR_CODES.SESSION_EXPIRED ? 401 : 502;
    sendError(res, status, err.message, code);
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (token) {
    sessionStore.destroySession(token);
  }
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ success: true });
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server if not required as a module
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Attendance Register server running on port ${PORT}`);
  });
}

module.exports = app;
