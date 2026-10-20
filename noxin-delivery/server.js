const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const app = express();
const db = new DatabaseSync('noxin.db');
const API_KEY = process.env.API_KEY || 'change-me'; // staff password, set your own

const STATUSES = [
  'Registered',
  'Picked up',
  'At sorting hub',
  'In transit',
  'Arrived at destination branch',
  'Out for delivery',
  'Delivery attempted',
  'Delivered',
  'Returned to sender'
];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
CREATE TABLE IF NOT EXISTS parcels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_number TEXT UNIQUE NOT NULL,
  sender_name TEXT NOT NULL,
  sender_phone TEXT,
  receiver_name TEXT NOT NULL,
  receiver_phone TEXT,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  description TEXT,
  weight_kg REAL,
  status TEXT NOT NULL DEFAULT 'Registered',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parcel_id INTEGER NOT NULL REFERENCES parcels(id),
  status TEXT NOT NULL,
  location TEXT,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_parcel ON events(parcel_id);
`);

// Hard to guess, e.g. NX-K7Q2M9XA (no confusing characters like 0/O or 1/I)
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'NX-';
  for (const b of crypto.randomBytes(8)) code += chars[b % chars.length];
  return code;
}

// Show customers only a partial name, never phone numbers
function maskName(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
}

function requireKey(req, res, next) {
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'Invalid staff key' });
  }
  next();
}

// Public: list of valid statuses
app.get('/api/statuses', (req, res) => res.json(STATUSES));

// Staff: register a new parcel
app.post('/api/parcels', requireKey, (req, res) => {
  const { tracking_number, sender_name, sender_phone, receiver_name, receiver_phone, origin, destination, description, weight_kg } = req.body;
  if (!sender_name || !receiver_name || !origin || !destination) {
    return res.status(400).json({ error: 'Sender, receiver, origin and destination are required' });
  }
  // Staff may type their own tracking number; if left empty, one is generated
  let code;
  if (tracking_number && tracking_number.trim()) {
    code = tracking_number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,30}$/.test(code)) {
      return res.status(400).json({ error: 'Tracking number must be 4-30 letters, numbers or dashes' });
    }
    if (db.prepare('SELECT 1 FROM parcels WHERE tracking_number = ?').get(code)) {
      return res.status(409).json({ error: 'That tracking number already exists' });
    }
  } else {
    code = makeCode();
  }
  const info = db
    .prepare(
      `INSERT INTO parcels (tracking_number, sender_name, sender_phone, receiver_name, receiver_phone, origin, destination, description, weight_kg)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      code,
      sender_name,
      sender_phone || null,
      receiver_name,
      receiver_phone || null,
      origin,
      destination,
      description || null,
      weight_kg ? Number(weight_kg) : null
    );
  db.prepare('INSERT INTO events (parcel_id, status, location) VALUES (?,?,?)').run(
    info.lastInsertRowid,
    'Registered',
    origin
  );
  res.status(201).json({ tracking_number: code });
});

// Staff: add a status update to a parcel
app.post('/api/parcels/:code/events', requireKey, (req, res) => {
  const parcel = db.prepare('SELECT id FROM parcels WHERE tracking_number = ?').get(req.params.code.trim().toUpperCase());
  if (!parcel) return res.status(404).json({ error: 'Tracking number not found' });
  const { status, location, note } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('INSERT INTO events (parcel_id, status, location, note) VALUES (?,?,?,?)').run(
    parcel.id,
    status,
    location || null,
    note || null
  );
  db.prepare('UPDATE parcels SET status = ? WHERE id = ?').run(status, parcel.id);
  res.status(201).json({ ok: true });
});

// Staff: recent parcels (with optional search)
app.get('/api/parcels', requireKey, (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db
    .prepare(
      `SELECT tracking_number, sender_name, receiver_name, receiver_phone, origin, destination, status, created_at
       FROM parcels
       WHERE tracking_number LIKE ? OR receiver_name LIKE ? OR sender_name LIKE ?
       ORDER BY id DESC LIMIT 50`
    )
    .all(q, q, q);
  res.json(rows);
});

// Public: customers track a parcel
app.get('/api/track/:code', (req, res) => {
  const parcel = db
    .prepare('SELECT id, tracking_number, receiver_name, origin, destination, description, weight_kg, status, created_at FROM parcels WHERE tracking_number = ?')
    .get(req.params.code.trim().toUpperCase());
  if (!parcel) return res.status(404).json({ error: 'Tracking number not found' });
  const events = db
    .prepare('SELECT status, location, note, created_at FROM events WHERE parcel_id = ? ORDER BY id DESC')
    .all(parcel.id);
  res.json({
    tracking_number: parcel.tracking_number,
    receiver: maskName(parcel.receiver_name),
    origin: parcel.origin,
    destination: parcel.destination,
    description: parcel.description,
    weight_kg: parcel.weight_kg,
    status: parcel.status,
    created_at: parcel.created_at,
    events
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Global Delivery Services running on http://localhost:${PORT}`));
