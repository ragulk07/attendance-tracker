const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const { parseAttendanceRows } = require('./parser');

// ═══════════════════════════════════════════════════════════════════
// NAMED CONSTANTS: URLs, Selectors, and Fields
// ═══════════════════════════════════════════════════════════════════
const ALLOWED_HOSTS = ['learner.saveetha.in', 'accounts.saveetha.in'];

const URLS = {
  LEARNER_BASE: 'https://learner.saveetha.in',
  ACCOUNTS_BASE: 'https://accounts.saveetha.in',
  LOGIN: 'https://accounts.saveetha.in/login/',
  VIEW_CONSOLIDATED: 'https://learner.saveetha.in/academics/view-consolidated-attendance/',
  CONSOLIDATED_DATA: 'https://learner.saveetha.in/academics/view-consolidated-attendance/data/',
  CALCULATE_ATTENDANCE: 'https://learner.saveetha.in/academics/calculate-my-attendance/',
  SLOTS_API: 'https://learner.saveetha.in/academics/calculate-my-attendance/slots/'
};

const SELECTORS = {
  CSRF_TOKEN: 'input[name="csrfmiddlewaretoken"]',
  USERNAME_FIELD: 'username',
  PASSWORD_FIELD: 'password',
  CAPTCHA_CONTAINER: '#captcha, .g-recaptcha, .h-captcha, input[name="otp"], [name*="captcha"]',
  ERROR_BOX: '.alert-danger, .errorlist, .alert-warning',
  CONSOLIDATED_SELECT: 'select#ca-selection',
  CONSOLIDATED_PERCENTAGE: '#ca-percentage',
  CONSOLIDATED_TABLE_ROWS: 'table.table tbody tr',
  CALCULATE_TERM_SELECT: 'select#calculate-my-attendance-term',
  CALCULATE_SLOT_SELECT: 'select#calculate-my-attendance-slot'
};

const ERROR_CODES = {
  LOGIN_FAILED: 'LOGIN_FAILED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  BATCH_NOT_FOUND: 'BATCH_NOT_FOUND',
  PORTAL_CHANGED: 'PORTAL_CHANGED',
  PORTAL_UNAVAILABLE: 'PORTAL_UNAVAILABLE'
};

class PortalError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PortalError';
    this.code = code || ERROR_CODES.PORTAL_UNAVAILABLE;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SECURITY & SSRF SAFEGUARDS
// ═══════════════════════════════════════════════════════════════════
function assertAllowedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl, URLS.LEARNER_BASE);
  } catch {
    throw new PortalError('Invalid portal URL', ERROR_CODES.PORTAL_CHANGED);
  }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new PortalError(`Blocked disallowed destination host: ${parsed.hostname}`, ERROR_CODES.PORTAL_CHANGED);
  }
  return parsed.toString();
}

function createClient(jar, customAxiosInstance = null) {
  if (customAxiosInstance) {
    return customAxiosInstance;
  }

  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8'
    }
  }));

  // Intercept requests to enforce SSRF allow-list
  client.interceptors.request.use((config) => {
    if (config.url) {
      assertAllowedUrl(config.url);
    }
    return config;
  });

  return client;
}

// ═══════════════════════════════════════════════════════════════════
// OFFLINE PARSING HELPERS (Also tested against fixtures)
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract CSRF token from page HTML
 */
function extractCsrfToken(html) {
  const $ = cheerio.load(html);
  const token = $(SELECTORS.CSRF_TOKEN).val();
  return token || '';
}

/**
 * Detect captcha or OTP in HTML
 */
function hasCaptchaOrOtp(html) {
  const $ = cheerio.load(html);
  return $(SELECTORS.CAPTCHA_CONTAINER).length > 0;
}

/**
 * Parse batches from consolidated attendance page HTML
 */
function parseBatchesFromHtml(html) {
  const $ = cheerio.load(html);
  const batches = [];
  const select = $(SELECTORS.CONSOLIDATED_SELECT);

  if (select.length === 0) {
    // Check if calculate-my-attendance-term is present
    const termSelect = $(SELECTORS.CALCULATE_TERM_SELECT);
    if (termSelect.length > 0) {
      termSelect.find('option').each((_, el) => {
        const val = $(el).val()?.trim();
        const text = $(el).text()?.trim();
        if (val) {
          batches.push({ value: val, label: text || val });
        }
      });
      return batches;
    }
    throw new PortalError('Could not find batch selection options on portal', ERROR_CODES.PORTAL_CHANGED);
  }

  select.find('option').each((_, el) => {
    const val = $(el).val()?.trim();
    const text = $(el).text()?.trim();
    if (val) {
      batches.push({ value: val, label: text || val });
    }
  });

  return batches;
}

/**
 * Parse consolidated attendance percentage & subjects list from consolidated page HTML
 */
function parseConsolidatedFromHtml(html) {
  const $ = cheerio.load(html);
  const pctText = $(SELECTORS.CONSOLIDATED_PERCENTAGE).text().trim();
  const pctMatch = pctText.match(/([\d.]+)%/);
  const percentage = pctMatch ? parseFloat(pctMatch[1]) : 0;

  const subjects = [];
  $(SELECTORS.CONSOLIDATED_TABLE_ROWS).each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 7) return;

    // Slot / Subject cell has code and title
    const subjectCell = $(cells[2]);
    const code = subjectCell.find('.fw-semibold').text().trim();
    const title = subjectCell.find('.small.text-muted').text().trim();
    const name = title ? `${title} (${code})` : code || subjectCell.text().trim();

    const presentWeight = parseFloat($(cells[5]).text().trim()) || 0;
    const scheduledWeight = parseFloat($(cells[6]).text().trim()) || 0;
    const subjPct = scheduledWeight > 0 ? (presentWeight / scheduledWeight) * 100 : 0;

    if (code || name) {
      subjects.push({
        id: code,
        name,
        percentage: Math.round(subjPct * 100) / 100
      });
    }
  });

  return {
    consolidated: { percentage },
    subjects
  };
}

// ═══════════════════════════════════════════════════════════════════
// PORTAL ADAPTER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Log into Saveetha portal and retrieve available batches
 * @param {CookieJar} jar 
 * @param {string} username 
 * @param {string} password 
 * @param {object} [customAxios] optional mock client for offline tests
 * @returns {Promise<{ batches: Array<{ value: string, label: string }> }>}
 */
async function login(jar, username, password, customAxios = null) {
  const client = createClient(jar, customAxios);

  // 1. Fetch login page to get initial cookies and CSRF token
  let loginPageRes;
  try {
    loginPageRes = await client.get(URLS.LOGIN);
  } catch (err) {
    throw new PortalError(`Cannot reach portal: ${err.message}`, ERROR_CODES.PORTAL_UNAVAILABLE);
  }

  if (hasCaptchaOrOtp(loginPageRes.data)) {
    throw new PortalError('Portal requires CAPTCHA or OTP verification', ERROR_CODES.CAPTCHA_REQUIRED);
  }

  const csrfToken = extractCsrfToken(loginPageRes.data);

  // 2. Perform POST login
  const params = new URLSearchParams();
  params.append('csrfmiddlewaretoken', csrfToken);
  params.append(SELECTORS.USERNAME_FIELD, username);
  params.append(SELECTORS.PASSWORD_FIELD, password);

  let postRes;
  try {
    postRes = await client.post(URLS.LOGIN, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': URLS.LOGIN
      }
    });
  } catch (err) {
    throw new PortalError(`Login request failed: ${err.message}`, ERROR_CODES.PORTAL_UNAVAILABLE);
  }

  // Check if response redirected or rendered login page with errors
  const resHtml = typeof postRes.data === 'string' ? postRes.data : '';
  if (hasCaptchaOrOtp(resHtml)) {
    throw new PortalError('Portal requires CAPTCHA or OTP verification', ERROR_CODES.CAPTCHA_REQUIRED);
  }

  const $ = cheerio.load(resHtml);
  if ($(SELECTORS.ERROR_BOX).length > 0 || $(SELECTORS.CSRF_TOKEN).length > 0 && $('input[name="password"]').length > 0) {
    const errorMsg = $(SELECTORS.ERROR_BOX).text().trim() || 'Invalid username or password.';
    throw new PortalError(errorMsg, ERROR_CODES.LOGIN_FAILED);
  }

  // 3. Navigate to consolidated attendance page to load batch list
  let consolidatedRes;
  try {
    consolidatedRes = await client.get(URLS.VIEW_CONSOLIDATED);
  } catch (err) {
    throw new PortalError(`Failed to load consolidated attendance page: ${err.message}`, ERROR_CODES.PORTAL_UNAVAILABLE);
  }

  const batches = parseBatchesFromHtml(consolidatedRes.data);
  return { batches };
}

/**
 * Fetch overview (consolidated attendance and subjects) for a chosen batch
 * @param {CookieJar} jar 
 * @param {string} batchValue 
 * @param {object} [customAxios] 
 * @returns {Promise<{ batch: string, consolidated: { percentage: number }, subjects: Array<{ id: string, name: string, percentage: number }> }>}
 */
async function getOverview(jar, batchValue, customAxios = null) {
  if (!batchValue) {
    throw new PortalError('Batch parameter is required', ERROR_CODES.BATCH_NOT_FOUND);
  }

  const client = createClient(jar, customAxios);

  let res;
  try {
    // Request consolidated data with chosen batch ID
    res = await client.get(URLS.VIEW_CONSOLIDATED, {
      params: { consolidated_attendance_id: batchValue }
    });
  } catch (err) {
    throw new PortalError(`Failed to fetch overview: ${err.message}`, ERROR_CODES.PORTAL_UNAVAILABLE);
  }

  if (typeof res.data === 'string' && (res.data.includes('Sign in') || res.data.includes('id_password'))) {
    throw new PortalError('Session expired. Please sign in again.', ERROR_CODES.SESSION_EXPIRED);
  }

  const { consolidated, subjects } = parseConsolidatedFromHtml(res.data);
  return {
    batch: batchValue,
    consolidated,
    subjects
  };
}

/**
 * Fetch detailed attendance rows for a specific subject
 * @param {CookieJar} jar 
 * @param {string} batchValue 
 * @param {string} subjectId 
 * @param {object} [customAxios] 
 * @returns {Promise<{ subject: string, rows: Array<object> }>}
 */
async function getAttendance(jar, batchValue, subjectId, customAxios = null) {
  if (!batchValue) throw new PortalError('Batch parameter is required', ERROR_CODES.BATCH_NOT_FOUND);
  if (!subjectId) throw new PortalError('Subject parameter is required', ERROR_CODES.PORTAL_CHANGED);

  const client = createClient(jar, customAxios);

  let res;
  try {
    res = await client.get(URLS.CALCULATE_ATTENDANCE, {
      params: {
        term_id: batchValue,
        slot_id: subjectId,
        action: 'calculate'
      }
    });
  } catch (err) {
    throw new PortalError(`Failed to fetch subject attendance: ${err.message}`, ERROR_CODES.PORTAL_UNAVAILABLE);
  }

  if (typeof res.data === 'string' && (res.data.includes('Sign in') || res.data.includes('id_password'))) {
    throw new PortalError('Session expired. Please sign in again.', ERROR_CODES.SESSION_EXPIRED);
  }

  const rows = parseAttendanceRows(res.data);
  return {
    subject: subjectId,
    rows
  };
}

module.exports = {
  URLS,
  SELECTORS,
  ERROR_CODES,
  PortalError,
  assertAllowedUrl,
  extractCsrfToken,
  hasCaptchaOrOtp,
  parseBatchesFromHtml,
  parseConsolidatedFromHtml,
  login,
  getOverview,
  getAttendance
};
