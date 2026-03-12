require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 5000;

// ── CORS Configuration ──
// Explicitly allowing your local environments and your live Railway frontend
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://immersion-landing-page-production.up.railway.app', // Your live frontend URL
  process.env.FRONTEND_URL // Fallback if set in Railway variables
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());

// ── Database Connection ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── API Routes ──
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
    const values = [name, email, phone, language, level];
    
    const result = await pool.query(query, values);
    
    console.log('Lead saved successfully:', result.rows[0]);
    res.status(201).json({ success: true, lead: result.rows[0] });
    
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ error: 'Failed to submit enquiry' });
  }
});

// ── Start Server ──
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});