require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

// ── PORT — Railway REQUIRES process.env.PORT, never hardcode ──
const port = process.env.PORT || 5000;

// ── CORS Configuration ─────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://immersion-landing-page-production.up.railway.app',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.error('CORS blocked origin:', origin);
      callback(new Error(`CORS: Origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
  credentials: true,
}));

app.options('*', cors());
app.use(express.json());

// ── Database Connection ────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ── Health Check ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: '🚀 Success Learning API is running' });
});

// ── POST /api/leads ────────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  const { name, email, phone, language, level } = req.body;

  if (!name || !email || !phone || !language || !level) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const query = `
      INSERT INTO leads (name, email, phone, language, level)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const result = await pool.query(query, [name.trim(), email.trim(), phone.trim(), language, level]);
    console.log('Lead saved:', result.rows[0]);
    res.status(201).json({ success: true, lead: result.rows[0] });
  } catch (error) {
    console.error('DB error:', error.message);
    res.status(500).json({ error: 'Failed to submit enquiry. Please try again.' });
  }
});

// ── GET /api/leads (admin) ─────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC');
    res.json({ count: result.rows.length, leads: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// ── Start — bind 0.0.0.0 for Railway ──────────────────────────
app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
  console.log(`Allowed origins:`, allowedOrigins);
});
