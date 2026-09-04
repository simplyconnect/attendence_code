/**
 * SetupSheets.gs
 * ------------------------------------------------------------
 * Run ONCE (select `setupDatabase` in the Apps Script editor and click Run)
 * against a brand-new Google Sheet. It builds every tab, header row,
 * data validation, and a default admin login.
 *
 * After running, go to Extensions > Apps Script > Project Settings and
 * copy the Script ID — you'll need it when deploying the Web App.
 * ------------------------------------------------------------
 */

function setupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  buildSheet_(ss, 'Employees', [
    'EmpID', 'Name', 'Department', 'Designation', 'JoiningDate',
    'Phone', 'Email', 'DeviceUserID', 'Status', 'CreatedAt'
  ]);

  buildSheet_(ss, 'RawPunches', [
    'PunchID', 'DeviceID', 'DeviceUserID', 'EmpID', 'Timestamp',
    'VerifyMode', 'PunchType', 'ReceivedAt'
  ]);

  buildSheet_(ss, 'DailyAttendance', [
    'Date', 'EmpID', 'Name', 'Department', 'PunchIn', 'PunchOut',
    'WorkingHours', 'OvertimeHours', 'Status', 'Remarks', 'ComputedAt'
  ]);

  buildSheet_(ss, 'Devices', [
    'DeviceID', 'Name', 'IPAddress', 'Port', 'CommKey', 'Location',
    'ApiKey', 'LastSyncAt', 'LastSyncStatus', 'Active'
  ]);

  buildSheet_(ss, 'SyncLog', [
    'Timestamp', 'DeviceID', 'RecordsFetched', 'RecordsInserted',
    'DuplicatesSkipped', 'Status', 'ErrorMessage'
  ]);

  buildSheet_(ss, 'Config', ['Key', 'Value', 'Description']);
  const cfg = ss.getSheetByName('Config');
  cfg.getRange(2, 1, 14, 3).setValues([
    ['OfficeStartTime', '09:00', 'HH:mm, 24-hour'],
    ['OfficeEndTime', '18:00', 'HH:mm, 24-hour'],
    ['GracePeriodMinutes', '15', 'Minutes after start before marked Late'],
    ['EarlyLeaveGraceMinutes', '15', 'Minutes before end still counted on-time'],
    ['LunchBreakMinutes', '60', 'Subtracted from working hours'],
    ['StandardWorkHours', '8', 'Hours per day before overtime accrues'],
    ['HalfDayThresholdHours', '4', 'Below this = Half Day'],
    ['OvertimeGraceMinutes', '15', 'Minutes past end before overtime counts'],
    ['WorkingDays', 'Mon,Tue,Wed,Thu,Fri,Sat', 'Comma separated'],
    ['CompanyName', 'Your Company', 'Shown on the dashboard'],
    ['TimeZone', 'Asia/Karachi', 'Used for all date/time math'],
    ['OvertimePayMultiplier', '1.5', 'x hourly rate, applied to OvertimeHours'],
    ['WorkingDaysPerMonth', '26', 'Used to derive the daily rate from BasicSalary'],
    ['HalfDayDeductionFactor', '0.5', 'Fraction of a day\'s pay deducted per Half Day']
  ]);

  buildSheet_(ss, 'Holidays', ['Date', 'Description']);
  buildSheet_(ss, 'Leaves', ['EmpID', 'Date', 'LeaveType', 'ApprovedBy', 'Status']);

  // Salary structure — one row per employee, editable from the Payroll page.
  // Effective-dated so a raise doesn't rewrite payroll history.
  buildSheet_(ss, 'Payroll', [
    'EmpID', 'BasicSalary', 'HouseAllowance', 'TransportAllowance', 'MedicalAllowance',
    'OtherAllowance', 'EffectiveDate', 'UpdatedAt'
  ]);

  // Generated payslips — one row per employee per month. Regeneration overwrites
  // the row for that EmpID+Month, same idempotent pattern as DailyAttendance.
  buildSheet_(ss, 'Payslips', [
    'Month', 'EmpID', 'Name', 'Department', 'BasicSalary', 'TotalAllowances', 'GrossEarnings',
    'PresentDays', 'AbsentDays', 'HalfDays', 'LeaveDays', 'OvertimeHours', 'OvertimePay',
    'AbsentDeduction', 'HalfDayDeduction', 'TotalDeductions', 'NetSalary', 'Status', 'GeneratedAt'
  ]);

  buildSheet_(ss, 'Users', ['Username', 'PasswordHash', 'Salt', 'Role', 'Name', 'EmpID', 'Active']);
  const usersSheet = ss.getSheetByName('Users');
  if (usersSheet.getLastRow() < 2) {
    const salt = Utilities.getUuid();
    const hash = hashPassword_('admin123', salt);
    usersSheet.appendRow(['admin', hash, salt, 'admin', 'Administrator', '', true]);
  }

  // Script property used to sign session tokens — generate once, keep secret.
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SESSION_SECRET')) {
    props.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  SpreadsheetApp.getUi().alert(
    'Setup complete.\n\nDefault login — username: admin / password: admin123\n' +
    'Change this password immediately after your first login.\n\n' +
    'Next: add a row in the Devices sheet for your K40 and generate an ApiKey for it ' +
    '(run generateDeviceApiKey from the script editor, or use the Device Config page in the dashboard).'
  );
}

function buildSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#F4B400');
  sheet.autoResizeColumns(1, headers.length);
}

/** Utility: generate and print a fresh API key for a device row, run manually. */
function generateDeviceApiKey() {
  Logger.log(Utilities.getUuid().replace(/-/g, ''));
}

/**
 * Bulk-creates a login for every Active employee that doesn't already have one.
 * Run this once after loading your 150 employees into the Employees sheet, and
 * again any time you add new employees. Existing logins are never touched, so
 * it's always safe to re-run.
 *
 * Default login for each employee:
 *   Username = their EmpID
 *   Password = their EmpID + the last 4 digits of their phone number on file
 *              (falls back to just the EmpID if no phone number is set)
 * This is a starting point, not a secure long-term scheme — each employee should
 * change their password the first time they log in, using the "My Account" page
 * on the dashboard (Code.gs → changePassword_).
 */
function provisionEmployeeLogins() {
  const empSheet = SS.getSheetByName('Employees');
  const usersSheet = SS.getSheetByName('Users');
  const empData = empSheet.getDataRange().getValues();
  const empHeaders = empData[0];
  const existingUsers = usersSheet.getDataRange().getValues();
  const existingUsernames = new Set(existingUsers.slice(1).map(r => String(r[0])));

  let created = 0;
  const rowsToAdd = [];

  for (let i = 1; i < empData.length; i++) {
    const emp = {};
    empHeaders.forEach((h, idx) => emp[h] = empData[i][idx]);
    if (emp.Status !== 'Active') continue;
    if (existingUsernames.has(String(emp.EmpID))) continue;

    const phoneDigits = String(emp.Phone || '').replace(/\D/g, '');
    const phoneSuffix = phoneDigits.slice(-4);
    const defaultPassword = String(emp.EmpID) + phoneSuffix;
    const salt = Utilities.getUuid();
    const hash = hashPassword_(defaultPassword, salt);
    rowsToAdd.push([emp.EmpID, hash, salt, 'employee', emp.Name, emp.EmpID, true]);
    created++;
  }

  if (rowsToAdd.length) {
    usersSheet.getRange(usersSheet.getLastRow() + 1, 1, rowsToAdd.length, rowsToAdd[0].length).setValues(rowsToAdd);
  }

  SpreadsheetApp.getUi().alert(
    `Created ${created} employee login(s).\n\n` +
    `Each employee signs in with Username = their Employee ID, ` +
    `Password = their Employee ID immediately followed by the last 4 digits of ` +
    `the phone number on file (just their Employee ID if no phone is on file).\n\n` +
    `Share this pattern with HR to communicate to staff, and point everyone to ` +
    `the "My Account" page to set their own password on first login.`
  );
}
