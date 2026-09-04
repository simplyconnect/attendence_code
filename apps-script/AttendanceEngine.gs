/**
 * AttendanceEngine.gs
 * ------------------------------------------------------------
 * Turns raw punches into one DailyAttendance row per employee per day.
 * Runs automatically:
 *   - immediately after each sync (recomputeOneDay_, called from Code.gs)
 *   - nightly for a trailing window, to self-heal late/out-of-order syncs
 * Recomputation is idempotent — it always overwrites the existing row for
 * that EmpID + Date rather than appending, so re-running is always safe.
 * ------------------------------------------------------------
 */

/** Install once from the script editor: Run > installNightlyTrigger */
function installNightlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'nightlyRecompute') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightlyRecompute').timeBased().everyDays(1).atHour(1).create();
}

function nightlyRecompute() {
  recomputeRange(3); // trailing 3 days, covers late syncs across midnight
}

function recomputeRange(days) {
  const tz = 'Asia/Karachi';
  const employees = getActiveEmployees_();
  for (let d = 0; d < days; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
    employees.forEach(emp => recomputeOneDay_(emp.EmpID, dateStr, emp));
  }
}

function recomputeOneDay_(empId, dateStr, empRow) {
  const tz = 'Asia/Karachi';
  const cfg = getConfigMap_();
  const emp = empRow || getEmployeeById_(empId);
  if (!emp) return;

  const punches = getPunchesForDay_(empId, dateStr);
  const holiday = isHoliday_(dateStr);
  const onLeave = isOnLeave_(empId, dateStr);
  const isWorkingDay = isWorkingDay_(dateStr, cfg);

  let status, punchIn = '', punchOut = '', workingHours = 0, overtimeHours = 0, remarks = '';

  if (punches.length === 0) {
    if (holiday) status = 'Holiday';
    else if (onLeave) status = 'Leave';
    else if (!isWorkingDay) status = 'Holiday';
    else status = 'Absent';
  } else {
    punches.sort((a, b) => a - b);
    const inTime = punches[0];
    const outTime = punches[punches.length - 1];
    punchIn = Utilities.formatDate(inTime, tz, 'HH:mm:ss');
    punchOut = punches.length > 1 ? Utilities.formatDate(outTime, tz, 'HH:mm:ss') : '';

    if (holiday) {
      status = 'Present';
      remarks = 'Worked on a holiday';
    } else {
      const officeStart = parseTimeOnDate_(dateStr, cfg.OfficeStartTime, tz);
      const officeEnd = parseTimeOnDate_(dateStr, cfg.OfficeEndTime, tz);
      const grace = Number(cfg.GracePeriodMinutes || 0) * 60000;
      const earlyGrace = Number(cfg.EarlyLeaveGraceMinutes || 0) * 60000;
      const otGrace = Number(cfg.OvertimeGraceMinutes || 0) * 60000;
      const lunchMinutes = Number(cfg.LunchBreakMinutes || 0);
      const halfDayThreshold = Number(cfg.HalfDayThresholdHours || 4);
      const standardHours = Number(cfg.StandardWorkHours || 8);

      const isLate = inTime.getTime() > (officeStart.getTime() + grace);
      const rawMinutes = punches.length > 1 ? (outTime - inTime) / 60000 : 0;
      workingHours = Math.max(0, (rawMinutes - lunchMinutes) / 60);
      const isEarlyLeave = punches.length > 1 && outTime.getTime() < (officeEnd.getTime() - earlyGrace);

      if (punches.length === 1) {
        status = 'Present';
        remarks = 'Missing punch-out — only one punch recorded';
      } else if (workingHours < halfDayThreshold) {
        status = 'Half Day';
      } else if (isLate && isEarlyLeave) {
        status = 'Late';
        remarks = 'Also left early';
      } else if (isLate) {
        status = 'Late';
      } else if (isEarlyLeave) {
        status = 'Early Leave';
      } else {
        status = 'Present';
      }

      if (punches.length > 1 && outTime.getTime() > (officeEnd.getTime() + otGrace)) {
        overtimeHours = Math.max(0, workingHours - standardHours);
      }
    }
  }

  upsertDailyAttendanceRow_(dateStr, emp, punchIn, punchOut, workingHours, overtimeHours, status, remarks);
}

function upsertDailyAttendanceRow_(dateStr, emp, punchIn, punchOut, workingHours, overtimeHours, status, remarks) {
  const sheet = SS.getSheetByName('DailyAttendance');
  const data = sheet.getDataRange().getValues();
  const row = [dateStr, emp.EmpID, emp.Name, emp.Department, punchIn, punchOut,
    Number(workingHours.toFixed(2)), Number(overtimeHours.toFixed(2)), status, remarks, new Date()];

  for (let i = 1; i < data.length; i++) {
    if (fmtDate_(data[i][0]) === dateStr && String(data[i][1]) === String(emp.EmpID)) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

// ---------- lookups ----------

function getActiveEmployees_() {
  const data = SS.getSheetByName('Employees').getDataRange().getValues();
  const headers = data[0];
  return data.slice(1).map(r => rowToObj_(headers, r)).filter(e => e.Status === 'Active');
}

function getEmployeeById_(empId) {
  const data = SS.getSheetByName('Employees').getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(empId)) return rowToObj_(headers, data[i]);
  }
  return null;
}

function getPunchesForDay_(empId, dateStr) {
  const data = SS.getSheetByName('RawPunches').getDataRange().getValues();
  const result = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][3]) !== String(empId)) continue;
    const ts = new Date(data[i][4]);
    if (fmtDate_(ts) === dateStr) result.push(ts);
  }
  return result;
}

function isHoliday_(dateStr) {
  const data = SS.getSheetByName('Holidays').getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (fmtDate_(data[i][0]) === dateStr) return true;
  }
  return false;
}

function isOnLeave_(empId, dateStr) {
  const data = SS.getSheetByName('Leaves').getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(empId) && fmtDate_(data[i][1]) === dateStr && data[i][4] === 'Approved') return true;
  }
  return false;
}

function isWorkingDay_(dateStr, cfg) {
  const workingDays = (cfg.WorkingDays || 'Mon,Tue,Wed,Thu,Fri,Sat').split(',').map(d => d.trim());
  const dayName = Utilities.formatDate(new Date(dateStr + 'T00:00:00'), 'Asia/Karachi', 'EEE');
  return workingDays.includes(dayName);
}

function getConfigMap_() {
  return getConfig_().config;
}

function parseTimeOnDate_(dateStr, hhmm, tz) {
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(h, m, 0, 0);
  return d;
}
