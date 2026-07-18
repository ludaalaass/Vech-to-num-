require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const path = require('path');

const app = express();

// Database Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'vehicle_admin',
  waitForConnections: true,
  connectionLimit: 10
});

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

// Initialize DB
async function initDB() {
  const conn = await pool.getConnection();
  await conn.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) UNIQUE,
      password VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      owner_name VARCHAR(100),
      api_key VARCHAR(64) UNIQUE,
      expiry_days INT DEFAULT 30,
      expiry_date DATE,
      daily_limit INT DEFAULT 100,
      total_limit INT DEFAULT 10000,
      status ENUM('active','disabled','expired') DEFAULT 'active',
      request_count INT DEFAULT 0,
      today_requests INT DEFAULT 0,
      today_date DATE,
      last_used TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      api_key VARCHAR(64),
      owner_name VARCHAR(100),
      vehicle_number VARCHAR(20),
      ip_address VARCHAR(45),
      user_agent TEXT,
      response_status VARCHAR(10),
      response_time_ms INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INT PRIMARY KEY DEFAULT 1,
      site_name VARCHAR(100) DEFAULT 'Vehicle Admin',
      maintenance_mode BOOLEAN DEFAULT FALSE,
      api_base_url VARCHAR(255) DEFAULT 'https://vehicleinfo.noobgamingv40.workers.dev/fetch',
      theme VARCHAR(10) DEFAULT 'light',
      api_enabled BOOLEAN DEFAULT TRUE
    )
  `);
  
  // Default admin
  const hash = await bcrypt.hash('aura@1234', 10);
  await conn.query(`INSERT IGNORE INTO admins (username, password) VALUES ('superadmin', ?)`, [hash]);
  await conn.query(`INSERT IGNORE INTO settings (id) VALUES (1)`);
  conn.release();
}
initDB();

// Auth Middleware
const requireAuth = (req, res, next) => {
  if (!req.session.admin) return res.redirect('/login');
  next();
};

// ============ AUTH ROUTES ============

app.get('/login', (req, res) => {
  res.render('login', { error: null, theme: 'light' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
  if (rows.length && await bcrypt.compare(password, rows[0].password)) {
    req.session.admin = rows[0];
    return res.redirect('/');
  }
  res.render('login', { error: 'Invalid credentials', theme: 'light' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ============ DASHBOARD ============

app.get('/', requireAuth, async (req, res) => {
  const [settings] = await pool.query('SELECT * FROM settings WHERE id=1');
  const [totalReq] = await pool.query('SELECT COUNT(*) as count FROM request_logs');
  const [todayReq] = await pool.query('SELECT COUNT(*) as count FROM request_logs WHERE DATE(created_at) = CURDATE()');
  const [monthReq] = await pool.query('SELECT COUNT(*) as count FROM request_logs WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())');
  const [totalKeys] = await pool.query('SELECT COUNT(*) as count FROM api_keys');
  const [activeKeys] = await pool.query("SELECT COUNT(*) as count FROM api_keys WHERE status='active'");
  const [expiredKeys] = await pool.query("SELECT COUNT(*) as count FROM api_keys WHERE status='expired'");
  const [disabledKeys] = await pool.query("SELECT COUNT(*) as count FROM api_keys WHERE status='disabled'");
  const [totalAdmins] = await pool.query('SELECT COUNT(*) as count FROM admins');
  
  // Charts data
  const [dailyData] = await pool.query(`
    SELECT DATE(created_at) as date, COUNT(*) as count 
    FROM request_logs 
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) 
    GROUP BY DATE(created_at)
    ORDER BY DATE(created_at)
  `);
  
  const [monthlyData] = await pool.query(`
    SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count 
    FROM request_logs 
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) 
    GROUP BY month
    ORDER BY month
  `);
  
  const [topKeys] = await pool.query(`
    SELECT api_key, owner_name, COUNT(*) as count 
    FROM request_logs 
    GROUP BY api_key, owner_name 
    ORDER BY count DESC 
    LIMIT 10
  `);
  
  const [successFailed] = await pool.query(`
    SELECT response_status, COUNT(*) as count 
    FROM request_logs 
    GROUP BY response_status
  `);
  
  const [topVehicles] = await pool.query(`
    SELECT vehicle_number, COUNT(*) as count 
    FROM request_logs 
    GROUP BY vehicle_number 
    ORDER BY count DESC 
    LIMIT 10
  `);
  
  res.render('dashboard', {
    stats: {
      total: totalReq[0].count,
      today: todayReq[0].count,
      month: monthReq[0].count,
      totalKeys: totalKeys[0].count,
      activeKeys: activeKeys[0].count,
      expiredKeys: expiredKeys[0].count,
      disabledKeys: disabledKeys[0].count,
      totalAdmins: totalAdmins[0].count,
      apiStatus: settings[0].api_enabled ? 'Online' : 'Offline',
      maintenance: settings[0].maintenance_mode ? 'ON' : 'OFF'
    },
    dailyData: JSON.stringify(dailyData),
    monthlyData: JSON.stringify(monthlyData),
    topKeys: JSON.stringify(topKeys),
    successFailed: JSON.stringify(successFailed),
    topVehicles: JSON.stringify(topVehicles),
    settings: settings[0],
    admin: req.session.admin
  });
});

// ============ API KEYS MANAGEMENT ============

app.get('/keys', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const limit = 20;
  const offset = (page - 1) * limit;
  
  let query = 'SELECT * FROM api_keys';
  let countQuery = 'SELECT COUNT(*) as count FROM api_keys';
  const params = [];
  
  if (search) {
    query += ' WHERE owner_name LIKE ? OR api_key LIKE ?';
    countQuery += ' WHERE owner_name LIKE ? OR api_key LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ?, ?';
  const [keys] = await pool.query(query, [...params, offset, limit]);
  const [total] = await pool.query(countQuery, params);
  
  res.render('keys', { 
    keys, 
    page, 
    search,
    totalPages: Math.ceil(total[0].count / limit),
    admin: req.session.admin 
  });
});

app.post('/keys/generate', requireAuth, async (req, res) => {
  const { owner_name, expiry_days, daily_limit, total_limit, custom_key } = req.body;
  const api_key = custom_key || uuidv4().replace(/-/g, '').substring(0, 32);
  const expiry_date = new Date();
  expiry_date.setDate(expiry_date.getDate() + parseInt(expiry_days || 30));
  
  // Check duplicate
  const [existing] = await pool.query('SELECT id FROM api_keys WHERE api_key = ?', [api_key]);
  if (existing.length) {
    return res.send('<script>alert("API Key already exists!"); window.location="/keys";</script>');
  }
  
  await pool.query(
    'INSERT INTO api_keys (owner_name, api_key, expiry_days, expiry_date, daily_limit, total_limit) VALUES (?,?,?,?,?,?)',
    [owner_name, api_key, expiry_days, expiry_date, daily_limit, total_limit]
  );
  res.redirect('/keys');
});

app.get('/keys/toggle/:id', requireAuth, async (req, res) => {
  const [key] = await pool.query('SELECT * FROM api_keys WHERE id = ?', [req.params.id]);
  if (!key.length) return res.redirect('/keys');
  
  const newStatus = key[0].status === 'active' ? 'disabled' : 'active';
  await pool.query('UPDATE api_keys SET status = ? WHERE id = ?', [newStatus, req.params.id]);
  res.redirect('/keys');
});

app.get('/keys/delete/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM api_keys WHERE id = ?', [req.params.id]);
  res.redirect('/keys');
});

app.get('/keys/reset/:id', requireAuth, async (req, res) => {
  await pool.query('UPDATE api_keys SET request_count = 0, today_requests = 0 WHERE id = ?', [req.params.id]);
  res.redirect('/keys');
});

app.post('/keys/extend/:id', requireAuth, async (req, res) => {
  const { days } = req.body;
  const [key] = await pool.query('SELECT * FROM api_keys WHERE id = ?', [req.params.id]);
  if (!key.length) return res.redirect('/keys');
  
  const newDate = new Date(key[0].expiry_date);
  newDate.setDate(newDate.getDate() + parseInt(days));
  
  await pool.query(
    'UPDATE api_keys SET expiry_date = ?, expiry_days = expiry_days + ?, status = "active" WHERE id = ?', 
    [newDate, days, req.params.id]
  );
  res.redirect('/keys');
});

app.post('/keys/edit/:id', requireAuth, async (req, res) => {
  const { owner_name, daily_limit, total_limit } = req.body;
  await pool.query(
    'UPDATE api_keys SET owner_name = ?, daily_limit = ?, total_limit = ? WHERE id = ?',
    [owner_name, daily_limit, total_limit, req.params.id]
  );
  res.redirect('/keys');
});

// ============ REQUEST LOGS ============

app.get('/logs', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const search = req.query.search || '';
  const status = req.query.status || '';
  const limit = 50;
  const offset = (page - 1) * limit;
  
  let where = [];
  let params = [];
  
  if (search) {
    where.push('(api_key LIKE ? OR vehicle_number LIKE ? OR owner_name LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    where.push('response_status = ?');
    params.push(status);
  }
  
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  
  const [logs] = await pool.query(
    `SELECT * FROM request_logs ${whereClause} ORDER BY created_at DESC LIMIT ?, ?`,
    [...params, offset, limit]
  );
  const [total] = await pool.query(
    `SELECT COUNT(*) as count FROM request_logs ${whereClause}`,
    params
  );
  
  res.render('logs', {
    logs,
    page,
    search,
    status,
    totalPages: Math.ceil(total[0].count / limit),
    admin: req.session.admin
  });
});

app.get('/logs/delete/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM request_logs WHERE id = ?', [req.params.id]);
  res.redirect('/logs');
});

app.get('/logs/clear', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM request_logs');
  res.redirect('/logs');
});

app.get('/logs/export', requireAuth, async (req, res) => {
  const [logs] = await pool.query('SELECT * FROM request_logs ORDER BY created_at DESC LIMIT 10000');
  let csv = 'ID,API Key,Owner,Vehicle Number,IP Address,User Agent,Response Status,Response Time (ms),Timestamp\n';
  logs.forEach(l => {
    csv += `${l.id},"${l.api_key}","${l.owner_name}","${l.vehicle_number}","${l.ip_address}","${(l.user_agent || '').replace(/"/g, '""')}","${l.response_status}",${l.response_time_ms},"${l.created_at}"\n`;
  });
  res.header('Content-Type', 'text/csv');
  res.attachment('request_logs.csv');
  res.send(csv);
});

// ============ ANALYTICS ============

app.get('/analytics', requireAuth, async (req, res) => {
  const [topKeys] = await pool.query(`
    SELECT api_key, owner_name, COUNT(*) as count 
    FROM request_logs 
    GROUP BY api_key, owner_name 
    ORDER BY count DESC 
    LIMIT 20
  `);
  
  const [topVehicles] = await pool.query(`
    SELECT vehicle_number, COUNT(*) as count 
    FROM request_logs 
    GROUP BY vehicle_number 
    ORDER BY count DESC 
    LIMIT 20
  `);
  
  const [avgResponse] = await pool.query(`
    SELECT AVG(response_time_ms) as avg_time 
    FROM request_logs 
    WHERE response_status = 'success'
  `);
  
  const [hourlyData] = await pool.query(`
    SELECT HOUR(created_at) as hour, COUNT(*) as count 
    FROM request_logs 
    WHERE created_at >= CURDATE()
    GROUP BY HOUR(created_at)
    ORDER BY hour
  `);
  
  res.render('analytics', {
    topKeys,
    topVehicles,
    avgTime: Math.round(avgResponse[0].avg_time || 0),
    hourlyData: JSON.stringify(hourlyData),
    admin: req.session.admin
  });
});

// ============ SETTINGS ============

app.get('/settings', requireAuth, async (req, res) => {
  const [settings] = await pool.query('SELECT * FROM settings WHERE id=1');
  res.render('settings', { 
    settings: settings[0], 
    success: req.query.success,
    admin: req.session.admin 
  });
});

app.post('/settings', requireAuth, async (req, res) => {
  const { site_name, maintenance_mode, api_enabled, theme, api_base_url } = req.body;
  await pool.query(
    'UPDATE settings SET site_name=?, maintenance_mode=?, api_enabled=?, theme=?, api_base_url=? WHERE id=1',
    [
      site_name, 
      maintenance_mode === 'on' ? 1 : 0, 
      api_enabled === 'on' ? 1 : 0, 
      theme || 'light',
      api_base_url
    ]
  );
  res.redirect('/settings?success=1');
});

// ============ ADMIN MANAGEMENT ============

app.get('/admins', requireAuth, async (req, res) => {
  const [admins] = await pool.query('SELECT id, username, created_at FROM admins ORDER BY created_at DESC');
  res.render('admins', { admins, admin: req.session.admin });
});

app.post('/admins/create', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query('INSERT INTO admins (username, password) VALUES (?, ?)', [username, hash]);
    res.redirect('/admins?success=1');
  } catch (err) {
    res.redirect('/admins?error=1');
  }
});

app.get('/admins/delete/:id', requireAuth, async (req, res) => {
  // Prevent deleting self
  if (req.session.admin.id == req.params.id) {
    return res.redirect('/admins?error=self');
  }
  await pool.query('DELETE FROM admins WHERE id = ?', [req.params.id]);
  res.redirect('/admins');
});

app.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  const [admin] = await pool.query('SELECT * FROM admins WHERE id = ?', [req.session.admin.id]);
  
  if (await bcrypt.compare(current_password, admin[0].password)) {
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE admins SET password = ? WHERE id = ?', [hash, req.session.admin.id]);
    res.redirect('/settings?password=changed');
  } else {
    res.redirect('/settings?password=error');
  }
});

// ============ API ENDPOINT ============

app.get('/api/fetch', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const vehicle = req.query.vehicle;
  
  // Get settings
  const [settings] = await pool.query('SELECT * FROM settings WHERE id=1');
  const config = settings[0];
  
  // Maintenance Mode Check
  if (config.maintenance_mode) {
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey || 'N/A', 'N/A', vehicle || 'N/A', req.ip, req.headers['user-agent'], 'maintenance', 0]
    );
    return res.json({ 
      success: false, 
      message: 'System under maintenance. Please try later.' 
    });
  }
  
  // API Toggle Check
  if (!config.api_enabled) {
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey || 'N/A', 'N/A', vehicle || 'N/A', req.ip, req.headers['user-agent'], 'api_off', 0]
    );
    return res.json({
      success: true,
      message: 'API is currently disabled by administrator',
      data: {
        vehicle_number: vehicle || 'N/A',
        status: 'api_disabled',
        note: 'This is a dummy response. API has been turned OFF from admin panel.'
      }
    });
  }
  
  // Missing params
  if (!apiKey || !vehicle) {
    return res.json({ 
      success: false, 
      message: 'Missing x-api-key header or vehicle parameter' 
    });
  }
  
  // Validate API Key
  const [keys] = await pool.query('SELECT * FROM api_keys WHERE api_key = ?', [apiKey]);
  if (!keys.length) {
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, 'Unknown', vehicle, req.ip, req.headers['user-agent'], 'invalid_key', 0]
    );
    return res.json({ success: false, message: 'Invalid API Key' });
  }
  
  const key = keys[0];
  
  // Expiry Check
  if (key.status === 'expired' || new Date(key.expiry_date) < new Date()) {
    await pool.query("UPDATE api_keys SET status='expired' WHERE id=?", [key.id]);
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, key.owner_name, vehicle, req.ip, req.headers['user-agent'], 'expired', 0]
    );
    return res.json({ success: false, message: 'API Key Expired' });
  }
  
  // Disabled Check
  if (key.status === 'disabled') {
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, key.owner_name, vehicle, req.ip, req.headers['user-agent'], 'disabled', 0]
    );
    return res.json({ success: false, message: 'API Key Disabled' });
  }
  
  // Rate Limit Check
  const today = new Date().toISOString().split('T')[0];
  if (key.today_date !== today) {
    await pool.query('UPDATE api_keys SET today_requests=0, today_date=? WHERE id=?', [today, key.id]);
    key.today_requests = 0;
  }
  if (key.today_requests >= key.daily_limit) {
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, key.owner_name, vehicle, req.ip, req.headers['user-agent'], 'rate_limit', 0]
    );
    return res.json({ success: false, message: 'Daily limit exceeded' });
  }
  
  if (key.request_count >= key.total_limit) {
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, key.owner_name, vehicle, req.ip, req.headers['user-agent'], 'total_limit', 0]
    );
    return res.json({ success: false, message: 'Total request limit exceeded' });
  }
  
  // Make Real API Call
  try {
    const start = Date.now();
    const response = await axios.get(`${config.api_base_url}?vehicle=${vehicle}`, {
      timeout: 10000
    });
    const responseTime = Date.now() - start;
    
    // Update counters
    await pool.query(
      'UPDATE api_keys SET request_count=request_count+1, today_requests=today_requests+1, last_used=NOW(), today_date=? WHERE id=?',
      [today, key.id]
    );
    
    // Log success
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, key.owner_name, vehicle, req.ip, req.headers['user-agent'], 'success', responseTime]
    );
    
    res.json(response.data);
  } catch (err) {
    // Log failure
    await pool.query(
      'INSERT INTO request_logs (api_key, owner_name, vehicle_number, ip_address, user_agent, response_status, response_time_ms) VALUES (?,?,?,?,?,?,?)',
      [apiKey, key.owner_name, vehicle, req.ip, req.headers['user-agent'], 'failed', 0]
    );
    res.json({ success: false, message: 'Upstream API error', error: err.message });
  }
});

// ============ AUTO EXPIRE CHECKER ============

setInterval(async () => {
  try {
    await pool.query("UPDATE api_keys SET status='expired' WHERE expiry_date < CURDATE() AND status='active'");
  } catch (err) {
    console.error('Auto-expire check failed:', err.message);
  }
}, 60000); // Every 1 minute

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Vehicle Admin Panel running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
  console.log(`👤 Login: superadmin / aura@1234`);
});
