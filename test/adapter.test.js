const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CookieJar } = require('tough-cookie');

const {
  assertAllowedUrl,
  extractCsrfToken,
  hasCaptchaOrOtp,
  parseBatchesFromHtml,
  parseConsolidatedFromHtml,
  login,
  getOverview,
  getAttendance,
  ERROR_CODES,
  PortalError
} = require('../portalAdapter');

const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'login.html'), 'utf8');
const calculateHtml = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'calculate-my-attendance.html'), 'utf8');
const consolidatedHtml = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'consolidated-attendance.html'), 'utf8');
const attendanceTableHtml = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'attendance-table.html'), 'utf8');

test('assertAllowedUrl allows only learner.saveetha.in and accounts.saveetha.in', () => {
  assert.equal(
    assertAllowedUrl('https://learner.saveetha.in/academics/'),
    'https://learner.saveetha.in/academics/'
  );
  assert.equal(
    assertAllowedUrl('https://accounts.saveetha.in/login/'),
    'https://accounts.saveetha.in/login/'
  );
  assert.throws(() => {
    assertAllowedUrl('https://evil-site.com/steal-data');
  }, /Blocked disallowed destination host/);
});

test('extractCsrfToken parses csrfmiddlewaretoken from login fixture', () => {
  const token = extractCsrfToken(loginHtml);
  assert.equal(token, 'B4JHJIU9swMu3mZ45xC9MJn6vHALUCxhVHfz4TV19wjvGHdcPDkH21rRM7LeM667');
});

test('hasCaptchaOrOtp detects captchas/otps correctly', () => {
  assert.equal(hasCaptchaOrOtp(loginHtml), false);
  const captchaSnippet = '<div><input name="otp" type="text"></div>';
  assert.equal(hasCaptchaOrOtp(captchaSnippet), true);
});

test('parseBatchesFromHtml extracts batches accurately from fixture', () => {
  const batches = parseBatchesFromHtml(consolidatedHtml);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], { value: '2', label: '2627-UG-ODD-T2' });
  assert.deepEqual(batches[1], { value: '3', label: '2627-UG-ODD-T2-PLT' });

  // From calculate-my-attendance
  const termBatches = parseBatchesFromHtml(calculateHtml);
  assert.ok(termBatches.length >= 8);
  assert.equal(termBatches[0].value, '16');
  assert.equal(termBatches[0].label, '26-27-ODD-T2-PLT');
});

test('parseConsolidatedFromHtml extracts overall percentage and enrolled subjects', () => {
  const result = parseConsolidatedFromHtml(consolidatedHtml);
  assert.equal(result.consolidated.percentage, 80.14);
  assert.equal(result.subjects.length, 5);

  assert.equal(result.subjects[0].id, '26OD2145');
  assert.equal(result.subjects[0].name, 'Blockchain for Business (26OD2145)');
  assert.equal(result.subjects[0].percentage, 82.35); // 28/34 * 100

  assert.equal(result.subjects[3].id, '26OD2138');
  assert.equal(result.subjects[3].name, 'Advanced Java Web Applications (26OD2138)');
  assert.equal(result.subjects[3].percentage, 87.5); // 28/32 * 100
});

test('login flow handles success, failure, and captcha offline with mock axios', async () => {
  const jar = new CookieJar();

  // Mock axios instance for successful login
  const mockAxiosSuccess = {
    get: async (url) => {
      if (url.includes('login')) return { data: loginHtml };
      if (url.includes('view-consolidated')) return { data: consolidatedHtml };
      return { data: '' };
    },
    post: async () => {
      // successful login redirects or returns 200 without error
      return { data: '<html><body>Welcome</body></html>' };
    }
  };

  const res = await login(jar, '24006231', 'dummyPass', mockAxiosSuccess);
  assert.ok(res.batches);
  assert.equal(res.batches.length, 2);
  assert.equal(res.batches[1].label, '2627-UG-ODD-T2-PLT');

  // Mock login failure (invalid credentials)
  const mockAxiosFail = {
    get: async () => ({ data: loginHtml }),
    post: async () => ({
      data: '<html><body class="auth-body"><div class="alert-danger">Invalid credentials</div></body></html>'
    })
  };

  await assert.rejects(
    async () => login(jar, '24006231', 'wrong', mockAxiosFail),
    (err) => err instanceof PortalError && err.code === ERROR_CODES.LOGIN_FAILED
  );

  // Mock captcha triggered
  const mockAxiosCaptcha = {
    get: async () => ({
      data: '<html><body><input name="otp" type="text"></body></html>'
    }),
    post: async () => ({ data: '' })
  };

  await assert.rejects(
    async () => login(jar, '24006231', 'pass', mockAxiosCaptcha),
    (err) => err instanceof PortalError && err.code === ERROR_CODES.CAPTCHA_REQUIRED
  );
});

test('getOverview and getAttendance succeed offline with mock responses', async () => {
  const jar = new CookieJar();

  const mockAxios = {
    get: async (url) => {
      if (url.includes('view-consolidated')) return { data: consolidatedHtml };
      if (url.includes('calculate-my-attendance')) return { data: attendanceTableHtml };
      return { data: '' };
    }
  };

  const overview = await getOverview(jar, '3', mockAxios);
  assert.equal(overview.batch, '3');
  assert.equal(overview.consolidated.percentage, 80.14);
  assert.equal(overview.subjects.length, 5);

  const attendance = await getAttendance(jar, '3', '26OD2145', mockAxios);
  assert.equal(attendance.subject, '26OD2145');
  assert.equal(attendance.rows.length, 7);
  assert.equal(attendance.rows[0].status, 'PRESENT');
});
