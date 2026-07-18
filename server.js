require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

// Data directory
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// JSON File Helpers
function readJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return [];
  }
}

function writeJSON(filename, data) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// Initialize default data
function initData() {
  // Admins
  if (!fs.existsSync(path.join(DATA_DIR, 'admins.json'))) {
    const hash = bcrypt.hashSync('aura@1234', 10);
    writeJSON('admins.json', [
      { id: 1, username: 'superadmin', password: hash, created_at: new Date().toISOString() }
    ]);
  }
  
  // Settings
  if (!fs.existsSync(path.join(DATA_DIR, 'settings.json'))) {
    writeJSON('settings.json', {
      id: 1,
      site_name: 'Vehicle Admin',
      maintenance_mode: false,
      api_base_url: 'https://vehicleinfo.noobgamingv40.workers.dev/fetch',
      theme: 'light',
      api_enabled: true
    });
  }
  
  // API Keys
  if (!fs.existsSync(path.join(DATA_DIR, 'api_keys.json'))) {
    writeJSON('api_keys.json', []);
  }
  
  // Request Logs
  if (!fs.existsSync(path.join(DATA_DIR, 'request_logs.json'))) {
    writeJSON('request_logs.json', []);
  }
}
initData();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 }
}));

const requireAuth = (req, res, next) => {
  if (!req.session.admin) return res.redirect('/login');
  next();
};

// ============ AUTH ============

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const admins = readJSON('admins.json');
  const admin = admins.find(a => a.username === username);
  
  if (admin && bcrypt.compareSync(password, admin.password)) {
    req.session.admin = admin;
    return res.redirect('/');
  }
  res.render('login', { error: 'Invalid credentials' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============ DASHBOARD ============

app.get('/', requireAuth, (req, res) => {
  const settings = readJSON('settings.json');
  const logs = readJSON('request_logs.json');
  const keys = readJSON('api_keys.json');
  const admins = readJSON('admins.json');
  
  const today = new Date().toISOString().split('T')[0];
  const thisMonth = new Date().toISOString().substring(0, 7);
  
  const totalReq = logs.length;
  const todayReq = logs.filter(l => l.created_at && l.created_at.startsWith(today)).length;
  const monthReq = logs.filter(l => l.created_at && l.created_at.startsWith(thisMonth)).length;
  const activeKeys = keys.filter(k => k.status === 'active').length;
  const expiredKeys = keys.filter(k => k.status === 'expired').length;
  const disabledKeys = keys.filter(k => k.status === 'disabled').length;
  
  // Daily chart data (last 7 days)
  const dailyData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const count = logs.filter(l => l.created_at && l.created_at.startsWith(dateStr)).length;
    dailyData.push({ date: dateStr, count });
  }
  
  // Top keys
  const keyUsage = {};
  logs.forEach(l => {
    if (l.api_key) {
      keyUsage[l.api_key] = (keyUsage[l.api_key] || 0) + 1;
    }
  });
  const topKeys = Object.entries(keyUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([api_key, count]) => {
      const key = keys.find(k => k.api_key === api_key);
      return { api_key, owner_name: key ? key.owner_name : 'Unknown', count };
    });
  
  // Success vs Failed
  const successCount = logs.filter(l => l.response_status === 'success').length;
  const failedCount = logs.filter(l => l.response_status === 'failed').length;
  const otherCount = totalReq - successCount - failedCount;
  const successFailed = [
    { response_status: 'success', count: successCount },
    { response_status: 'failed', count: failedCount },
    { response_status: 'other', count: otherCount }
  ];
  
  // Monthly data
  const monthlyMap = {};
  logs.forEach(l => {
    if (l.created_at) {
      const month = l.created_at.substring(0, 7);
      monthlyMap[month] = (monthlyMap[month] || 0) + 1;
    }
  });
  const monthlyData = Object.entries(monthlyMap).map(([month, count]) => ({ month, count }));
  
  res.render('dashboard', {
    stats: {
      total: totalReq,
      today: todayReq,
      month: monthReq,
      totalKeys: keys.length,
      activeKeys,
      expiredKeys,
      disabledKeys,
      apiStatus: settings.api_enabled ? 'Online' : 'Offline',
      maintenance: settings.maintenance_mode ? 'ON' : 'OFF'
    },
    dailyData: JSON.stringify(dailyData),
    topKeys: JSON.stringify(topKeys),
    successFailed: JSON.stringify(successFailed),
    monthlyData: JSON.stringify(monthlyData),
    settings,
    admin: req.session.admin
  });
});

// ============ API KEYS ============

app.get('/keys', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const limit = 20;
  
  let keys = readJSON('api_keys.json');
  
  if (search) {
    keys = keys.filter(k => 
      k.owner_name.toLowerCase().includes(search.toLowerCase()) || 
      k.api_key.includes(search)
    );
  }
  
  keys.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const total = keys.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const pagedKeys = keys.slice(offset, offset + limit);
  
  res.render('keys', { keys: pagedKeys, page, search, totalPages, admin: req.session.admin });
});

app.post('/keys/generate', requireAuth, (req, res) => {
  const { owner_name, expiry_days, daily_limit, total_limit, custom_key } = req.body;
  const keys = readJSON('api_keys.json');
  
  const api_key = custom_key || uuidv4().replace(/-/g, '').substring(0, 32);
  
  // Check duplicate
  if (keys.find(k => k.api_key === api_key)) {
    return res.send('<script>alert("API Key exists!"); window.location="/keys";</script>');
  }
  
  const expiry_date = new Date();
  expiry_date.setDate(expiry_date.getDate() + parseInt(expiry_days || 30));
  
  keys.push({
    id: Date.now(),
    owner_name,
    api_key,
    expiry_days: parseInt(expiry_days || 30),
    expiry_date: expiry_date.toISOString().split('T')[0],
    daily_limit: parseInt(daily_limit || 100),
    total_limit: parseInt(total_limit || 10000),
    status: 'active',
    request_count: 0,
    today_requests: 0,
    today_date: null,
    last_used: null,
    created_at: new Date().toISOString()
  });
  
  writeJSON('api_keys.json', keys);
  res.redirect('/keys');
});

app.get('/keys/toggle/:id', requireAuth, (req, res) => {
  const keys = readJSON('api_keys.json');
  const key = keys.find(k => k.id == req.params.id);
  if (key) {
    key.status = key.status === 'active' ? 'disabled' : 'active';
    writeJSON('api_keys.json', keys);
  }
  res.redirect('/keys');
});

app.get('/keys/delete/:id', requireAuth, (req, res) => {
  let keys = readJSON('api_keys.json');
  keys = keys.filter(k => k.id != req.params.id);
  writeJSON('api_keys.json', keys);
  res.redirect('/keys');
});

app.get('/keys/reset/:id', requireAuth, (req, res) => {
  const keys = readJSON('api_keys.json');
  const key = keys.find(k => k.id == req.params.id);
  if (key) {
    key.request_count = 0;
    key.today_requests = 0;
    writeJSON('api_keys.json', keys);
  }
  res.redirect('/keys');
});

app.post('/keys/extend/:id', requireAuth, (req, res) => {
  const { days } = req.body;
  const keys = readJSON('api_keys.json');
  const key = keys.find(k => k.id == req.params.id);
  if (key) {
    const newDate = new Date(key.expiry_date);
    newDate.setDate(newDate.getDate() + parseInt(days));
    key.expiry_date = newDate.toISOString().split('T')[0];
    key.expiry_days += parseInt(days);
    key.status = 'active';
    writeJSON('api_keys.json', keys);
  }
  res.redirect('/keys');
});

app.post('/keys/edit/:id', requireAuth, (req, res) => {
  const { owner_name, daily_limit, total_limit } = req.body;
  const keys = readJSON('api_keys.json');
  const key = keys.find(k => k.id == req.params.id);
  if (key) {
    key.owner_name = owner_name;
    key.daily_limit = parseInt(daily_limit);
    key.total_limit = parseInt(total_limit);
    writeJSON('api_keys.json', keys);
  }
  res.redirect('/keys');
});

// ============ LOGS ============

app.get('/logs', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const status = req.query.status || '';
  const limit = 50;
  
  let logs = readJSON('request_logs.json');
  
  if (search) {
    logs = logs.filter(l =>
      (l.api_key && l.api_key.includes(search)) ||
      (l.vehicle_number && l.vehicle_number.includes(search)) ||
      (l.owner_name && l.owner_name.toLowerCase().includes(search.toLowerCase()))
    );
  }
  
  if (status) {
    logs = logs.filter(l => l.response_status === status);
  }
  
  logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const total = logs.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const pagedLogs = logs.slice(offset, offset + limit);
  
  res.render('logs', { logs: pagedLogs, page, search, status, totalPages, admin: req.session.admin });
});

app.get('/logs/delete/:id', requireAuth, (req, res) => {
  let logs = readJSON('request_logs.json');
  logs = logs.filter(l => l.id != req.params.id);
  writeJSON('request_logs.json', logs);
  res.redirect('/logs');
});

app.get('/logs/clear', requireAuth, (req, res) => {
  writeJSON('request_logs.json', []);
  res.redirect('/logs');
});

app.get('/logs/export', requireAuth, (req, res) => {
  const logs = readJSON('request_logs.json');
  let csv = 'ID,API Key,Owner,Vehicle,IP,Status,Time,Date\n';
  logs.forEach(l => {
    csv += `${l.id},"${l.api_key}","${l.owner_name}","${l.vehicle_number}","${l.ip_address}","${l.response_status}","${l.created_at}"\n`;
  });
  res.header('Content-Type', 'text/csv');
  res.attachment('request_logs.csv');
  res.send(csv);
});

// ============ ANALYTICS ============

app.get('/analytics', requireAuth, (req, res) => {
  const logs = readJSON('request_logs.json');
  const keys = readJSON('api_keys.json');
  
  // Top keys
  const keyUsage = {};
  logs.forEach(l => {
    if (l.api_key) keyUsage[l.api_key] = (keyUsage[l.api_key] || 0) + 1;
  });
  const topKeys = Object.entries(keyUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([api_key, count]) => {
      const key = keys.find(k => k.api_key === api_key);
      return { api_key, owner_name: key ? key.owner_name : 'Unknown', count };
    });
  
  // Top vehicles
  const vehicleUsage = {};
  logs.forEach(l => {
    if (l.vehicle_number) vehicleUsage[l.vehicle_number] = (vehicleUsage[l.vehicle_number] || 0) + 1;
  });
  const topVehicles = Object.entries(vehicleUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([vehicle_number, count]) => ({ vehicle_number, count }));
  
  // Avg response time
  const successLogs = logs.filter(l => l.response_status === 'success' && l.response_time_ms);
  const avgTime = successLogs.length > 0 
    ? Math.round(successLogs.reduce((sum, l) => sum + l.response_time_ms, 0) / successLogs.length)
    : 0;
  
  // Hourly data
  const today = new Date().toISOString().split('T')[0];
  const hourlyData = [];
  for (let i = 0; i < 24; i++) {
    const count = logs.filter(l => {
      if (!l.created_at || !l.created_at.startsWith(today)) return false;
      const hour = new Date(l.created_at).getHours();
      return hour === i;
    }).length;
    hourlyData.push({ hour: i, count });
  }
  
  res.render('analytics', {
    topKeys,
    topVehicles,
    avgTime,
    hourlyData: JSON.stringify(hourlyData),
    admin: req.session.admin
  });
});

// ============ SETTINGS ============

app.get('/settings', requireAuth, (req, res) => {
  const settings = readJSON('settings.json');
  res.render('settings', { settings, success: req.query.success, admin: req.session.admin });
});

app.post('/settings', requireAuth, (req, res) => {
  const { site_name, maintenance_mode, api_enabled, theme, api_base_url } = req.body;
  const settings = {
    id: 1,
    site_name: site_name || 'Vehicle Admin',
    maintenance_mode: maintenance_mode === 'on',
    api_base_url: api_base_url || 'https://vehicleinfo.noobgamingv40.workers.dev/fetch',
    theme: theme || 'light',
    api_enabled: api_enabled === 'on'
  };
  writeJSON('settings.json', settings);
  res.redirect('/settings?success=1');
});

// ============ ADMINS ============

app.get('/admins', requireAuth, (req, res) => {
  const admins = readJSON('admins.json');
  res.render('admins', { admins, admin: req.session.admin });
});

app.post('/admins/create', requireAuth, (req, res) => {
  const { username, password } = req.body;
  const admins = readJSON('admins.json');
  
  if (admins.find(a => a.username === username)) {
    return res.redirect('/admins?error=exists');
  }
  
  const hash = bcrypt.hashSync(password, 10);
  admins.push({
    id: Date.now(),
    username,
    password: hash,
    created_at: new Date().toISOString()
  });
  writeJSON('admins.json', admins);
  res.redirect('/admins?success=1');
});

app.get('/admins/delete/:id', requireAuth, (req, res) => {
  if (req.session.admin.id == req.params.id) {
    return res.redirect('/admins?error=self');
  }
  let admins = readJSON('admins.json');
  admins = admins.filter(a => a.id != req.params.id);
  writeJSON('admins.json', admins);
  res.redirect('/admins');
});

app.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  const admins = readJSON('admins.json');
  const admin = admins.find(a => a.id == req.session.admin.id);
  
  if (admin && bcrypt.compareSync(current_password, admin.password)) {
    admin.password = bcrypt.hashSync(new_password, 10);
    writeJSON('admins.json', admins);
    res.redirect('/settings?password=changed');
  } else {
    res.redirect('/settings?password=error');
  }
});

// ============ API ENDPOINT ============

app.get('/api/fetch', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const vehicle = req.query.vehicle;
  const settings = readJSON('settings.json');
  
  // Maintenance mode
  if (settings.maintenance_mode) {
    logRequest(apiKey, vehicle, req, 'maintenance', 0);
    return res.json({ success: false, message: 'System under maintenance' });
  }
  
  // API Toggle OFF
  if (!settings.api_enabled) {
    logRequest(apiKey, vehicle, req, 'api_off', 0);
    return res.json({
      success: true,
      message: 'API is disabled by admin',
      data: {
        vehicle_number: vehicle || 'N/A',
        status: 'api_disabled',
        note: 'API turned OFF from admin panel. Dummy response.'
      }
    });
  }
  
  if (!apiKey || !vehicle) {
    return res.json({ success: false, message: 'Missing x-api-key or vehicle' });
  }
  
  const keys = readJSON('api_keys.json');
  const key = keys.find(k => k.api_key === apiKey);
  
  if (!key) {
    logRequest(apiKey, vehicle, req, 'invalid_key', 0);
    return res.json({ success: false, message: 'Invalid API Key' });
  }
  
  if (key.status === 'expired' || new Date(key.expiry_date) < new Date()) {
    key.status = 'expired';
    writeJSON('api_keys.json', keys);
    logRequest(apiKey, vehicle, req, 'expired', 0);
    return res.json({ success: false, message: 'API Key Expired' });
  }
  
  if (key.status === 'disabled') {
    logRequest(apiKey, vehicle, req, 'disabled', 0);
    return res.json({ success: false, message: 'API Key Disabled' });
  }
  
  const today = new Date().toISOString().split('T')[0];
  if (key.today_date !== today) {
    key.today_requests = 0;
    key.today_date = today;
  }
  
  if (key.today_requests >= key.daily_limit) {
    logRequest(apiKey, vehicle, req, 'rate_limit', 0);
    return res.json({ success: false, message: 'Daily limit exceeded' });
  }
  
  // Real API call
  const startTime = Date.now();
  axios.get(`${settings.api_base_url}?vehicle=${vehicle}`, { timeout: 10000 })
    .then(response => {
      const responseTime = Date.now() - startTime;
      key.request_count++;
      key.today_requests++;
      key.last_used = new Date().toISOString();
      writeJSON('api_keys.json', keys);
      logRequest(apiKey, vehicle, req, 'success', responseTime, key.owner_name);
      res.json(response.data);
    })
    .catch(err => {
      logRequest(apiKey, vehicle, req, 'failed', 0, key.owner_name);
      res.json({ success: false, message: 'Upstream API error' });
    });
});

function logRequest(apiKey, vehicle, req, status, responseTime, ownerName) {
  const logs = readJSON('request_logs.json');
  logs.push({
    id: Date.now(),
    api_key: apiKey || 'N/A',
    owner_name: ownerName || 'N/A',
    vehicle_number: vehicle || 'N/A',
    ip_address: req.ip || 'N/A',
    user_agent: req.headers['user-agent'] || 'N/A',
    response_status: status,
    response_time_ms: responseTime,
    created_at: new Date().toISOString()
  });
  // Keep only last 10000 logs
  if (logs.length > 10000) {
    logs.splice(0, logs.length - 10000);
  }
  writeJSON('request_logs.json', logs);
}

// Auto-expire checker
setInterval(() => {
  const keys = readJSON('api_keys.json');
  let changed = false;
  const today = new Date().toISOString().split('T')[0];
  keys.forEach(k => {
    if (k.status === 'active' && k.expiry_date < today) {
      k.status = 'expired';
      changed = true;
    }
  });
  if (changed) writeJSON('api_keys.json', keys);
}, 60000);

// ============ START ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Vehicle Admin running on http://localhost:${PORT}`);
  console.log(`👤 Login: superadmin / aura@1234`);
});
