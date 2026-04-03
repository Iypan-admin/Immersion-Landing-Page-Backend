require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 5000;

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://immersion-landing-page-production.up.railway.app',
  'https://immersion.indianschoolformodernlanguages.com',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    console.error('CORS blocked:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
  credentials: true,
}));
app.options('*', cors());
app.use(express.json());

// ── DB ────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Run once on startup: add ame_code column if it doesn't exist ──
// This is safe to run repeatedly — ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent
async function runMigrations() {
  try {
    await pool.query(`
      ALTER TABLE affiliates
      ADD COLUMN IF NOT EXISTS ame_code VARCHAR(50) DEFAULT NULL;
    `);
    console.log('✅ Migration: ame_code column ready');
  } catch (err) {
    console.error('Migration warning (non-fatal):', err.message);
  }
}
runMigrations();

// ══════════════════════════════════════════════════════════════
// DATA FIX — run this SQL ONCE in your Railway/Postgres console
// to correct the affiliates whose ame_code and referred_by were
// entered swapped before the form bug was fixed:
//
// UPDATE affiliates
// SET
//   ame_code    = referred_by,
//   referred_by = ame_code
// WHERE ame_code IS NOT NULL OR referred_by IS NOT NULL;
//
// After running it, verify in the admin table that:
//   AME Code column  → shows internal employee codes (e.g. IYPIN003)
//   Referred By (AP) → shows affiliate codes (e.g. TUL995)
// ══════════════════════════════════════════════════════════════

// ── Admin password middleware ─────────────────────────────────
function adminAuth(req, res, next) {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Helper: generate ref code ─────────────────────────────────
function generateRefCode(name) {
  const prefix = name.trim().slice(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${prefix}${suffix}`;
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: '🚀 ISML API running' });
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /api/leads — submit enquiry form
// THE FIX: referral field was never being saved because the frontend
// wasn't sending it. Frontend now sends { ...form, referral: refCode }.
app.post('/api/leads', async (req, res) => {
  const { name, email, phone, language, level, referral } = req.body;

  if (!name || !email || !phone || !language || !level) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Save lead — referral stores the ?ref= code from the URL
    const leadResult = await pool.query(
      `INSERT INTO leads (name, email, phone, language, level, referral)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), email.trim(), phone.trim(), language, level, referral || null]
    );
    const lead = leadResult.rows[0];

    // If referral code exists, create payout records for the affiliate chain
    if (referral) {
      const affResult = await pool.query(
        `SELECT * FROM affiliates WHERE ref_code = $1`, [referral]
      );

      if (affResult.rows.length > 0) {
        const affiliate = affResult.rows[0];

        // Level 1 payout — direct affiliate (₹200)
        await pool.query(
          `INSERT INTO payouts (influencer_ref_code, influencer_name, customer_name, customer_email, lead_id, amount, level, status)
           VALUES ($1, $2, $3, $4, $5, 200.00, 1, 'PENDING')`,
          [affiliate.ref_code, affiliate.name, name, email, lead.id]
        );

        // Level 2 payout — who referred the affiliate (₹50)
        // This is the AP code chain: if this affiliate was referred_by another affiliate
        if (affiliate.referred_by) {
          const parentResult = await pool.query(
            `SELECT * FROM affiliates WHERE ref_code = $1`, [affiliate.referred_by]
          );
          if (parentResult.rows.length > 0) {
            const parent = parentResult.rows[0];
            await pool.query(
              `INSERT INTO payouts (influencer_ref_code, influencer_name, customer_name, customer_email, lead_id, amount, level, status)
               VALUES ($1, $2, $3, $4, $5, 50.00, 2, 'PENDING')`,
              [parent.ref_code, parent.name, name, email, lead.id]
            );
          }
        }
      }
    }

    res.status(201).json({ success: true, lead });
  } catch (err) {
    console.error('DB error:', err.message);
    res.status(500).json({ error: 'Failed to submit enquiry. Please try again.' });
  }
});

// GET /api/validate-ref/:code — check if referral code is valid
app.get('/api/validate-ref/:code', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, ref_code FROM affiliates WHERE ref_code = $1`, [req.params.code]
    );
    if (result.rows.length === 0) return res.json({ valid: false });
    res.json({ valid: true, name: result.rows[0].name });
  } catch (err) {
    res.status(500).json({ valid: false });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

// POST /admin/get-leads
app.post('/admin/get-leads', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM leads ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// POST /admin/download-leads — CSV export
app.post('/admin/download-leads', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM leads ORDER BY created_at DESC`);
    const rows = result.rows;
    const headers = ['id', 'name', 'email', 'phone', 'language', 'level', 'referral', 'created_at'];
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => `"${(r[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// POST /admin/get-affiliates — now returns ame_code too
app.post('/admin/get-affiliates', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.*,
        COUNT(CASE WHEN p.status = 'PENDING' THEN 1 END) as pending_count,
        COUNT(CASE WHEN p.status = 'PAID' THEN 1 END)    as paid_count,
        COALESCE(SUM(CASE WHEN p.status = 'PENDING' THEN p.amount ELSE 0 END), 0) as pending_payout,
        COALESCE(SUM(CASE WHEN p.status = 'PAID'    THEN p.amount ELSE 0 END), 0) as paid_payout,
        COALESCE(SUM(p.amount), 0) as total_earnings,
        COUNT(CASE WHEN p.level = 1 THEN 1 END) as success
      FROM affiliates a
      LEFT JOIN payouts p ON a.ref_code = p.influencer_ref_code
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch affiliates' });
  }
});

// POST /admin/create-affiliate — now accepts ame_code + referred_by (AP code)
app.post('/admin/create-affiliate', adminAuth, async (req, res) => {
  const { name, email, phone, ame_code, referred_by } = req.body;
  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Name, email and phone are required' });
  }
  try {
    // Generate unique ref code
    let ref_code, attempts = 0;
    do {
      ref_code = generateRefCode(name);
      const exists = await pool.query(`SELECT id FROM affiliates WHERE ref_code = $1`, [ref_code]);
      if (exists.rows.length === 0) break;
      attempts++;
    } while (attempts < 10);

    const result = await pool.query(
      `INSERT INTO affiliates (name, email, phone, ref_code, ame_code, referred_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        name.trim(),
        email.trim(),
        phone.trim(),
        ref_code,
        ame_code?.trim() || null,    // internal employee who hired this affiliate
        referred_by?.trim() || null, // existing affiliate who recommended this person
      ]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'https://immersion.indianschoolformodernlanguages.com';
    const link = `${frontendUrl}/?ref=${ref_code}`;

    res.json({ success: true, affiliate: result.rows[0], ref_code, link });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Affiliate already exists' });
    res.status(500).json({ error: 'Failed to create affiliate: ' + err.message });
  }
});

// POST /admin/edit-affiliate — now updates ame_code too
app.post('/admin/edit-affiliate', adminAuth, async (req, res) => {
  const { ref_code, name, email, phone, ame_code, referred_by } = req.body;
  try {
    await pool.query(
      `UPDATE affiliates
       SET name=$1, email=$2, phone=$3, ame_code=$4, referred_by=$5
       WHERE ref_code=$6`,
      [
        name,
        email,
        phone,
        ame_code?.trim() || null,
        referred_by?.trim() || null,
        ref_code,
      ]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update affiliate' });
  }
});

// POST /admin/get-payouts
app.post('/admin/get-payouts', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM payouts ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// POST /admin/mark-payout-paid
app.post('/admin/mark-payout-paid', adminAuth, async (req, res) => {
  const { payout_id, amount } = req.body;
  try {
    if (amount !== undefined && amount !== null) {
      await pool.query(
        `UPDATE payouts SET status='PAID', paid_at=NOW(), amount=$1 WHERE id=$2`,
        [parseFloat(amount), payout_id]
      );
    } else {
      await pool.query(
        `UPDATE payouts SET status='PAID', paid_at=NOW() WHERE id=$1`,
        [payout_id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update payout' });
  }
});

// POST /admin/mark-all-paid
app.post('/admin/mark-all-paid', adminAuth, async (req, res) => {
  const { ref_code, amounts } = req.body;
  try {
    if (amounts && typeof amounts === 'object' && Object.keys(amounts).length > 0) {
      const updates = Object.entries(amounts).map(([id, amt]) =>
        pool.query(
          `UPDATE payouts SET status='PAID', paid_at=NOW(), amount=$1 WHERE id=$2 AND status='PENDING'`,
          [parseFloat(amt) || 0, parseInt(id)]
        )
      );
      await Promise.all(updates);
    } else {
      await pool.query(
        `UPDATE payouts SET status='PAID', paid_at=NOW()
         WHERE influencer_ref_code=$1 AND status='PENDING'`,
        [ref_code]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update payouts' });
  }
});

// POST /admin/download-payouts — CSV
app.post('/admin/download-payouts', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM payouts ORDER BY created_at DESC`);
    const rows = result.rows;
    const headers = ['id', 'influencer_ref_code', 'influencer_name', 'customer_name', 'customer_email', 'lead_id', 'amount', 'level', 'status', 'paid_at', 'created_at'];
    const csv = [
      headers.join(','),
      ...rows.map(r => headers.map(h => `"${(r[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payouts.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${port}`);
});
