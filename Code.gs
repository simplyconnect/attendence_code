/**
 * Code.gs — Backend API for the Employee Management & Attendance System.
 * ------------------------------------------------------------
 * Deploy: Deploy > New deployment > type "Web app" > execute as "Me",
 * access "Anyone". Copy the /exec URL into webapp/app.js (API_URL) and
 * into sync-service/config.json (apps_script_url).
 *
 * Every request is a single doGet/doPost with an `action` parameter.
 * POST bodies are sent as Content-Type: text/plain with a JSON string
 * inside — this avoids the CORS pre-flight OPTIONS request, which Apps
 * Script Web Apps cannot answer, so a normal application/json fetch()
 * from a browser on a different origin would otherwise fail silently.
 * ------------------------------------------------------------
 */

const SS = SpreadsheetApp.getActiveSpreadsheet();

function doGet(e) {
  return route_(e.parameter);
}

function doPost(e) {
  let params = {};
  try {
    params = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: 'Invalid request body' });
  }
  return route_(params);
}

function route_(p) {
  try {
    switch (p.action) {
      case 'login': return jsonOut_(login_(p.username, p.password));

      // ---- device -> server ingestion (device API key, not a user session) ----
      case 'receivePunches': return jsonOut_(receivePunches_(p));

      // ---- everything below requires a valid user session token ----
      case 'getEmployees': return jsonOut_(getEmployees_(p, requireAuth_(p)));
      case 'upsertEmployee': requireAuth_(p, 'admin'); return jsonOut_(upsertEmployee_(p.employee));
      case 'getConfig': requireAuth_(p); return jsonOut_(getConfig_());
      case 'updateConfig': requireAuth_(p, 'admin'); return jsonOut_(updateConfig_(p.config));
      case 'getDevices': requireAuth_(p, 'admin'); return jsonOut_(getDevices_());
      case 'upsertDevice': requireAuth_(p, 'admin'); return jsonOut_(upsertDevice_(p.device));
      case 'getSyncLogs': requireAuth_(p, 'admin'); return jsonOut_(getSyncLogs_(p.limit || 100));
      case 'getDailyAttendance': return jsonOut_(getDailyAttendance_(p, requireAuth_(p)));
      case 'getEmployeeHistory': return jsonOut_(getDailyAttendance_(p, requireAuth_(p)));
      case 'recomputeAttendance': requireAuth_(p, 'admin'); recomputeRange(p.days || 3); return jsonOut_({ ok: true });
      case 'getDashboardSummary': requireAuth_(p); return jsonOut_(getDashboardSummary_(p));
      case 'changePassword': { const s = requireAuth_(p); return jsonOut_(changePassword_(s, p.currentPassword, p.newPassword)); }

      // ---- payroll / salary ----
      case 'getPayrollStructure': requireAuth_(p, 'admin'); return jsonOut_(getPayrollStructure_());
      case 'upsertPayrollStructure': requireAuth_(p, 'admin'); return jsonOut_(upsertPayrollStructure_(p.structure));
      case 'generatePayroll': requireAuth_(p, 'admin'); return jsonOut_(generateMonthlyPayroll(p.month));
      case 'getPayslips': return jsonOut_(getPayslips_(p, requireAuth_(p)));
      case 'markPayslipPaid': requireAuth_(p, 'admin'); return jsonOut_(markPayslipPaid_(p));
      default: return jsonOut_({ ok: false, error: 'Unknown action: ' + p.action });
    }
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// AUTH
// ============================================================

function hashPassword_(password, salt) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt);
  return raw.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function login_(username, password) {
  const sheet = SS.getSheetByName('Users');
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const [uname, hash, salt, role, name, empId, active] = rows[i];
    if (uname === username && active) {
      if (hashPassword_(password, salt) === hash) {
        return { ok: true, token: makeToken_(username, role, empId), role, name, empId: empId || '' };
      }
      break;
    }
  }
  return { ok: false, error: 'Invalid username or password' };
}

function makeToken_(username, role, empId) {
  const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  const expiry = Date.now() + 8 * 60 * 60 * 1000; // 8 hour session
  const payload = `${username}|${role}|${empId || ''}|${expiry}`;
  const sig = Utilities.computeHmacSha256Signature(payload, secret)
    .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  return Utilities.base64EncodeWebSafe(`${payload}|${sig}`);
}

function verifyToken_(token) {
  try {
    const secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
    const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    const parts = decoded.split('|');
    const sig = parts.pop();
    const expiry = Number(parts[3]);
    const payload = parts.join('|');
    const expectedSig = Utilities.computeHmacSha256Signature(payload, secret)
      .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
    if (sig !== expectedSig) return null;
    if (Date.now() > expiry) return null;
    return { username: parts[0], role: parts[1], empId: parts[2] };
  } catch (e) {
    return null;
  }
}

function requireAuth_(p, minRole) {
  const session = verifyToken_(p.token);
  if (!session) throw new Error('Not authenticated. Please log in again.');
  if (minRole === 'admin' && session.role !== 'admin') throw new Error('Admin access required.');
  return session;
}

function changePassword_(session, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 4) return { ok: false, error: 'New password must be at least 4 characters.' };
  const sheet = SS.getSheetByName('Users');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === session.username) {
      const currentHash = data[i][1], salt = data[i][2];
      if (hashPassword_(currentPassword, salt) !== currentHash) {
        return { ok: false, error: 'Current password is incorrect.' };
      }
      const newSalt = Utilities.getUuid();
      const newHash = hashPassword_(newPassword, newSalt);
      sheet.getRange(i + 1, 2, 1, 2).setValues([[newHash, newSalt]]);
      return { ok: true };
    }
  }
  return { ok: false, error: 'User not found.' };
}

// ============================================================
// DEVICE INGESTION  (raw punches -> RawPunches, with dedup)
// ============================================================

/**
 * p = { deviceId, apiKey, punches: [{ deviceUserId, empId, timestamp, verifyMode, punchType }] }
 * timestamp must be ISO 8601, e.g. 2026-09-01T09:03:12
 */
function receivePunches_(p) {
  const device = findDevice_(p.deviceId);
  if (!device || device.apiKey !== p.apiKey) {
    return { ok: false, error: 'Unknown device or invalid API key' };
  }
  const punches = p.punches || [];
  const sheet = SS.getSheetByName('RawPunches');

  // Build a dedup index from existing recent rows (last 5 days is plenty —
  // the sync service also tracks its own watermark, this is the second line
  // of defence against double-sends or overlapping polls).
  const existing = sheet.getDataRange().getValues();
  const seen = new Set();
  const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  for (let i = 1; i < existing.length; i++) {
    const [, devId, devUserId, , ts] = existing[i];
    const tsDate = new Date(ts);
    if (tsDate < cutoff) continue;
    seen.add(`${devId}|${devUserId}|${tsDate.getTime()}`);
  }

  let inserted = 0, duplicates = 0;
  const now = new Date();
  const rowsToAppend = [];
  const touchedEmpIds = new Set();

  punches.forEach(pu => {
    const ts = new Date(pu.timestamp);
    const key = `${p.deviceId}|${pu.deviceUserId}|${ts.getTime()}`;
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    const empId = resolveEmpId_(pu.deviceUserId, pu.empId);
    rowsToAppend.push([
      Utilities.getUuid(), p.deviceId, pu.deviceUserId, empId, ts,
      pu.verifyMode || '', pu.punchType || '', now
    ]);
    if (empId) touchedEmpIds.add(empId + '|' + Utilities.formatDate(ts, 'Asia/Karachi', 'yyyy-MM-dd'));
    inserted++;
  });

  if (rowsToAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
  }

  updateDeviceSyncStatus_(p.deviceId, 'OK');
  logSync_(p.deviceId, punches.length, inserted, duplicates, 'OK', '');

  // Recompute attendance immediately for the affected employee-days so the
  // dashboard reflects new punches without waiting for the nightly trigger.
  touchedEmpIds.forEach(key => {
    const [empId, dateStr] = key.split('|');
    recomputeOneDay_(empId, dateStr);
  });

  return { ok: true, inserted, duplicates };
}

function resolveEmpId_(deviceUserId, fallbackEmpId) {
  const sheet = SS.getSheetByName('Employees');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][7]) === String(deviceUserId)) return data[i][0]; // DeviceUserID column
  }
  return fallbackEmpId || deviceUserId; // fall back to raw device ID if unmapped
}

function findDevice_(deviceId) {
  const sheet = SS.getSheetByName('Devices');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(deviceId)) {
      return { deviceId: data[i][0], name: data[i][1], ip: data[i][2], port: data[i][3], apiKey: data[i][6] };
    }
  }
  return null;
}

function updateDeviceSyncStatus_(deviceId, status) {
  const sheet = SS.getSheetByName('Devices');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(deviceId)) {
      sheet.getRange(i + 1, 8).setValue(new Date());   // LastSyncAt
      sheet.getRange(i + 1, 9).setValue(status);        // LastSyncStatus
      return;
    }
  }
}

function logSync_(deviceId, fetched, inserted, duplicates, status, errorMessage) {
  SS.getSheetByName('SyncLog').appendRow([new Date(), deviceId, fetched, inserted, duplicates, status, errorMessage]);
}

// ============================================================
// EMPLOYEES
// ============================================================

function getEmployees_(p, session) {
  const sheet = SS.getSheetByName('Employees');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  let rows = data.slice(1).map(r => rowToObj_(headers, r));

  // A plain "employee" login only ever sees their own record — HR/admin sees everyone.
  if (session.role === 'employee') {
    rows = rows.filter(r => String(r.EmpID) === String(session.empId));
    return { ok: true, employees: rows };
  }

  if (p.department) rows = rows.filter(r => r.Department === p.department);
  if (p.status) rows = rows.filter(r => r.Status === p.status);
  if (p.search) {
    const q = p.search.toLowerCase();
    rows = rows.filter(r => (r.Name + r.EmpID + r.Department).toLowerCase().includes(q));
  }
  return { ok: true, employees: rows };
}

function upsertEmployee_(emp) {
  const sheet = SS.getSheetByName('Employees');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(emp.EmpID)) {
      sheet.getRange(i + 1, 1, 1, 9).setValues([[
        emp.EmpID, emp.Name, emp.Department, emp.Designation, emp.JoiningDate,
        emp.Phone, emp.Email, emp.DeviceUserID, emp.Status
      ]]);
      return { ok: true, updated: true };
    }
  }
  sheet.appendRow([
    emp.EmpID, emp.Name, emp.Department, emp.Designation, emp.JoiningDate,
    emp.Phone, emp.Email, emp.DeviceUserID, emp.Status || 'Active', new Date()
  ]);
  return { ok: true, created: true };
}

// ============================================================
// CONFIG
// ============================================================

function getConfig_() {
  const data = SS.getSheetByName('Config').getDataRange().getValues();
  const cfg = {};
  for (let i = 1; i < data.length; i++) cfg[data[i][0]] = data[i][1];
  return { ok: true, config: cfg };
}

function updateConfig_(newCfg) {
  const sheet = SS.getSheetByName('Config');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    if (newCfg.hasOwnProperty(key)) sheet.getRange(i + 1, 2).setValue(newCfg[key]);
  }
  return { ok: true };
}

// ============================================================
// DEVICES
// ============================================================

function getDevices_() {
  const data = SS.getSheetByName('Devices').getDataRange().getValues();
  const headers = data[0];
  return { ok: true, devices: data.slice(1).map(r => rowToObj_(headers, r)) };
}

function upsertDevice_(dev) {
  const sheet = SS.getSheetByName('Devices');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(dev.DeviceID)) {
      sheet.getRange(i + 1, 2, 1, 5).setValues([[dev.Name, dev.IPAddress, dev.Port, dev.CommKey, dev.Location]]);
      sheet.getRange(i + 1, 10).setValue(dev.Active !== false);
      return { ok: true, updated: true };
    }
  }
  const apiKey = Utilities.getUuid().replace(/-/g, '');
  sheet.appendRow([dev.DeviceID, dev.Name, dev.IPAddress, dev.Port, dev.CommKey || '', dev.Location || '', apiKey, '', 'Never synced', true]);
  return { ok: true, created: true, apiKey };
}

function getSyncLogs_(limit) {
  const data = SS.getSheetByName('SyncLog').getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1).map(r => rowToObj_(headers, r));
  return { ok: true, logs: rows.slice(-limit).reverse() };
}

// ============================================================
// ATTENDANCE READS
// ============================================================

function getDailyAttendance_(p, session) {
  const data = SS.getSheetByName('DailyAttendance').getDataRange().getValues();
  const headers = data[0];
  let rows = data.slice(1).map(r => rowToObj_(headers, r));

  // A plain "employee" login can never pull anyone else's attendance, regardless
  // of what empId they pass — the backend forces it, the frontend filter is just UX.
  const scopedEmpId = session.role === 'employee' ? session.empId : p.empId;
  if (scopedEmpId) rows = rows.filter(r => String(r.EmpID) === String(scopedEmpId));

  if (session.role !== 'employee') {
    if (p.department) rows = rows.filter(r => r.Department === p.department);
    if (p.status) rows = rows.filter(r => r.Status === p.status);
  }
  if (p.dateFrom) rows = rows.filter(r => fmtDate_(r.Date) >= p.dateFrom);
  if (p.dateTo) rows = rows.filter(r => fmtDate_(r.Date) <= p.dateTo);
  rows.forEach(r => { r.Date = fmtDate_(r.Date); });
  return { ok: true, records: rows };
}

function getDashboardSummary_(p) {
  const dateStr = p.date || Utilities.formatDate(new Date(), 'Asia/Karachi', 'yyyy-MM-dd');
  const data = SS.getSheetByName('DailyAttendance').getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1).map(r => rowToObj_(headers, r)).filter(r => fmtDate_(r.Date) === dateStr);
  const counts = { Present: 0, Absent: 0, Late: 0, 'Early Leave': 0, 'Half Day': 0, Leave: 0, Holiday: 0 };
  rows.forEach(r => { if (counts.hasOwnProperty(r.Status)) counts[r.Status]++; });
  const totalEmployees = SS.getSheetByName('Employees').getDataRange().getValues().length - 1;
  return { ok: true, date: dateStr, counts, totalEmployees };
}

// ============================================================
// SHARED HELPERS
// ============================================================

function rowToObj_(headers, row) {
  const obj = {};
  headers.forEach((h, i) => obj[h] = row[i]);
  return obj;
}

function fmtDate_(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return Utilities.formatDate(new Date(d), 'Asia/Karachi', 'yyyy-MM-dd');
}
