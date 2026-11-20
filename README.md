# Saveetha Attendance Register (Hosted Web App)

A privately hosted web application for Saveetha Engineering College students (`learner.saveetha.in`) to view consolidated attendance percentages, monitor enrolled subjects, simulate upcoming class attendance, and manage attendance targets on mobile and desktop.

---

## 1. Architecture & Hard Security Guarantees

```
Mobile / Desktop Browser (SPA) 
  ───HTTPS───> Node.js Express Backend 
  ───HTTPS───> learner.saveetha.in & accounts.saveetha.in
```

### Security Compliance:
1. **Server Never Stores Passwords**: The server never stores passwords in files or databases. Passwords are sent over HTTPS, used in memory to negotiate portal session cookies, and immediately discarded. In the browser, credentials can be saved in local storage (via Settings) to enable 1-click automatic background re-authentication.
2. **Ephemeral Memory-Only Sessions**: Portal session cookies (`CookieJar`) live exclusively in server RAM, keyed by a cryptographically random 32-byte (64-character hex) token with a 30-minute idle expiry. The browser holds only an `HttpOnly`, `SameSite=Strict`, `Secure` cookie.
3. **Strict HTTPS & Headers**: Includes `HSTS` (`maxAge: 31536000`, `includeSubDomains`), `X-Content-Type-Options: nosniff`, and a strict `Content-Security-Policy`.
4. **Brute-Force Rate Limiting**: Up to 30 login attempts per 15 minutes per IP address via `express-rate-limit` (successful requests do not consume lockout attempts).
5. **SSRF Guard**: Strict destination hostname allow-list (`learner.saveetha.in` and `accounts.saveetha.in`). Any redirect or request attempting to exit this perimeter is blocked.
6. **No Crawling or Polling**: Synchronizes only the authenticated user's own batch and subject attendance on explicit user sync.
7. **Anti-Bot / Captcha Awareness**: Halts cleanly with `CAPTCHA_REQUIRED` without attempting bypasses if CAPTCHA or OTP challenges appear.
8. **No Third-Party Analytics / Body Logging**: Pure vanilla JS frontend, zero third-party trackers.

---

## 2. Project Structure

```
attendance-tracker/
├── server.js              # Express app, security middleware, rate limiter, routes
├── portalAdapter.js       # Centralized portal logic, URLs, selectors, and API calls
├── parser.js              # Source-of-truth calculation & attendance row parser
├── sessions.js            # In-memory session store (32-byte tokens, 30m idle expiry)
├── public/
│   └── index.html         # Mobile-first vanilla JS UI (Paper & Ink aesthetic)
├── fixtures/              # Sanitized portal HTML snapshots from Saveetha portal
│   ├── login.html
│   ├── calculate-my-attendance.html
│   ├── consolidated-attendance.html
│   └── attendance-table.html
├── test/                  # Offline unit & integration test suites
│   ├── parser.test.js
│   ├── sessions.test.js
│   ├── adapter.test.js
│   └── server.test.js
├── docs/
│   └── portal-notes.md    # Discovered portal endpoints and selectors
├── Dockerfile             # Multi-stage production container (node:20-slim)
├── render.yaml            # Render web service deployment configuration
├── .env.example           # Environment variables template
└── README.md
```

---

## 3. Local Quickstart

### Prerequisites
- Node.js 20+

### Steps
1. Clone the repository and navigate to the project directory:
   ```bash
   cd attendance-tracker
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. (Optional) Configure environment variables:
   ```bash
   cp .env.example .env
   ```
4. Run tests:
   ```bash
   npm test
   ```
5. Start the server:
   ```bash
   npm start
   ```
6. Open your browser at `http://localhost:3000`.

---

## 4. Deployment on Render

This repository includes a `render.yaml` blueprint for one-click deployment:

1. Push this repository to a **private** GitHub repository.
2. In the [Render Dashboard](https://dashboard.render.com), click **New+** -> **Blueprint**.
3. Connect your private repository. Render will automatically detect `render.yaml`.
4. Configure environment variables in the Render dashboard:
   - `ALLOWED_USERNAMES`: (Optional) Comma-separated list of student portal usernames permitted to sign in (e.g. `24006231`).
   - `SESSION_SECRET`: A secure random string.
5. Click **Apply**.

> [!NOTE]
> **Free Instance Sleeping**: On Render's free tier, the web service sleeps after 15 minutes of inactivity. The first request after a sleep period may take 30–50 seconds to spin up.
>
> [!WARNING]
> **Cloud IP Blocking**: Some university portals block IP addresses originating from major cloud data centers (AWS, GCP, Render). If login works locally on your home network but returns `PORTAL_UNAVAILABLE` on Render, deploy to Railway, Fly.io, or run the app on a Raspberry Pi / home server.

---

## 5. API Reference

All responses return JSON. Errors conform to `{ "error": "<message>", "code": "<CODE>" }`.

| Method | Endpoint | Description | Return Payload |
|---|---|---|---|
| `GET` | `/healthz` | Health check probe | `{ "status": "ok", "uptime": 123.4 }` |
| `POST` | `/api/login` | Portal login & session creation | `{ "batches": [{ "value": "3", "label": "2627-UG-ODD-T2-PLT" }] }` |
| `GET` | `/api/overview` | Overall consolidated attendance & subjects | `{ "batch": "3", "consolidated": { "percentage": 80.14 }, "subjects": [...] }` |
| `GET` | `/api/attendance` | Subject sessions and calculation rows | `{ "subject": "26OD2145", "rows": [...] }` |
| `POST` | `/api/logout` | Clears memory session & cookie | `{ "success": true }` |

---

## 6. Verification & Assumptions

### Verified from Portal Fixtures:
- Central authentication uses Django form with CSRF token at `https://accounts.saveetha.in/login/`.
- Academic batch dropdown extracted from `select#ca-selection` and `select#calculate-my-attendance-term`.
- Consolidated overall attendance percentage located at `#ca-percentage`.
- Attendance calculation parsing rules match calculation column weights (`Counts X.XX as <Label>`, `Not counted: Holiday`, `Not counted: <reason>`).

### Assumptions:
- In the portal, academic terms in `/academics/calculate-my-attendance/` (e.g. `26-27-ODD-T2-PLT`) correlate directly with consolidated terms (e.g. `2627-UG-ODD-T2-PLT`). The adapter provides normalized matching across both formats.
- If portal JavaScript dynamic rendering is introduced in the future, the adapter is designed with an interchangeable client interface that can be paired with Playwright.
