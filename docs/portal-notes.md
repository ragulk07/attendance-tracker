# Portal Discovery Notes: Saveetha Portal

These findings are derived directly from the sanitized portal HTML fixtures in `fixtures/`.

## 1. Authentication (Login)
- **Login URL**: `https://accounts.saveetha.in/login/` (and redirects to/from `https://learner.saveetha.in`)
- **Form Method**: `POST`
- **CSRF Token**: Hidden input `<input type="hidden" name="csrfmiddlewaretoken" value="...">`
- **Field Names**:
  - Username: `name="username"`, `id="id_username"`
  - Password: `name="password"`, `id="id_password"`
- **Submit Button**: `button[type="submit"]`
- **Captcha / OTP**: No captcha or OTP element is present in standard flow. If captcha/OTP appears, adapter must raise `CAPTCHA_REQUIRED`.
- **Success / Failure**:
  - Success: Session cookies set (`sessionid`, `csrftoken`), redirect to `learner.saveetha.in`.
  - Failure: Status code 200 with error alerts (`.alert-danger`, `.errorlist`, or staying on `/login/`).

## 2. Batch Dropdown
- **Consolidated Attendance Dropdown**:
  - Selector: `select#ca-selection[name="consolidated_attendance_id"]`
  - Examples:
    - `<option value="2">2627-UG-ODD-T2</option>`
    - `<option value="3">2627-UG-ODD-T2-PLT</option>`
- **Calculate My Attendance Term Dropdown**:
  - Selector: `select#calculate-my-attendance-term[name="term_id"]`
  - Examples:
    - `<option value="16">26-27-ODD-T2-PLT</option>`
    - `<option value="14">26-27-ODD-T2</option>`
- Matching: A batch label (e.g. `2627-UG-ODD-T2-PLT` or `26-27-ODD-T2-PLT`) links the consolidated batch ID with the academic term ID.

## 3. Subject List & Attendance Calculation
- **Endpoint for Enrolled Subject Slots**:
  - `/academics/calculate-my-attendance/slots/?term_id=<term_id>`
  - Request headers: `X-Requested-With: XMLHttpRequest`
  - Response JSON: `{ results: [ { id: string | number, label: string } ] }`
- **Attendance Calculation Request**:
  - Endpoint: `/academics/calculate-my-attendance/?term_id=<term_id>&slot_id=<slot_id>&action=calculate`
  - Response: Server-rendered HTML containing the Attendance Details table (`table`).
  - Rows are parsed by `parser.js`.

## 4. Consolidated Attendance Page (`/academics/view-consolidated-attendance/`)
- **Form**:
  - Selector: `#ca-personal-form`
  - Parameter: `consolidated_attendance_id=<id>`
  - Endpoint: `/academics/view-consolidated-attendance/data/?consolidated_attendance_id=<id>` or GET/POST to page.
- **Overall Attendance Percentage Selector**:
  - `#ca-percentage` (e.g. `<h2 id="ca-percentage">80.14%</h2>`)
- **Subject Sources Table**:
  - Found under `table.table` (columns: `Slot / Subject`, `Present weight`, `Scheduled weight`).
  - Contains subject code, subject title, and calculated percentages.
