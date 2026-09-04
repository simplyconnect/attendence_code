/**
 * PayrollEngine.gs
 * ------------------------------------------------------------
 * Turns a month's DailyAttendance + each employee's salary structure
 * (Payroll sheet) into one Payslips row per employee per month.
 *
 * Deliberately simple and transparent — a straight-line daily rate
 * (BasicSalary / WorkingDaysPerMonth), overtime paid at a configurable
 * multiplier of the hourly rate, deductions for Absent/Half Day days.
 * Adjust the formulas below to match your company's actual policy;
 * everything that should be tunable already lives in the Config sheet.
 *
 * Idempotent: regenerating a month overwrites that EmpID+Month row
 * rather than appending, so it's always safe to re-run after fixing
 * attendance or a salary structure change.
 * ------------------------------------------------------------
 */

function generateMonthlyPayroll(monthStr) {
  // monthStr = 'YYYY-MM'
  const cfg = getConfigMap_();
  const employees = getActiveEmployees_();
  const structures = getPayrollStructureMap_();
  const attendanceByEmp = getMonthAttendanceByEmployee_(monthStr);

  const overtimeMultiplier = Number(cfg.OvertimePayMultiplier || 1.5);
  const workingDaysPerMonth = Number(cfg.WorkingDaysPerMonth || 26);
  const standardHours = Number(cfg.StandardWorkHours || 8);
  const halfDayFactor = Number(cfg.HalfDayDeductionFactor || 0.5);

  let generated = 0;
  employees.forEach(emp => {
    const structure = structures[emp.EmpID];
    if (!structure) return; // no salary structure set up yet — skip, don't guess

    const basic = Number(structure.BasicSalary || 0);
    const allowances = Number(structure.HouseAllowance || 0) + Number(structure.TransportAllowance || 0)
      + Number(structure.MedicalAllowance || 0) + Number(structure.OtherAllowance || 0);
    const gross = basic + allowances;
    const dailyRate = workingDaysPerMonth > 0 ? basic / workingDaysPerMonth : 0;
    const hourlyRate = standardHours > 0 ? dailyRate / standardHours : 0;

    const att = attendanceByEmp[emp.EmpID] || { present: 0, absent: 0, halfDay: 0, leave: 0, overtimeHours: 0 };

    const overtimePay = att.overtimeHours * hourlyRate * overtimeMultiplier;
    const absentDeduction = att.absent * dailyRate;
    const halfDayDeduction = att.halfDay * dailyRate * halfDayFactor;
    const totalDeductions = absentDeduction + halfDayDeduction;
    const netSalary = gross + overtimePay - totalDeductions;

    upsertPayslipRow_(monthStr, emp, basic, allowances, gross, att, overtimePay,
      absentDeduction, halfDayDeduction, totalDeductions, netSalary);
    generated++;
  });

  return { ok: true, generated, month: monthStr };
}

function upsertPayslipRow_(monthStr, emp, basic, allowances, gross, att, overtimePay,
                            absentDeduction, halfDayDeduction, totalDeductions, netSalary) {
  const sheet = SS.getSheetByName('Payslips');
  const data = sheet.getDataRange().getValues();
  const row = [
    monthStr, emp.EmpID, emp.Name, emp.Department, Number(basic.toFixed(2)), Number(allowances.toFixed(2)),
    Number(gross.toFixed(2)), att.present, att.absent, att.halfDay, att.leave,
    Number(att.overtimeHours.toFixed(2)), Number(overtimePay.toFixed(2)),
    Number(absentDeduction.toFixed(2)), Number(halfDayDeduction.toFixed(2)),
    Number(totalDeductions.toFixed(2)), Number(netSalary.toFixed(2)), 'Draft', new Date()
  ];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === monthStr && String(data[i][1]) === String(emp.EmpID)) {
      // preserve Status (Draft/Paid) if the row already exists and was marked Paid
      row[17] = data[i][17] || 'Draft';
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

function getPayrollStructureMap_() {
  const data = SS.getSheetByName('Payroll').getDataRange().getValues();
  const headers = data[0];
  const map = {};
  for (let i = 1; i < data.length; i++) {
    const obj = rowToObj_(headers, data[i]);
    // last row wins if multiple effective-dated entries exist per employee
    map[obj.EmpID] = obj;
  }
  return map;
}

function getMonthAttendanceByEmployee_(monthStr) {
  const data = SS.getSheetByName('DailyAttendance').getDataRange().getValues();
  const headers = data[0];
  const result = {};
  for (let i = 1; i < data.length; i++) {
    const row = rowToObj_(headers, data[i]);
    if (fmtDate_(row.Date).slice(0, 7) !== monthStr) continue;
    const empId = row.EmpID;
    if (!result[empId]) result[empId] = { present: 0, absent: 0, halfDay: 0, leave: 0, overtimeHours: 0 };
    const bucket = result[empId];
    if (row.Status === 'Present' || row.Status === 'Late' || row.Status === 'Early Leave') bucket.present++;
    else if (row.Status === 'Absent') bucket.absent++;
    else if (row.Status === 'Half Day') bucket.halfDay++;
    else if (row.Status === 'Leave') bucket.leave++;
    bucket.overtimeHours += Number(row.OvertimeHours || 0);
  }
  return result;
}

// ============================================================
// Payroll API surface, called from Code.gs route_()
// ============================================================

function getPayrollStructure_() {
  const data = SS.getSheetByName('Payroll').getDataRange().getValues();
  const headers = data[0];
  return { ok: true, structures: data.slice(1).map(r => rowToObj_(headers, r)) };
}

function upsertPayrollStructure_(s) {
  const sheet = SS.getSheetByName('Payroll');
  const data = sheet.getDataRange().getValues();
  const row = [s.EmpID, s.BasicSalary, s.HouseAllowance || 0, s.TransportAllowance || 0,
    s.MedicalAllowance || 0, s.OtherAllowance || 0, s.EffectiveDate || fmtDate_(new Date()), new Date()];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(s.EmpID)) {
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return { ok: true, updated: true };
    }
  }
  sheet.appendRow(row);
  return { ok: true, created: true };
}

function getPayslips_(p, session) {
  const data = SS.getSheetByName('Payslips').getDataRange().getValues();
  const headers = data[0];
  let rows = data.slice(1).map(r => rowToObj_(headers, r));

  const scopedEmpId = session.role === 'employee' ? session.empId : p.empId;
  if (scopedEmpId) rows = rows.filter(r => String(r.EmpID) === String(scopedEmpId));

  if (p.month) rows = rows.filter(r => r.Month === p.month);
  if (session.role !== 'employee' && p.department) rows = rows.filter(r => r.Department === p.department);
  return { ok: true, payslips: rows };
}

function markPayslipPaid_(p) {
  const sheet = SS.getSheetByName('Payslips');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === p.month && String(data[i][1]) === String(p.empId)) {
      sheet.getRange(i + 1, 18).setValue('Paid');
      return { ok: true };
    }
  }
  return { ok: false, error: 'Payslip not found — generate payroll for this month first.' };
}
