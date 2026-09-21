import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import { authMiddleware, JWT_SECRET } from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// --- Auth routes ---
app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be >=6 chars' });

  // check exists
  const existing = db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email);
  if (existing) return res.status(409).json({ error: 'Username or email already taken' });

  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username,email,password) VALUES (?,?,?)').run(username, email, hashed);
  const userId = result.lastInsertRowid;
  const token = jwt.sign({ id: userId, username, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: userId, username, email } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, email } = req.body;
  const identifier = username || email;
  if (!identifier || !password) return res.status(400).json({ error: 'Username/email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(identifier, identifier);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, created_at FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// --- Expense routes ---
const CATEGORIES = ['Food','Transport','Entertainment','Bills','Shopping','Health','Other'];

app.get('/api/expenses', authMiddleware, (req, res) => {
  const { month, category, search, year } = req.query;
  let query = 'SELECT * FROM expenses WHERE user_id=?';
  const params = [req.user.id];

  if (month) { // format YYYY-MM
    query += ' AND substr(date,1,7)=?';
    params.push(month);
  } else if (year) {
    query += ' AND substr(date,1,4)=?';
    params.push(year);
  }
  if (category && category !== 'All') {
    query += ' AND category=?';
    params.push(category);
  }
  if (search) {
    query += ' AND description LIKE ?';
    params.push(`%${search}%`);
  }
  query += ' ORDER BY date DESC, id DESC';
  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

app.post('/api/expenses', authMiddleware, (req, res) => {
  const { amount, description, category, date } = req.body;
  if (amount == null || !description || !category || !date) return res.status(400).json({ error: 'All fields required' });
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });

  const result = db.prepare('INSERT INTO expenses (user_id,amount,description,category,date) VALUES (?,?,?,?,?)')
    .run(req.user.id, numAmount, description.trim(), category, date);
  const expense = db.prepare('SELECT * FROM expenses WHERE id=?').get(result.lastInsertRowid);
  res.status(201).json(expense);
});

app.put('/api/expenses/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const existing = db.prepare('SELECT * FROM expenses WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const { amount, description, category, date } = req.body;
  const numAmount = amount != null ? parseFloat(amount) : existing.amount;
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const newDesc = description != null ? description.trim() : existing.description;
  const newCat = category || existing.category;
  const newDate = date || existing.date;
  if (!CATEGORIES.includes(newCat)) return res.status(400).json({ error: 'Invalid category' });

  db.prepare('UPDATE expenses SET amount=?, description=?, category=?, date=? WHERE id=?')
    .run(numAmount, newDesc, newCat, newDate, id);
  const updated = db.prepare('SELECT * FROM expenses WHERE id=?').get(id);
  res.json(updated);
});

app.delete('/api/expenses/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id);
  const result = db.prepare('DELETE FROM expenses WHERE id=? AND user_id=?').run(id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.get('/api/expenses/stats/monthly', authMiddleware, (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();
  const rows = db.prepare(`
    SELECT substr(date,1,7) as month, SUM(amount) as total
    FROM expenses WHERE user_id=? AND substr(date,1,4)=?
    GROUP BY month ORDER BY month
  `).all(req.user.id, year);
  // ensure 12 months
  const map = Object.fromEntries(rows.map(r=>[r.month, r.total]));
  const result = [];
  for(let m=1;m<=12;m++){
    const mm = String(m).padStart(2,'0');
    const key = `${year}-${mm}`;
    result.push({ month: key, label: new Date(`${key}-01`).toLocaleString('en',{month:'short'}), total: map[key] || 0 });
  }
  res.json(result);
});

app.get('/api/expenses/stats/category', authMiddleware, (req, res) => {
  const month = req.query.month; // optional YYYY-MM
  let query = 'SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE user_id=?';
  const params=[req.user.id];
  if (month) { query+=' AND substr(date,1,7)=?'; params.push(month); }
  query+=' GROUP BY category ORDER BY total DESC';
  const rows = db.prepare(query).all(...params);
  const total = rows.reduce((a,b)=>a+b.total,0);
  res.json({ total, breakdown: rows });
});

app.get('/api/expenses/stats/summary', authMiddleware, (req, res) => {
  const now = new Date();
  const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const prev = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  const curTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE user_id=? AND substr(date,1,7)=?').get(req.user.id, curMonth).total;
  const prevTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE user_id=? AND substr(date,1,7)=?').get(req.user.id, prevMonth).total;
  const allTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM expenses WHERE user_id=?').get(req.user.id);
  res.json({ currentMonth: curMonth, currentTotal: curTotal, prevTotal, allTotal: allTotal.total, count: allTotal.count });
});

app.get('/api/categories', (req,res)=> res.json(CATEGORIES));

// SPA fallback
app.get('*', (req,res)=>{
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, ()=> console.log(`Expense Tracker running at http://localhost:${PORT}`));
}

export default app;
