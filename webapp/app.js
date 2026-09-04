/* ============================================================
   app.js — talks to the Apps Script Web App as a JSON API.
   Replace API_URL with your deployed /exec URL.
   ============================================================ */

const API_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

let session = JSON.parse(sessionStorage.getItem('session') || 'null');
let currentPage = 'dashboard';
let lastLoadedRows = []; // powers the Excel/PDF export buttons

// ---------------- API helpers ----------------

async function apiGet(action, params = {}) {
  const qs = new URLSearchParams({ action, token: session?.token || '', ...params });
  const res = await fetch(`${API_URL}?${qs.toString()}`);
  return res.json();
}

async function apiPost(action, body = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight to Apps Script
    body: JSON.stringify({ action, token: session?.token || '', ...body }),
  });
  return res.json();
}

// ---------------- Auth ----------------

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const result = await apiPost('login', { username, password });
  if (result.ok) {
    session = { token: result.token, role: result.role, name: result.name, empId: result.empId || '' };
    sessionStorage.setItem('session', JSON.stringify(session));
    enterApp();
  } else {
    errEl.textContent = result.error || 'Login failed.';
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('session');
  session = null;
  location.reload();
});

function enterApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('userLabel').textContent = `${session.name} · ${session.role}`;
  if (session.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  }
  if (session.role === 'employee') {
    const empNav = document.querySelector('.nav-item[data-page="employees"]');
    if (empNav) empNav.innerHTML = '<span class="ic">&#128100;</span>My Profile';
  }
  navigate('dashboard');
}

if (session) enterApp();

// ---------------- Navigation ----------------

document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

document.getElementById('menuToggle').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.toggle('open');
});

function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelector('.sidebar').classList.remove('open');
  const titles = {
    dashboard: 'Dashboard', employees: session.role === 'employee' ? 'My Profile' : 'Employees',
    attendance: 'Attendance', payroll: 'Payroll',
    reports: 'Reports', devices: 'Devices', synclog: 'Sync log', settings: 'Settings', account: 'My Account',
  };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  const renderers = {
    dashboard: renderDashboard, employees: renderEmployees, attendance: renderAttendance, payroll: renderPayroll,
    reports: renderReports, devices: renderDevices, synclog: renderSyncLog, settings: renderSettings, account: renderAccount,
  };
  (renderers[page] || (() => {}))();
}

function content() { return document.getElementById('content'); }

// ---------------- Dashboard ----------------

async function renderDashboard() {
  if (session.role === 'employee') return renderPersonalDashboard();
  content().innerHTML = `<div class="empty-state">Loading…</div>`;
  const today = new Date().toISOString().slice(0, 10);
  const res = await apiGet('getDashboardSummary', { date: today });
  if (!res.ok) return showError(res.error);
  const c = res.counts;
  content().innerHTML = `
    <div class="kpi-row">
      ${kpiCard('Total employees', res.totalEmployees, '')}
      ${kpiCard('Present', c.Present, 'Present')}
      ${kpiCard('Absent', c.Absent, 'Absent')}
      ${kpiCard('Late', c.Late, 'Late')}
      ${kpiCard('Early leave', c['Early Leave'], 'Late')}
      ${kpiCard('Half day', c['Half Day'], '')}
      ${kpiCard('On leave', c.Leave, '')}
    </div>
    <div class="panel">
      <h3>Today — ${today}</h3>
      <p style="color:var(--muted);font-size:13px;">Full breakdown is under Attendance. Use the date filter there to review any day.</p>
    </div>`;
}

async function renderPersonalDashboard() {
  content().innerHTML = `<div class="empty-state">Loading…</div>`;
  const month = currentMonthStr();
  const [attRes, payRes] = await Promise.all([
    apiGet('getDailyAttendance', { dateFrom: month + '-01' }),
    apiGet('getPayslips', { month }),
  ]);
  const records = attRes.ok ? attRes.records : [];
  const present = records.filter(r => ['Present', 'Late', 'Early Leave'].includes(r.Status)).length;
  const absent = records.filter(r => r.Status === 'Absent').length;
  const late = records.filter(r => r.Status === 'Late').length;
  const otHours = records.reduce((s, r) => s + Number(r.OvertimeHours || 0), 0);
  const payslip = payRes.ok && payRes.payslips.length ? payRes.payslips[0] : null;
  const today = records.find(r => r.Date === new Date().toISOString().slice(0, 10));

  content().innerHTML = `
    <div class="kpi-row">
      ${kpiCard('Present this month', present, 'Present')}
      ${kpiCard('Absent', absent, 'Absent')}
      ${kpiCard('Late', late, 'Late')}
      ${kpiCard('Overtime hours', otHours.toFixed(1), '')}
      ${kpiCard('Net salary (' + month + ')', payslip ? 'Rs ' + num(payslip.NetSalary) : '—', '')}
    </div>
    <div class="panel">
      <h3>Today</h3>
      <p style="color:var(--muted);font-size:13px;">
        ${today
          ? `Time in ${today.PunchIn || '—'}, time out ${today.PunchOut || '—'} — marked <strong>${today.Status}</strong>.`
          : 'No punch recorded yet today.'}
      </p>
    </div>`;
}

function kpiCard(label, value, statusClass) {
  return `<div class="kpi-card status-${statusClass}"><div class="kpi-number">${value ?? 0}</div><div class="kpi-label">${label}</div></div>`;
}

function showError(msg) {
  content().innerHTML = `<div class="empty-state">${msg || 'Something went wrong.'}</div>`;
}

// ---------------- Employees ----------------

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#F4B400,#F2994A)', 'linear-gradient(135deg,#6A63E0,#8E88EF)',
  'linear-gradient(135deg,#2E7D32,#66BB6A)', 'linear-gradient(135deg,#C0392B,#E17055)',
  'linear-gradient(135deg,#2E5FA3,#5B8DEF)', 'linear-gradient(135deg,#B7791F,#F2C14E)',
];
function avatarGradient(seed) {
  let h = 0; for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}
function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

async function renderEmployees() {
  if (session.role === 'employee') {
    content().innerHTML = `<div class="empty-state">Loading…</div>`;
    return loadEmployees();
  }
  content().innerHTML = `
    <div class="emp-toolbar">
      <input id="empSearch" placeholder="Search by name, ID or department">
      <select id="empStatus"><option value="">All statuses</option><option>Active</option><option>Inactive</option></select>
      <div class="spacer"></div>
      ${session.role === 'admin' ? '<button class="btn-primary" id="addEmpBtn" style="width:auto;padding:9px 16px;">Add employee</button>' : ''}
      <span class="emp-count" id="empCount"></span>
    </div>
    <div id="empFormPanel"></div>
    <div id="empGrid" class="emp-grid"><div class="empty-state">Loading…</div></div>`;

  document.getElementById('empSearch').addEventListener('input', debounce(loadEmployees, 300));
  document.getElementById('empStatus').addEventListener('change', loadEmployees);
  if (session.role === 'admin') document.getElementById('addEmpBtn').addEventListener('click', () => showEmployeeForm());
  loadEmployees();
}

async function loadEmployees() {
  const search = document.getElementById('empSearch').value;
  const status = document.getElementById('empStatus').value;
  const res = await apiGet('getEmployees', { search, status });
  if (!res.ok) return;
  lastLoadedRows = res.employees;

  // A plain employee login only ever gets their own record back — skip the
  // directory grid entirely and go straight to their profile.
  if (session.role === 'employee') {
    if (res.employees.length) openProfile(res.employees[0]);
    else content().innerHTML = `<div class="empty-state">Your employee record hasn't been linked yet — contact HR.</div>`;
    return;
  }

  document.getElementById('empCount').textContent = `${res.employees.length} employees`;
  const grid = document.getElementById('empGrid');
  if (!res.employees.length) { grid.innerHTML = `<div class="empty-state">No employees found.</div>`; return; }
  grid.innerHTML = res.employees.map(e => `
    <div class="emp-card" onclick='openProfile(${JSON.stringify(e)})'>
      <div class="emp-avatar" style="background:${avatarGradient(e.Name || e.EmpID)};">${initials(e.Name)}
        <span class="presence" style="background:${e.Status === 'Active' ? 'var(--success)' : 'var(--muted)'};"></span>
      </div>
      <div class="emp-name">${e.Name}</div>
      <div class="emp-role">${e.Designation || ''}</div>
      <div class="emp-dept-badge">${e.Department || '—'}</div>
    </div>`).join('');
}

function showEmployeeForm(emp) {
  const e = emp || {};
  document.getElementById('empFormPanel').innerHTML = `
    <div class="panel">
      <h3>${emp ? 'Edit employee' : 'Add employee'}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 20px;">
        <div class="field"><label>Employee ID</label><input id="f_EmpID" value="${e.EmpID || ''}" ${emp ? 'readonly' : ''}></div>
        <div class="field"><label>Full name</label><input id="f_Name" value="${e.Name || ''}"></div>
        <div class="field"><label>Department</label><input id="f_Department" value="${e.Department || ''}"></div>
        <div class="field"><label>Designation</label><input id="f_Designation" value="${e.Designation || ''}"></div>
        <div class="field"><label>Joining date</label><input type="date" id="f_JoiningDate" value="${fmt(e.JoiningDate)}"></div>
        <div class="field"><label>Phone</label><input id="f_Phone" value="${e.Phone || ''}"></div>
        <div class="field"><label>Email</label><input id="f_Email" value="${e.Email || ''}"></div>
        <div class="field"><label>Device user ID (as enrolled on K40)</label><input id="f_DeviceUserID" value="${e.DeviceUserID || ''}"></div>
        <div class="field"><label>Status</label><select id="f_Status"><option ${e.Status==='Active'?'selected':''}>Active</option><option ${e.Status==='Inactive'?'selected':''}>Inactive</option></select></div>
      </div>
      <div class="actions-row">
        <button class="btn-primary" style="width:auto;padding:9px 20px;" id="saveEmpBtn">Save</button>
        <button class="btn-secondary" id="cancelEmpBtn">Cancel</button>
      </div>
    </div>`;
  document.getElementById('empFormPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('cancelEmpBtn').addEventListener('click', () => document.getElementById('empFormPanel').innerHTML = '');
  document.getElementById('saveEmpBtn').addEventListener('click', async () => {
    const employee = {
      EmpID: val('f_EmpID'), Name: val('f_Name'), Department: val('f_Department'),
      Designation: val('f_Designation'), JoiningDate: val('f_JoiningDate'), Phone: val('f_Phone'),
      Email: val('f_Email'), DeviceUserID: val('f_DeviceUserID'), Status: val('f_Status'),
    };
    const res = await apiPost('upsertEmployee', { employee });
    if (res.ok) {
      document.getElementById('empFormPanel').innerHTML = '';
      if (currentPage === 'employees') loadEmployees(); else navigate('employees');
    } else alert(res.error);
  });
}

// ---------------- Employee profile ----------------

async function openProfile(emp) {
  currentPage = 'profile';
  document.querySelectorAll('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === 'employees'));
  document.getElementById('pageTitle').textContent = 'Employee profile';
  content().innerHTML = `<div class="empty-state">Loading…</div>`;

  const monthStr = currentMonthStr();
  const [attRes, payRes] = await Promise.all([
    apiGet('getDailyAttendance', { empId: emp.EmpID, dateFrom: monthStr + '-01' }),
    apiGet('getPayslips', { empId: emp.EmpID, month: monthStr }),
  ]);
  const records = attRes.ok ? attRes.records : [];
  const present = records.filter(r => ['Present', 'Late', 'Early Leave'].includes(r.Status)).length;
  const absent = records.filter(r => r.Status === 'Absent').length;
  const late = records.filter(r => r.Status === 'Late').length;
  const otHours = records.reduce((s, r) => s + Number(r.OvertimeHours || 0), 0);
  const rate = records.length ? Math.round((present / records.length) * 100) : 0;
  const payslip = payRes.ok && payRes.payslips.length ? payRes.payslips[0] : null;

  content().innerHTML = `
    <button class="back-link" id="backToEmpBtn">&#8592; Back to employees</button>
    <div class="profile-banner">
      <div class="profile-avatar-lg" style="background:${avatarGradient(emp.Name || emp.EmpID)};color:white;">${initials(emp.Name)}</div>
      <div class="profile-banner-info">
        <h2>${emp.Name}</h2>
        <div class="role-line">${emp.Designation || ''} · ${emp.Department || ''} · ${emp.EmpID}</div>
        <div class="profile-banner-tags">
          <span class="profile-tag ${emp.Status === 'Active' ? 'active-tag' : ''}">${emp.Status}</span>
          <span class="profile-tag">Joined ${fmt(emp.JoiningDate) || '—'}</span>
        </div>
      </div>
      ${session.role === 'admin' ? `<div class="profile-actions"><button id="editProfileBtn" title="Edit profile">&#9998;</button></div>` : ''}
    </div>

    <div class="profile-tabs">
      <button class="active" data-ptab="overview">Overview</button>
      <button data-ptab="attendance">Attendance</button>
      <button data-ptab="payroll">Payroll</button>
    </div>

    <div id="ptabOverview">
      <div class="mini-stat-row">
        <div class="mini-stat"><div class="n">${present}</div><div class="l">Present (this month)</div></div>
        <div class="mini-stat"><div class="n">${absent}</div><div class="l">Absent</div></div>
        <div class="mini-stat"><div class="n">${late}</div><div class="l">Late</div></div>
        <div class="mini-stat"><div class="n">${otHours.toFixed(1)}</div><div class="l">OT hours</div></div>
        <div class="mini-stat"><div class="n">${rate}%</div><div class="l">Attendance rate</div></div>
      </div>
      <div class="info-grid">
        <div class="info-item"><div class="lbl">Employee ID</div><div class="val">${emp.EmpID}</div></div>
        <div class="info-item"><div class="lbl">Department</div><div class="val">${emp.Department || '—'}</div></div>
        <div class="info-item"><div class="lbl">Designation</div><div class="val">${emp.Designation || '—'}</div></div>
        <div class="info-item"><div class="lbl">Joining date</div><div class="val">${fmt(emp.JoiningDate) || '—'}</div></div>
        <div class="info-item"><div class="lbl">Phone</div><div class="val">${emp.Phone || '—'}</div></div>
        <div class="info-item"><div class="lbl">Email</div><div class="val">${emp.Email || '—'}</div></div>
        <div class="info-item"><div class="lbl">Device user ID</div><div class="val">${emp.DeviceUserID || '—'}</div></div>
        <div class="info-item"><div class="lbl">Employment status</div><div class="val">${emp.Status}</div></div>
      </div>
    </div>

    <div id="ptabAttendance" class="hidden">
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>In</th><th>Out</th><th>Hours</th><th>OT</th><th>Status</th></tr></thead>
        <tbody>${records.length ? records.map(r => `
          <tr><td>${r.Date}</td><td>${r.PunchIn || '—'}</td><td>${r.PunchOut || '—'}</td>
            <td>${r.WorkingHours ?? 0}</td><td>${r.OvertimeHours ?? 0}</td>
            <td><span class="badge ${(r.Status||'').replace(' ','-')}">${r.Status}</span></td></tr>`).join('')
          : '<tr><td colspan="6">No attendance records for this month yet.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div id="ptabPayroll" class="hidden">
      ${payslip ? `
        <div class="panel">
          <h3>Latest payslip — ${payslip.Month}</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px;">
            <div>${payslipLine('Basic salary', payslip.BasicSalary)}${payslipLine('Allowances', payslip.TotalAllowances)}${payslipLine('Overtime pay', payslip.OvertimePay)}</div>
            <div>${payslipLine('Absent deduction', payslip.AbsentDeduction)}${payslipLine('Half day deduction', payslip.HalfDayDeduction)}${payslipLine('Total deductions', payslip.TotalDeductions, true)}</div>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--border);"><strong style="font-size:16px;">Net salary: Rs ${num(payslip.NetSalary)}</strong></div>
        </div>` : `<div class="empty-state">No payslip generated for this employee yet this month.</div>`}
    </div>`;

  document.getElementById('backToEmpBtn').addEventListener('click', () => navigate('employees'));
  if (session.role === 'admin') document.getElementById('editProfileBtn').addEventListener('click', () => showEmployeeForm(emp));
  document.querySelectorAll('.profile-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.profile-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['overview', 'attendance', 'payroll'].forEach(t => {
        document.getElementById('ptab' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hidden', t !== btn.dataset.ptab);
      });
    });
  });
}

// ---------------- Attendance ----------------

async function renderAttendance() {
  const today = new Date().toISOString().slice(0, 10);
  content().innerHTML = `
    <div class="filter-bar">
      <label>From<input type="date" id="attFrom" value="${today}"></label>
      <label>To<input type="date" id="attTo" value="${today}"></label>
      <label>Employee ID<input id="attEmp" placeholder="Optional"></label>
      <label>Department<input id="attDept" placeholder="Optional"></label>
      <label>Status<select id="attStatus"><option value="">All</option><option>Present</option><option>Absent</option><option>Late</option><option>Early Leave</option><option>Half Day</option><option>Leave</option><option>Holiday</option></select></label>
      <div class="spacer"></div>
      <button class="btn-secondary" id="attFilterBtn">Apply</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>ID</th><th>Name</th><th>Department</th><th>In</th><th>Out</th><th>Hours</th><th>OT</th><th>Status</th><th>Remarks</th></tr></thead>
      <tbody id="attTableBody"><tr><td colspan="10">Loading…</td></tr></tbody>
    </table></div>`;
  document.getElementById('attFilterBtn').addEventListener('click', loadAttendance);
  loadAttendance();
}

async function loadAttendance() {
  const params = {
    dateFrom: val('attFrom'), dateTo: val('attTo'), empId: val('attEmp'),
    department: val('attDept'), status: val('attStatus'),
  };
  const res = await apiGet('getDailyAttendance', params);
  if (!res.ok) return;
  lastLoadedRows = res.records;
  const tbody = document.getElementById('attTableBody');
  if (!res.records.length) { tbody.innerHTML = `<tr><td colspan="10">No records for this filter.</td></tr>`; return; }
  tbody.innerHTML = res.records.map(r => `
    <tr>
      <td>${r.Date}</td><td>${r.EmpID}</td><td>${r.Name}</td><td>${r.Department}</td>
      <td>${r.PunchIn || '—'}</td><td>${r.PunchOut || '—'}</td>
      <td>${r.WorkingHours ?? 0}</td><td>${r.OvertimeHours ?? 0}</td>
      <td><span class="badge ${(r.Status || '').replace(' ', '-')}">${r.Status}</span></td>
      <td>${r.Remarks || ''}</td>
    </tr>`).join('');
}

// ---------------- Payroll ----------------

function currentMonthStr() { return new Date().toISOString().slice(0, 7); }

async function renderPayroll() {
  const month = currentMonthStr();
  content().innerHTML = `
    <div class="filter-bar">
      <label>Payroll month<input type="month" id="prMonth" value="${month}"></label>
      <label>Department<input id="prDept" placeholder="Optional"></label>
      <div class="spacer"></div>
      ${session.role === 'admin' ? `
        <button class="btn-secondary" id="manageSalariesBtn">Manage salary structures</button>
        <button class="btn-primary" style="width:auto;padding:9px 18px;" id="generatePayrollBtn">Generate payroll for month</button>
      ` : ''}
    </div>
    <div id="salaryStructurePanel"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>ID</th><th>Name</th><th>Dept</th><th>Basic</th><th>Allowances</th><th>Present/Absent</th><th>OT Pay</th><th>Deductions</th><th>Net salary</th><th>Status</th><th></th></tr></thead>
      <tbody id="payrollTableBody"><tr><td colspan="11">Loading…</td></tr></tbody>
    </table></div>
    <div id="payslipPanel"></div>`;

  document.getElementById('prMonth').addEventListener('change', loadPayroll);
  document.getElementById('prDept').addEventListener('input', debounce(loadPayroll, 300));
  if (session.role === 'admin') {
    document.getElementById('generatePayrollBtn').addEventListener('click', async () => {
      const btn = document.getElementById('generatePayrollBtn');
      btn.textContent = 'Generating…'; btn.disabled = true;
      const res = await apiPost('generatePayroll', { month: val('prMonth') });
      btn.textContent = 'Generate payroll for month'; btn.disabled = false;
      if (res.ok) loadPayroll();
      else alert(res.error);
    });
    document.getElementById('manageSalariesBtn').addEventListener('click', showSalaryStructureList);
  }
  loadPayroll();
}

async function loadPayroll() {
  const params = { month: val('prMonth'), department: val('prDept') };
  const res = await apiGet('getPayslips', params);
  if (!res.ok) return;
  lastLoadedRows = res.payslips;
  const tbody = document.getElementById('payrollTableBody');
  if (!res.payslips.length) {
    tbody.innerHTML = `<tr><td colspan="11">No payroll generated for this month yet${session.role === 'admin' ? ' — click "Generate payroll for month" above.' : '.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = res.payslips.map(r => `
    <tr>
      <td>${r.EmpID}</td><td>${r.Name}</td><td>${r.Department}</td>
      <td>Rs ${num(r.BasicSalary)}</td><td>Rs ${num(r.TotalAllowances)}</td>
      <td>${r.PresentDays} / ${r.AbsentDays}</td>
      <td>Rs ${num(r.OvertimePay)}</td><td>Rs ${num(r.TotalDeductions)}</td>
      <td><strong>Rs ${num(r.NetSalary)}</strong></td>
      <td><span class="badge ${r.Status}">${r.Status}</span></td>
      <td><button class="btn-secondary" onclick='showPayslip(${JSON.stringify(r)})'>View payslip</button></td>
    </tr>`).join('');
}

function num(n) { return Number(n || 0).toLocaleString(); }

function showPayslip(r) {
  document.getElementById('payslipPanel').innerHTML = `
    <div class="panel" style="margin-top:16px;">
      <h3>Payslip — ${r.Name} (${r.EmpID}) — ${r.Month}</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px;">
        <div>
          <p style="font-size:12.5px;color:var(--muted);margin-bottom:8px;">EARNINGS</p>
          ${payslipLine('Basic salary', r.BasicSalary)}
          ${payslipLine('Allowances', r.TotalAllowances)}
          ${payslipLine('Overtime pay (' + r.OvertimeHours + ' hrs)', r.OvertimePay)}
          ${payslipLine('Gross earnings', Number(r.GrossEarnings) + Number(r.OvertimePay), true)}
        </div>
        <div>
          <p style="font-size:12.5px;color:var(--muted);margin-bottom:8px;">DEDUCTIONS</p>
          ${payslipLine('Absent (' + r.AbsentDays + ' days)', r.AbsentDeduction)}
          ${payslipLine('Half day (' + r.HalfDays + ' days)', r.HalfDayDeduction)}
          ${payslipLine('Total deductions', r.TotalDeductions, true)}
        </div>
      </div>
      <div style="margin-top:16px;padding-top:14px;border-top:1px dashed var(--border);display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:16px;">Net salary: Rs ${num(r.NetSalary)}</strong>
        ${session.role === 'admin' && r.Status !== 'Paid' ? `<button class="btn-secondary" id="markPaidBtn">Mark as paid</button>` : ''}
      </div>
    </div>`;
  if (session.role === 'admin' && r.Status !== 'Paid') {
    document.getElementById('markPaidBtn').addEventListener('click', async () => {
      const res = await apiPost('markPayslipPaid', { month: r.Month, empId: r.EmpID });
      if (res.ok) loadPayroll();
    });
  }
}

function payslipLine(label, amount, isTotal) {
  return `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13.5px;${isTotal ? 'font-weight:700;border-top:1px solid var(--border);margin-top:4px;padding-top:10px;' : ''}"><span>${label}</span><span>Rs ${num(amount)}</span></div>`;
}

async function showSalaryStructureList() {
  const res = await apiGet('getPayrollStructure');
  const empRes = await apiGet('getEmployees');
  if (!res.ok || !empRes.ok) return;
  const structureByEmp = {};
  res.structures.forEach(s => structureByEmp[s.EmpID] = s);

  document.getElementById('salaryStructurePanel').innerHTML = `
    <div class="panel">
      <h3>Salary structures</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>ID</th><th>Name</th><th>Basic</th><th>House</th><th>Transport</th><th>Medical</th><th>Other</th><th></th></tr></thead>
        <tbody>
          ${empRes.employees.map(e => {
            const s = structureByEmp[e.EmpID] || {};
            return `<tr>
              <td>${e.EmpID}</td><td>${e.Name}</td>
              <td><input class="sal-input" data-emp="${e.EmpID}" data-field="BasicSalary" value="${s.BasicSalary || 0}" style="width:90px;"></td>
              <td><input class="sal-input" data-emp="${e.EmpID}" data-field="HouseAllowance" value="${s.HouseAllowance || 0}" style="width:80px;"></td>
              <td><input class="sal-input" data-emp="${e.EmpID}" data-field="TransportAllowance" value="${s.TransportAllowance || 0}" style="width:80px;"></td>
              <td><input class="sal-input" data-emp="${e.EmpID}" data-field="MedicalAllowance" value="${s.MedicalAllowance || 0}" style="width:80px;"></td>
              <td><input class="sal-input" data-emp="${e.EmpID}" data-field="OtherAllowance" value="${s.OtherAllowance || 0}" style="width:80px;"></td>
              <td><button class="btn-secondary save-sal-btn" data-emp="${e.EmpID}">Save</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
      <div class="actions-row"><button class="btn-secondary" id="closeSalPanel">Close</button></div>
    </div>`;

  document.getElementById('closeSalPanel').addEventListener('click', () => document.getElementById('salaryStructurePanel').innerHTML = '');
  document.querySelectorAll('.save-sal-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const empId = btn.dataset.emp;
      const structure = { EmpID: empId };
      document.querySelectorAll(`.sal-input[data-emp="${empId}"]`).forEach(inp => structure[inp.dataset.field] = inp.value);
      const res = await apiPost('upsertPayrollStructure', { structure });
      if (!res.ok) alert(res.error);
    });
  });
}

// ---------------- Reports (export current view) ----------------

function renderReports() {
  content().innerHTML = `
    <div class="panel">
      <h3>Export current data</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">
        Go to Employees or Attendance, apply the filters you want, then come back here — or use the
        buttons below to export whatever you last viewed (${lastLoadedRows.length} rows loaded).
      </p>
      <div class="actions-row">
        <button class="btn-secondary" id="exportExcelBtn">Export to Excel</button>
        <button class="btn-secondary" id="exportPdfBtn">Export to PDF</button>
      </div>
    </div>`;
  document.getElementById('exportExcelBtn').addEventListener('click', exportExcel);
  document.getElementById('exportPdfBtn').addEventListener('click', exportPdf);
}

function exportExcel() {
  if (!lastLoadedRows.length) return alert('Nothing loaded to export yet — visit Employees or Attendance first.');
  const ws = XLSX.utils.json_to_sheet(lastLoadedRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, `report_${currentDateStamp()}.xlsx`);
}

function exportPdf() {
  if (!lastLoadedRows.length) return alert('Nothing loaded to export yet — visit Employees or Attendance first.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape' });
  const cols = Object.keys(lastLoadedRows[0]);
  const rows = lastLoadedRows.map(r => cols.map(c => r[c]));
  doc.text('Attendance Report', 14, 14);
  doc.autoTable({ head: [cols], body: rows, startY: 20, styles: { fontSize: 8 }, headStyles: { fillColor: [244, 180, 0], textColor: [30, 42, 56] } });
  doc.save(`report_${currentDateStamp()}.pdf`);
}

// ---------------- Devices ----------------

async function renderDevices() {
  content().innerHTML = `
    <div class="actions-row"><button class="btn-primary" style="width:auto;padding:9px 16px;" id="addDeviceBtn">Add device</button></div>
    <div id="deviceFormPanel"></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Device ID</th><th>Name</th><th>IP</th><th>Port</th><th>Location</th><th>Status</th><th>Last sync</th><th></th></tr></thead>
      <tbody id="deviceTableBody"><tr><td colspan="8">Loading…</td></tr></tbody>
    </table></div>`;
  document.getElementById('addDeviceBtn').addEventListener('click', () => showDeviceForm());
  loadDevices();
}

async function loadDevices() {
  const res = await apiGet('getDevices');
  if (!res.ok) return;
  const tbody = document.getElementById('deviceTableBody');
  if (!res.devices.length) { tbody.innerHTML = `<tr><td colspan="8">No devices configured yet.</td></tr>`; return; }
  tbody.innerHTML = res.devices.map(d => `
    <tr>
      <td>${d.DeviceID}</td><td>${d.Name}</td><td>${d.IPAddress}</td><td>${d.Port}</td><td>${d.Location || ''}</td>
      <td><span class="status-dot ${d.LastSyncStatus === 'OK' ? 'ok' : 'fail'}"></span>${d.LastSyncStatus || 'Never synced'}</td>
      <td>${d.LastSyncAt ? new Date(d.LastSyncAt).toLocaleString() : '—'}</td>
      <td><button class="btn-secondary" onclick='showDeviceForm(${JSON.stringify(d)})'>Edit</button></td>
    </tr>`).join('');
}

function showDeviceForm(dev) {
  const d = dev || {};
  document.getElementById('deviceFormPanel').innerHTML = `
    <div class="panel">
      <h3>${dev ? 'Edit device' : 'Add device'}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 20px;">
        <div class="field"><label>Device ID (used by the sync service config.json)</label><input id="d_DeviceID" value="${d.DeviceID || ''}" ${dev ? 'readonly' : ''}></div>
        <div class="field"><label>Name</label><input id="d_Name" value="${d.Name || ''}" placeholder="Main entrance K40"></div>
        <div class="field"><label>IP address</label><input id="d_IPAddress" value="${d.IPAddress || ''}" placeholder="192.168.1.201"></div>
        <div class="field"><label>TCP port</label><input id="d_Port" value="${d.Port || 4370}"></div>
        <div class="field"><label>Comm key / password (0 if none)</label><input id="d_CommKey" value="${d.CommKey || 0}"></div>
        <div class="field"><label>Location</label><input id="d_Location" value="${d.Location || ''}"></div>
      </div>
      <div class="actions-row">
        <button class="btn-primary" style="width:auto;padding:9px 20px;" id="saveDeviceBtn">Save</button>
        <button class="btn-secondary" id="cancelDeviceBtn">Cancel</button>
      </div>
      <div id="apiKeyOut"></div>
    </div>`;
  document.getElementById('cancelDeviceBtn').addEventListener('click', () => document.getElementById('deviceFormPanel').innerHTML = '');
  document.getElementById('saveDeviceBtn').addEventListener('click', async () => {
    const device = { DeviceID: val('d_DeviceID'), Name: val('d_Name'), IPAddress: val('d_IPAddress'), Port: val('d_Port'), CommKey: val('d_CommKey'), Location: val('d_Location') };
    const res = await apiPost('upsertDevice', { device });
    if (res.ok) {
      if (res.apiKey) {
        document.getElementById('apiKeyOut').innerHTML = `<p style="margin-top:14px;font-size:13px;">
          API key for this device (paste into <code>config.json</code> on the sync PC — shown once): <br><strong>${res.apiKey}</strong></p>`;
      }
      loadDevices();
    } else alert(res.error);
  });
}

// ---------------- Sync log ----------------

async function renderSyncLog() {
  content().innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Time</th><th>Device</th><th>Fetched</th><th>Inserted</th><th>Duplicates</th><th>Status</th><th>Error</th></tr></thead>
      <tbody id="syncTableBody"><tr><td colspan="7">Loading…</td></tr></tbody>
    </table></div>`;
  const res = await apiGet('getSyncLogs', { limit: 150 });
  if (!res.ok) return;
  const tbody = document.getElementById('syncTableBody');
  if (!res.logs.length) { tbody.innerHTML = `<tr><td colspan="7">No sync activity yet.</td></tr>`; return; }
  tbody.innerHTML = res.logs.map(l => `
    <tr>
      <td>${new Date(l.Timestamp).toLocaleString()}</td><td>${l.DeviceID}</td><td>${l.RecordsFetched}</td>
      <td>${l.RecordsInserted}</td><td>${l.DuplicatesSkipped}</td>
      <td><span class="status-dot ${l.Status === 'OK' ? 'ok' : 'fail'}"></span>${l.Status}</td>
      <td>${l.ErrorMessage || ''}</td>
    </tr>`).join('');
}

// ---------------- Settings ----------------

async function renderSettings() {
  content().innerHTML = `<div class="empty-state">Loading…</div>`;
  const res = await apiGet('getConfig');
  if (!res.ok) return showError(res.error);
  const c = res.config;
  content().innerHTML = `
    <div class="panel">
      <h3>Office timings and rules</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 20px;">
        ${settingField('OfficeStartTime', 'Office start time', c.OfficeStartTime, 'time')}
        ${settingField('OfficeEndTime', 'Office end time', c.OfficeEndTime, 'time')}
        ${settingField('GracePeriodMinutes', 'Grace period (minutes)', c.GracePeriodMinutes)}
        ${settingField('EarlyLeaveGraceMinutes', 'Early leave grace (minutes)', c.EarlyLeaveGraceMinutes)}
        ${settingField('LunchBreakMinutes', 'Lunch break (minutes)', c.LunchBreakMinutes)}
        ${settingField('StandardWorkHours', 'Standard work hours/day', c.StandardWorkHours)}
        ${settingField('HalfDayThresholdHours', 'Half day threshold (hours)', c.HalfDayThresholdHours)}
        ${settingField('OvertimeGraceMinutes', 'Overtime grace (minutes)', c.OvertimeGraceMinutes)}
        ${settingField('WorkingDays', 'Working days (comma separated, e.g. Mon,Tue,Wed)', c.WorkingDays)}
        ${settingField('CompanyName', 'Company name', c.CompanyName)}
      </div>
      <div class="actions-row"><button class="btn-primary" style="width:auto;padding:9px 20px;" id="saveSettingsBtn">Save settings</button></div>
      <p id="settingsMsg" style="font-size:13px;color:var(--success);"></p>
    </div>`;
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const config = {};
    ['OfficeStartTime','OfficeEndTime','GracePeriodMinutes','EarlyLeaveGraceMinutes','LunchBreakMinutes',
     'StandardWorkHours','HalfDayThresholdHours','OvertimeGraceMinutes','WorkingDays','CompanyName']
      .forEach(k => config[k] = val('s_' + k));
    const res = await apiPost('updateConfig', { config });
    document.getElementById('settingsMsg').textContent = res.ok ? 'Saved.' : (res.error || 'Failed to save.');
  });
}

function settingField(key, label, value, type = 'text') {
  return `<div class="field"><label>${label}</label><input type="${type}" id="s_${key}" value="${value ?? ''}"></div>`;
}

// ---------------- My Account ----------------

function renderAccount() {
  content().innerHTML = `
    <div class="panel" style="max-width:420px;">
      <h3>My account</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Signed in as <strong>${session.name}</strong> (${session.role}).</p>
      <div class="field"><label>Current password</label><input type="password" id="acc_current"></div>
      <div class="field"><label>New password</label><input type="password" id="acc_new"></div>
      <div class="field"><label>Confirm new password</label><input type="password" id="acc_confirm"></div>
      <div class="actions-row">
        <button class="btn-primary" style="width:auto;padding:9px 20px;" id="acc_saveBtn">Update password</button>
      </div>
      <p id="acc_msg" style="font-size:13px;"></p>
    </div>`;
  document.getElementById('acc_saveBtn').addEventListener('click', async () => {
    const current = val('acc_current'), next = val('acc_new'), confirm = val('acc_confirm');
    const msg = document.getElementById('acc_msg');
    if (next !== confirm) { msg.style.color = 'var(--danger)'; msg.textContent = "New passwords don't match."; return; }
    const res = await apiPost('changePassword', { currentPassword: current, newPassword: next });
    msg.style.color = res.ok ? 'var(--success)' : 'var(--danger)';
    msg.textContent = res.ok ? 'Password updated.' : (res.error || 'Failed to update password.');
    if (res.ok) { document.getElementById('acc_current').value = ''; document.getElementById('acc_new').value = ''; document.getElementById('acc_confirm').value = ''; }
  });
}

// ---------------- utils ----------------

function val(id) { return document.getElementById(id).value; }
function fmt(d) { if (!d) return ''; return String(d).slice(0, 10); }
function currentDateStamp() { return new Date().toISOString().slice(0, 10); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
