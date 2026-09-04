# Employee Management & Attendance System
### ZKTeco K40 → Windows Sync Service → Google Sheets → Apps Script → Web Dashboard

Free/open-source stack. No paid HR software, no paid SDK licence required.

```
 ZKTeco K40  --TCP/4370-->  Windows PC (Python sync service, pyzk)
                                   |
                                   |  HTTPS POST (JSON)
                                   v
                     Google Apps Script Web App  <-->  Google Sheet (database)
                                   ^
                                   |  HTTPS GET/POST (fetch)
                                   |
                          Browser dashboard (HTML/CSS/JS)
```

The K40 never talks to Google directly. The Windows PC is the only thing that talks
to the device, and the only thing that talks to Apps Script on the device's behalf.

---

## 1. How the K40 actually communicates (read this before anything else)

- The K40 exposes a **proprietary TCP protocol on port 4370** over your LAN. There is
  no public official protocol spec from ZKTeco.
- **Official route:** ZKTeco's `zkemkeeper.dll` ("Standalone SDK", COM/ActiveX,
  Windows-only, 32-bit). It's free to use but distributed inconsistently through
  resellers, not a clean public download — not a reliable foundation for a
  from-scratch open build.
- **What this project actually uses:** [`pyzk`](https://pypi.org/project/pyzk/) — a
  free, open-source (MIT) Python library implementing the same reverse-engineered
  protocol the K40/K50/K60/iClock family speaks. It is the de-facto standard behind
  almost every free/open ZK attendance project that exists, and it's what the sync
  service in this repo uses. No ZKTeco software required on the PC.
- **Fallback if `pyzk` ever can't talk to your specific firmware:** ZKTeco's own
  bundled attendance software (or a USB export) can dump punches to CSV. Drop that
  CSV into `sync-service/import/` and the same sync service will read it, dedup it,
  and push it through the identical pipeline. See `zk_sync_service.py` →
  `pull_from_csv_fallback()`.
- **Port 4370 is fixed** on this device family — you don't configure it on the K40,
  you just need to know it when you configure `config.json` and the firewall.

---

## 2. Google Sheet structure

Create one new Google Sheet, then run the setup script (§9) to build these tabs:

| Sheet | Purpose | Key columns |
|---|---|---|
| **Employees** | Master employee list | EmpID, Name, Department, Designation, JoiningDate, Phone, Email, **DeviceUserID** (the numeric ID enrolled on the K40 — this is what maps a fingerprint punch to a person), Status |
| **RawPunches** | Every biometric transaction, untouched | PunchID, DeviceID, DeviceUserID, EmpID, Timestamp, VerifyMode, PunchType, ReceivedAt |
| **DailyAttendance** | Calculated, one row per employee per day | Date, EmpID, PunchIn, PunchOut, WorkingHours, OvertimeHours, Status, Remarks |
| **Devices** | Registered biometric machines | DeviceID, Name, IPAddress, Port, CommKey, ApiKey, LastSyncAt, LastSyncStatus, Active |
| **SyncLog** | Every sync attempt | Timestamp, DeviceID, RecordsFetched, RecordsInserted, DuplicatesSkipped, Status, ErrorMessage |
| **Config** | Office timings and rules, editable from Settings page | OfficeStartTime, OfficeEndTime, GracePeriodMinutes, LunchBreakMinutes, StandardWorkHours, HalfDayThresholdHours, WorkingDays, etc. |
| **Holidays** | Company holidays | Date, Description |
| **Leaves** | Approved leave | EmpID, Date, LeaveType, Status |
| **Users** | Dashboard login accounts | Username, PasswordHash, Salt, Role (`admin`/`employee`), Name, **EmpID** (links a login to its Employees row) |
| **Payroll** | Salary structure, one row per employee | EmpID, BasicSalary, HouseAllowance, TransportAllowance, MedicalAllowance, OtherAllowance, EffectiveDate |
| **Payslips** | Generated payroll, one row per employee per month | Month, EmpID, BasicSalary, TotalAllowances, GrossEarnings, PresentDays, AbsentDays, HalfDays, OvertimeHours, OvertimePay, TotalDeductions, NetSalary, Status (Draft/Paid) |

Raw punches and calculated attendance are deliberately separate sheets — raw data is
never overwritten, so you can always re-run the calculation engine (e.g. after
changing office timings) without losing the original punch history.

Adding a second, third, etc. K40 (or any device) later is just another row in
**Devices** with a fresh DeviceID and API key — nothing else in the schema changes.

---

## 3. Duplicate prevention

Two independent layers, so a duplicate can't get through even if one fails:

1. **Sync service watermark** (`state.json` on the Windows PC): tracks the timestamp
   of the newest punch already sent, per device. Every poll only looks at punches
   newer than that watermark.
2. **Server-side dedup** (`Code.gs` → `receivePunches_`): before inserting, it
   builds a set of `deviceId|deviceUserId|timestamp` keys from the last 5 days of
   `RawPunches` and skips anything already present. This catches re-sends caused by
   a crashed sync service, overlapping manual runs, or a CSV re-import.

---

## 4. Automatic Punch In / Punch Out + attendance calculation

For each employee, each day: all raw punches for that employee+date are pulled and
sorted chronologically. **First punch = Punch In, last punch = Punch Out.** Every
raw punch in between is preserved in `RawPunches` untouched — only `DailyAttendance`
collapses them.

Status rules (`AttendanceEngine.gs`), all driven by the **Config** sheet so HR can
tune them from the Settings page without touching code:

- **Holiday** — date is in the Holidays sheet (or falls outside `WorkingDays`) and no punches exist.
- **Leave** — an `Approved` row exists in Leaves for that employee/date.
- **Absent** — a working day, no leave, no holiday, zero punches.
- **Half Day** — working hours (Punch Out − Punch In, minus the configured lunch break) fall below `HalfDayThresholdHours`.
- **Late** — Punch In is later than `OfficeStartTime + GracePeriodMinutes`.
- **Early Leave** — Punch Out is earlier than `OfficeEndTime − EarlyLeaveGraceMinutes`.
- **Present** — none of the above trip.
- **Overtime** — hours worked beyond `StandardWorkHours`, only counted once Punch Out passes `OfficeEndTime + OvertimeGraceMinutes`.
- A single punch with no matching Punch Out is marked Present with a "Missing punch-out" remark rather than silently dropped.

Recalculation is **idempotent** — it always overwrites the existing row for that
EmpID+Date rather than appending, so it's always safe to re-run. It fires
automatically right after every sync (for just the affected employee-days) and again
every night for a trailing 3-day window, so a late or out-of-order sync still
self-heals.

---

## 4b. Payroll & salary

`PayrollEngine.gs` turns a month of `DailyAttendance` plus each employee's salary
structure (`Payroll` sheet) into one `Payslips` row per employee per month:

- **Daily rate** = `BasicSalary / WorkingDaysPerMonth` (Config, default 26).
- **Overtime pay** = `OvertimeHours × hourly rate × OvertimePayMultiplier` (Config, default 1.5×), pulled straight from the same `OvertimeHours` the attendance engine already calculated.
- **Absent deduction** = `AbsentDays × daily rate`. **Half Day deduction** = `HalfDays × daily rate × HalfDayDeductionFactor` (default 0.5). Approved Leave days are never deducted.
- **Net salary** = Basic + Allowances + Overtime pay − Deductions.

All of the above are tunable from the **Config** sheet — nothing is hardcoded.
Regenerating a month is idempotent (overwrites that EmpID+Month row), so it's safe
to re-run after correcting attendance or fixing a salary structure. Admins set each
employee's Basic/House/Transport/Medical/Other allowance from the Payroll page's
**"Manage salary structures"** panel, then click **"Generate payroll for month"**.
Each payslip shows a full earnings/deductions breakdown and can be marked **Paid**.

This is intentionally a straight-line formula, not a full payroll/tax engine — swap
in your own formulas in `generateMonthlyPayroll()` if you need tax slabs, EOBI,
provident fund, or other statutory deductions specific to your country.

---

## 4c. Every employee gets their own login — HR/admin sees everyone

With 150 employees, one shared login doesn't work — each person needs to see only
their own record, while HR sees the full company. This is enforced on the
**backend**, not just hidden in the UI, so an employee account can never pull
someone else's data no matter what they send the API.

**One-time setup, after your 150 employees are in the `Employees` sheet:**
1. In the Apps Script editor, select `provisionEmployeeLogins` and click **Run**.
2. It creates a login for every `Active` employee that doesn't already have one:
   - **Username** = their Employee ID
   - **Password** = their Employee ID + the last 4 digits of the phone number on file (just the Employee ID if no phone is on file)
   - **Role** = `employee`
3. Re-run it any time you add new employees — it skips anyone who already has a login.

**What an `employee` login sees:** their own Dashboard (their attendance this
month, their overtime, their net salary — not company-wide numbers), clicking
"My Profile" goes straight to their own profile (Overview/Attendance/Payroll
tabs), and a **"My Account"** page to set their own password. They cannot browse
other employees, see Devices, Sync log, Settings, or generate/edit payroll —
those stay admin-only both in the UI and in the API itself.

**What an `admin` (HR) login sees:** everything — the full Employees directory,
company-wide dashboard, every attendance record, payroll generation and salary
structures, device setup, sync logs, settings.

The default password scheme above is a starting point, not a secure long-term
one — point every employee at **My Account** to set their own password on first
login. If you want something stronger before rollout (e.g. emailing each person
a random one-time password instead), that's a small change to
`provisionEmployeeLogins()` in `SetupSheets.gs`.

---

## 5. Deployment — step by step

### A. Google Sheet + Apps Script backend
1. Create a new Google Sheet at sheets.google.com.
2. Extensions → Apps Script. Delete the default `Code.gs` content.
3. Create three script files matching this repo: `SetupSheets.gs`, `Code.gs`,
   `AttendanceEngine.gs` — paste each file's contents in.
4. In the Apps Script editor, select `setupDatabase` from the function dropdown and
   click **Run**. Approve the permissions prompt. This builds every tab and creates
   the default login (`admin` / `admin123`).
5. Select `installNightlyTrigger` and click **Run** once — this schedules the
   trailing-window recompute at 1am daily.
6. Deploy → **New deployment** → type **Web app** → Execute as **Me** → Who has
   access **Anyone**. Click Deploy and copy the `/exec` URL.

### B. Web dashboard — publish it live on GitHub Pages (free)
1. In `webapp/app.js`, replace `API_URL` with the `/exec` URL from step A6.
2. Create a new **public** GitHub repository (e.g. `attendance-dashboard`).
3. From inside the `webapp/` folder on your computer, run:
   ```
   git init
   git add .
   git commit -m "Attendance dashboard"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/attendance-dashboard.git
   git push -u origin main
   ```
4. On GitHub: **Settings → Pages** → under "Build and deployment", set **Source: Deploy from a branch**, **Branch: main**, folder **/(root)** → **Save**.
5. GitHub gives you a live URL within a minute or two, typically:
   `https://YOUR-USERNAME.github.io/attendance-dashboard/`
6. Open that URL, log in with `admin` / `admin123`, and change the password
   immediately (see the note in step A4).

That's the whole "go live" step — `webapp/` is 3 static files (`index.html`,
`style.css`, `app.js`) plus `logo.png`, no build step, no server to run or pay for.
Every time you edit a file locally, `git add . && git commit -m "update" && git push`
updates the live site within a minute.

### C. Register the K40 in the dashboard
1. Log in as admin → **Devices** → **Add device**.
2. Enter a DeviceID (e.g. `K40-MAIN`), the K40's static IP, port `4370`.
3. Save — the dashboard shows a generated **API key once**. Copy it now.

### D. K40 device-side network setup
On the K40 itself: **Menu → COMM → Ethernet** → set a static **IP Address**, **Subnet
Mask**, **Gateway** on your office LAN (static IP is important — if it changes after
a router reboot, the sync service loses the device until you update `config.json`).
Port is fixed at 4370, nothing to set there. If you set a Comm Key/password on the
device, note it for `config.json`.

### E. Windows sync service
1. Install **Python 3.10+** (free) on any always-on office PC on the same LAN as the K40.
2. Copy the `sync-service/` folder to that PC.
3. Open a command prompt in that folder:
   ```
   pip install -r requirements.txt
   ```
4. Edit `config.json`:
   - `device_id` — must match the DeviceID you created in step C.
   - `device_ip` / `device_port` — the K40's static IP and 4370.
   - `apps_script_url` — the `/exec` URL from step A6.
   - `api_key` — the key copied in step C.
5. Test it once:
   ```
   python zk_sync_service.py --once
   ```
   Check `sync_service.log` for `Synced OK`. Check the dashboard's **Sync log** page.
6. Run it continuously. Two free options:
   - **Simplest — Windows Task Scheduler:** create a task that runs
     `python zk_sync_service.py --once` every 5 minutes. No extra software.
   - **Always-on service — NSSM** (free, open-source): `nssm install ZKSyncService`,
     point it at `python.exe` with argument `zk_sync_service.py` (no `--once`, it
     loops internally on `sync_interval_seconds`), set working directory to the
     `sync-service` folder, start the service.

### F. Firewall
Allow outbound TCP 4370 from the sync PC to the K40's IP, and outbound HTTPS (443)
from the sync PC to `script.google.com`. No inbound ports need to be opened anywhere
— the sync PC only makes outbound connections.

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Sync service can't connect to the device | Check the K40's IP hasn't changed (use a static IP/DHCP reservation). Confirm you can `ping` the IP from the sync PC. Confirm nothing else (like ZKTeco's own software) has an open connection to the device — most ZK terminals only accept one connection at a time. |
| Connects but `get_attendance()` returns nothing new | The device only stores a finite number of logs and may already be near capacity — set the device to auto-clear older synced logs, or manually clear once you've confirmed a full sync, so it doesn't fill up. |
| `pyzk` raises a timeout on a specific firmware | Increase `timeout_seconds` in `config.json`. If it never connects, use the CSV fallback (§1) — export from the bundled ZKTeco software or via USB into `sync-service/import/`. |
| Dashboard shows "Not authenticated" | Session tokens expire after 8 hours — log in again. If it happens immediately after login, confirm `SESSION_SECRET` exists in Apps Script → Project Settings → Script Properties (created by `setupDatabase`). |
| POST requests fail from the browser but GET works | Confirm `app.js` is sending POST with `Content-Type: text/plain` — `application/json` triggers a CORS preflight (OPTIONS) that Apps Script Web Apps don't answer, and the request will fail silently. |
| New employee shows no punches | Their `DeviceUserID` in the Employees sheet must exactly match the numeric ID they were enrolled under on the K40 — check the K40's own user list. |
| Attendance status looks wrong after changing office timings | Update the Settings page, then go to Devices (admin) and trigger `recomputeAttendance`, or just wait for the nightly 1am job — it reprocesses the trailing 3 days. Older dates need `recomputeRange(N)` run manually from the Apps Script editor with a bigger `N`. |
| Duplicate rows appear in RawPunches | Should not happen given the two dedup layers (§3) — if it does, check that every device has a distinct DeviceID (two devices sharing one DeviceID will look like duplicate timestamps from "the same" device). |
| Sheet getting slow with 150+ employees over time | Google Sheets comfortably handles low hundreds of thousands of rows; if RawPunches grows very large after a year+, archive rows older than e.g. 12 months to a separate "RawPunches_Archive" sheet — DailyAttendance already holds the calculated summary permanently. |

---

## 7. Repo layout

```
apps-script/
  SetupSheets.gs        one-time DB builder — run once
  Code.gs                API: auth, employees, devices, sync ingestion, reads
  AttendanceEngine.gs    punch → daily status/hours/overtime calculation
sync-service/
  zk_sync_service.py     Windows sync service (pyzk + CSV fallback)
  config.json             device IP/port, Apps Script URL, API key
  requirements.txt
webapp/
  index.html
  style.css
  app.js                  API_URL goes here
```

## 8. Cost

Google Sheets + Apps Script: free (Google account quotas comfortably cover 150
employees × a few hundred punches/day). `pyzk`, Python, NSSM: free/open-source.
Static hosting on GitHub Pages: free. The only thing you're already paying for is
the K40 hardware you already own.
