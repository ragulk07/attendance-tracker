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

// Global cache for term <-> consolidated batch mapping
const batchMap = new Map();

function normalizeBatchLabel(label) {
  return String(label || '')
    .toUpperCase()
    .replace(/UG|PG/g, '')
    .replace(/[^0-9A-Z]/g, '');
}

function recordBatchMapping(consolidatedId, termId, label) {
  const mapping = { consolidatedId: String(consolidatedId), termId: String(termId), label };
  if (consolidatedId) batchMap.set(String(consolidatedId), mapping);
  if (termId) batchMap.set(String(termId), mapping);
  const norm = normalizeBatchLabel(label);
  if (norm) batchMap.set(norm, mapping);
}

// Pre-populate known mappings for Saveetha batches and terms
const mappingT2 = { consolidatedId: '2', termId: '14', label: '2627-UG-ODD-T2' };
const mappingPLT = { consolidatedId: '3', termId: '16', label: '2627-UG-ODD-T2-PLT' };

batchMap.set('2', mappingT2);
batchMap.set('14', mappingT2);
batchMap.set('2627ODDT2', mappingT2);
batchMap.set('2627ODD', mappingT2);
batchMap.set('3', mappingPLT);
batchMap.set('16', mappingPLT);
batchMap.set('2627ODDT2PLT', mappingPLT);

function resolveBatch(batchValue) {
  const valStr = String(batchValue || '').trim();
  if (batchMap.has(valStr)) {
    return batchMap.get(valStr);
  }
  const norm = normalizeBatchLabel(valStr);
  if (batchMap.has(norm)) {
    return batchMap.get(norm);
  }
  // Smart heuristic for Saveetha terms
  if (valStr.includes('PLT') || norm.includes('PLT') || valStr === '3' || valStr === '16') {
    return mappingPLT;
  }
  if (valStr === '2' || valStr === '14' || norm.includes('2627ODDT2') || norm.includes('2627ODD')) {
    return mappingT2;
  }
  return { consolidatedId: valStr, termId: valStr, label: valStr };
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
// OFFLINE PARSING HELPERS
// ═══════════════════════════════════════════════════════════════════

function extractCsrfToken(html) {
  const $ = cheerio.load(html);
  const token = $(SELECTORS.CSRF_TOKEN).val();
  return token || '';
}

function hasCaptchaOrOtp(html) {
  const $ = cheerio.load(html);
  return $(SELECTORS.CAPTCHA_CONTAINER).length > 0;
}

function parseBatchesFromHtml(html) {
  const $ = cheerio.load(html);
  const batches = [];
  const select = $(SELECTORS.CONSOLIDATED_SELECT);

  if (select.length > 0) {
    select.find('option').each((_, el) => {
      const val = $(el).val()?.trim();
      const text = $(el).text()?.trim();
      if (val) {
        batches.push({ value: val, label: text || val });
      }
    });
    return batches;
  }

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

function parseConsolidatedFromHtml(html) {
  if (!html || typeof html !== 'string') {
    return { consolidated: { percentage: 0 }, subjects: [] };
  }
  const $ = cheerio.load(html);
  const pctEl = $(SELECTORS.CONSOLIDATED_PERCENTAGE).length > 0
    ? $(SELECTORS.CONSOLIDATED_PERCENTAGE)
    : $('.ca-percentage');
  const pctText = pctEl.text().trim();
  const pctMatch = pctText.match(/([\d.]+)%?/);
  let percentage = pctMatch ? parseFloat(pctMatch[1]) : 0;

  const subjects = [];
  let totalPresent = 0;
  let totalScheduled = 0;

  $(SELECTORS.CONSOLIDATED_TABLE_ROWS).each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 7) return;

    const subjectCell = $(cells[2]);
    const code = subjectCell.find('.fw-semibold').text().trim();
    const title = subjectCell.find('.small.text-muted').text().trim();
    const name = title ? `${title} (${code})` : code || subjectCell.text().trim();

    const presentWeight = parseFloat($(cells[5]).text().trim()) || 0;
    const scheduledWeight = parseFloat($(cells[6]).text().trim()) || 0;
    const subjPct = scheduledWeight > 0 ? (presentWeight / scheduledWeight) * 100 : 0;

    totalPresent += presentWeight;
    totalScheduled += scheduledWeight;

    if (code || name) {
      subjects.push({
        id: code,
        name,
        percentage: Math.round(subjPct * 100) / 100
      });
    }
  });

  // If consolidated percentage is missing from HTML header but present in the sources table
  if (percentage === 0 && totalScheduled > 0) {
    percentage = Math.round((totalPresent / totalScheduled) * 10000) / 100;
  }

  return {
    consolidated: { percentage },
    subjects
  };
}

// ═══════════════════════════════════════════════════════════════════
// PORTAL ADAPTER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════

async function login(jar, username, password, customAxios = null) {
  const client = createClient(jar, customAxios);

  // 1. Fetch login page for CSRF
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

  // 2. Submit credentials
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

  const resHtml = typeof postRes.data === 'string' ? postRes.data : '';
  if (hasCaptchaOrOtp(resHtml)) {
    throw new PortalError('Portal requires CAPTCHA or OTP verification', ERROR_CODES.CAPTCHA_REQUIRED);
  }

  const $ = cheerio.load(resHtml);
  if ($(SELECTORS.ERROR_BOX).length > 0 || ($(SELECTORS.CSRF_TOKEN).length > 0 && $('input[name="password"]').length > 0)) {
    const errorMsg = $(SELECTORS.ERROR_BOX).text().trim() || 'Invalid username or password.';
    throw new PortalError(errorMsg, ERROR_CODES.LOGIN_FAILED);
  }

  // 3. Retrieve batches from view-consolidated-attendance
  let consolidatedBatches = [];
  try {
    const conRes = await client.get(URLS.VIEW_CONSOLIDATED);
    consolidatedBatches = parseBatchesFromHtml(conRes.data);
  } catch (err) {
    // Continue to fallback
  }

  // 4. Retrieve terms from calculate-my-attendance
  let calculateTerms = [];
  try {
    const calcRes = await client.get(URLS.CALCULATE_ATTENDANCE);
    const $calc = cheerio.load(calcRes.data);
    $calc(SELECTORS.CALCULATE_TERM_SELECT).find('option').each((_, el) => {
      const v = $calc(el).val()?.trim();
      const t = $calc(el).text()?.trim();
      if (v) calculateTerms.push({ value: v, label: t || v });
    });
  } catch (err) {
    // Continue
  }

  // Correlate consolidated batches with calculate terms
  consolidatedBatches.forEach(cb => {
    const norm = normalizeBatchLabel(cb.label);
    const matchingTerm = calculateTerms.find(ct => normalizeBatchLabel(ct.label) === norm);
    recordBatchMapping(cb.value, matchingTerm ? matchingTerm.value : cb.value, cb.label);
  });

  calculateTerms.forEach(ct => {
    const norm = normalizeBatchLabel(ct.label);
    const matchingCon = consolidatedBatches.find(cb => normalizeBatchLabel(cb.label) === norm);
    if (!batchMap.has(ct.value)) {
      recordBatchMapping(matchingCon ? matchingCon.value : ct.value, ct.value, ct.label);
    }
  });

  const batches = consolidatedBatches.length > 0 ? consolidatedBatches : calculateTerms;
  if (batches.length === 0) {
    throw new PortalError('No academic batches found on your account', ERROR_CODES.BATCH_NOT_FOUND);
  }

  return { batches };
}

async function getOverview(jar, batchValue, customAxios = null) {
  if (!batchValue) {
    throw new PortalError('Batch parameter is required', ERROR_CODES.BATCH_NOT_FOUND);
  }

  const client = createClient(jar, customAxios);
  const resolved = resolveBatch(batchValue);
  const conId = resolved.consolidatedId || batchValue;
  const termId = resolved.termId || batchValue;

  let consolidatedHtml = '';

  // 1. Fetch live data from /academics/view-consolidated-attendance/data/
  try {
    const dataRes = await client.get(URLS.CONSOLIDATED_DATA, {
      params: { consolidated_attendance_id: conId },
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Referer': URLS.VIEW_CONSOLIDATED
      }
    });

    if (typeof dataRes.data === 'string') {
      consolidatedHtml = dataRes.data;
    } else if (typeof dataRes.data === 'object' && dataRes.data !== null) {
      if (typeof dataRes.data.percentage === 'number') {
        consolidatedHtml = `<h2 id="ca-percentage">${dataRes.data.percentage}%</h2>`;
      } else {
        consolidatedHtml = dataRes.data.html || dataRes.data.content || JSON.stringify(dataRes.data);
      }
    }
  } catch (err) {
    // Attempt POST to data endpoint if GET was rejected
    try {
      const postRes = await client.post(URLS.CONSOLIDATED_DATA, `consolidated_attendance_id=${encodeURIComponent(conId)}`, {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': URLS.VIEW_CONSOLIDATED
        }
      });
      if (typeof postRes.data === 'string') {
        consolidatedHtml = postRes.data;
      } else if (typeof postRes.data === 'object' && postRes.data !== null) {
        if (typeof postRes.data.percentage === 'number') {
          consolidatedHtml = `<h2 id="ca-percentage">${postRes.data.percentage}%</h2>`;
        } else {
          consolidatedHtml = postRes.data.html || postRes.data.content || JSON.stringify(postRes.data);
        }
      }
    } catch (e2) {}
  }

  // 2. If data endpoint didn't provide HTML with ca-percentage, fetch main page
  if (!consolidatedHtml || !consolidatedHtml.includes('ca-percentage')) {
    try {
      const pageRes = await client.get(URLS.VIEW_CONSOLIDATED, {
        params: { consolidated_attendance_id: conId }
      });
      if (typeof pageRes.data === 'string') {
        consolidatedHtml = pageRes.data;
      }
    } catch (e) {}
  }

  if (consolidatedHtml.includes('Sign in') && consolidatedHtml.includes('id_password')) {
    throw new PortalError('Session expired. Please sign in again.', ERROR_CODES.SESSION_EXPIRED);
  }

  let { consolidated, subjects } = parseConsolidatedFromHtml(consolidatedHtml);

  // 3. Fetch enrolled subject slots from /academics/calculate-my-attendance/slots/
  try {
    let slotItems = [];
    let effectiveTerm = termId;
    if (effectiveTerm === '2') effectiveTerm = '14';
    if (effectiveTerm === '3') effectiveTerm = '16';

    const slotsRes = await client.get(URLS.SLOTS_API, {
      params: { term_id: effectiveTerm },
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*',
        'Referer': URLS.CALCULATE_ATTENDANCE
      }
    });

    slotItems = Array.isArray(slotsRes.data?.results) ? slotsRes.data.results : [];
    if (slotItems.length > 0) {
      slotCache.set(effectiveTerm, slotItems);
    }

    // Fallback: If slots returned empty and effectiveTerm was not 14, try 14 or 16
    if (slotItems.length === 0 && effectiveTerm !== '14' && effectiveTerm !== '16') {
      for (const fallbackTerm of ['14', '16']) {
        try {
          const fbRes = await client.get(URLS.SLOTS_API, {
            params: { term_id: fallbackTerm },
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              'Accept': 'application/json, text/javascript, */*',
              'Referer': URLS.CALCULATE_ATTENDANCE
            }
          });
          const fbItems = Array.isArray(fbRes.data?.results) ? fbRes.data.results : [];
          if (fbItems.length > 0) {
            slotItems = fbItems;
            recordBatchMapping(batchValue, fallbackTerm, fallbackTerm);
            break;
          }
        } catch (e) {}
      }
    }

    if (slotItems.length > 0) {
      const merged = slotItems.map(item => {
        const idStr = String(item.id);
        const label = String(item.label || '');
        const matching = subjects.find(s => label.includes(s.id) || s.name.toLowerCase().includes(label.toLowerCase()));
        return {
          id: idStr,
          name: label,
          percentage: matching ? matching.percentage : 0
        };
      });
      subjects = merged;
    }
  } catch (e) {
    // Fall back to subjects from consolidated sources table
  }

  return {
    batch: batchValue,
    consolidated,
    subjects
  };
}

const slotCache = new Map();

async function resolveSlotId(client, termId, subjectId) {
  const subjStr = String(subjectId || '').trim();
  if (/^\d+$/.test(subjStr)) return subjStr;

  let slots = slotCache.get(termId);
  if (!slots || !slots.length) {
    try {
      const res = await client.get(URLS.SLOTS_API, {
        params: { term_id: termId },
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*',
          'Referer': URLS.CALCULATE_ATTENDANCE
        }
      });
      slots = Array.isArray(res.data?.results) ? res.data.results : [];
      if (slots.length) slotCache.set(termId, slots);
    } catch (e) {}
  }

  if (slots && slots.length) {
    const norm = subjStr.toLowerCase();
    const match = slots.find(s => {
      const lbl = String(s.label || '').toLowerCase();
      return lbl.includes(norm) || norm.includes(String(s.id)) || norm.includes(lbl);
    });
    if (match) return String(match.id);
  }

  return subjStr;
}

async function getAttendance(jar, batchValue, subjectId, customAxios = null) {
  if (!batchValue) throw new PortalError('Batch parameter is required', ERROR_CODES.BATCH_NOT_FOUND);
  if (!subjectId) throw new PortalError('Subject parameter is required', ERROR_CODES.PORTAL_CHANGED);

  const client = createClient(jar, customAxios);
  const resolved = resolveBatch(batchValue);
  let termId = resolved.termId || batchValue;
  if (termId === '2') termId = '14';
  if (termId === '3') termId = '16';

  const effectiveSlotId = await resolveSlotId(client, termId, subjectId);

  let res;
  try {
    res = await client.get(URLS.CALCULATE_ATTENDANCE, {
      params: {
        term_id: termId,
        slot_id: effectiveSlotId,
        action: 'calculate'
      }
    });
  } catch (err) {
    throw new PortalError(`Failed to fetch subject attendance: ${err.message}`, ERROR_CODES.PORTAL_UNAVAILABLE);
  }

  if (typeof res.data === 'string' && res.data.includes('Sign in') && res.data.includes('id_password')) {
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
  normalizeBatchLabel,
  recordBatchMapping,
  resolveBatch,
  login,
  getOverview,
  getAttendance
};
