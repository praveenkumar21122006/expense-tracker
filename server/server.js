import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authMiddleware, JWT_SECRET } from './middleware.js';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// --- Auth routes ---
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be >=6 chars' });

  const existing = await db.findUserByUsernameOrEmailExists(username, email);
  if (existing) return res.status(409).json({ error: 'Username or email already taken' });

  const hashed = bcrypt.hashSync(password, 10);
  const user = await db.createUser(username, email, hashed);
  const token = jwt.sign({ id: user.id, username, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username, email } });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password, email } = req.body;
  const identifier = username || email;
  if (!identifier || !password) return res.status(400).json({ error: 'Username/email and password required' });

  const user = await db.findUserByUsernameOrEmail(identifier);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await db.findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// --- Expense routes ---
const CATEGORIES = db.CATEGORIES;

app.get('/api/expenses', authMiddleware, async (req, res) => {
  const { month, category, search, year } = req.query;
  const rows = await db.getExpenses(req.user.id, { month, category, search, year });
  res.json(rows);
});

app.post('/api/expenses', authMiddleware, async (req, res) => {
  const { amount, description, category, date } = req.body;
  if (amount == null || !description || !category || !date) return res.status(400).json({ error: 'All fields required' });
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });

  const expense = await db.createExpense(req.user.id, numAmount, description.trim(), category, date);
  res.status(201).json(expense);
});

app.put('/api/expenses/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  const existing = await db.findExpenseByIdForUser(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const { amount, description, category, date } = req.body;
  const numAmount = amount != null ? parseFloat(amount) : existing.amount;
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const newDesc = description != null ? description.trim() : existing.description;
  const newCat = category || existing.category;
  const newDate = date || existing.date;
  if (!CATEGORIES.includes(newCat)) return res.status(400).json({ error: 'Invalid category' });

  const updated = await db.updateExpense(id, req.user.id, { amount: numAmount, description: newDesc, category: newCat, date: newDate });
  res.json(updated);
});

app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  const changes = await db.deleteExpense(id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.get('/api/expenses/stats/monthly', authMiddleware, async (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();
  const result = await db.getMonthlyStats(req.user.id, year);
  res.json(result);
});

app.get('/api/expenses/stats/category', authMiddleware, async (req, res) => {
  const month = req.query.month;
  const result = await db.getCategoryStats(req.user.id, month);
  res.json(result);
});

app.get('/api/expenses/stats/summary', authMiddleware, async (req, res) => {
  const summary = await db.getSummary(req.user.id);
  res.json(summary);
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
