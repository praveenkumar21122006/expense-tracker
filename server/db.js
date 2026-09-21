import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isVercel = !!process.env.VERCEL;

// --- SQLite for local dev ---
let sqliteDb = null;

async function getSqlite() {
  if (sqliteDb) return sqliteDb;
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = path.join(__dirname, 'expense.db');
  sqliteDb = new DatabaseSync(dbPath);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
  `);
  return sqliteDb;
}

// --- Blob JSON for Vercel (persistent across serverless) ---
const BLOB_PATH = 'db.json';

async function getBlobUrl() {
  // Public store URL is deterministic: https://<store-id-without-prefix-lower>.public.blob.vercel-storage.com/db.json
  // Try to derive from env, fallback to known URL for this project
  const storeId = process.env.BLOB_STORE_ID || 'store_SzeSCeqA5jcoFycu';
  const host = storeId.replace('store_','').toLowerCase();
  // Known URL for this deployment (verified via list)
  const known = 'https://szesceqa5jcofycu.public.blob.vercel-storage.com/db.json';
  // Prefer derived but keep known as fallback
  const url = `https://${host}.public.blob.vercel-storage.com/${BLOB_PATH}`;
  return url === 'https://.public.blob.vercel-storage.com/db.json' ? known : url;
}

async function readBlob() {
  // Try direct fetch first (strongly consistent, no list eventual consistency)
  const url = await getBlobUrl();
  try {
    const res = await fetch(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (res.ok) {
      const text = await res.text();
      if (text) {
        const data = JSON.parse(text);
        return {
          users: data.users || [],
          expenses: data.expenses || [],
          nextUserId: data.nextUserId || (data.users.length ? Math.max(...data.users.map(u=>u.id))+1 : 1),
          nextExpenseId: data.nextExpenseId || (data.expenses.length ? Math.max(...data.expenses.map(e=>e.id))+1 : 1)
        };
      }
    }
    if (res.status === 404) {
      return { users: [], expenses: [], nextUserId: 1, nextExpenseId: 1 };
    }
  } catch (e) {
    console.error('readBlob direct fetch error', e.message);
  }
  // Fallback to list (eventual consistent)
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: BLOB_PATH, limit: 10 });
    const existing = blobs.find(b => b.pathname === BLOB_PATH);
    if (existing) {
      const res2 = await fetch(existing.url, { cache: 'no-store' });
      if (res2.ok) {
        const data = await res2.json();
        return {
          users: data.users || [],
          expenses: data.expenses || [],
          nextUserId: data.nextUserId || (data.users.length ? Math.max(...data.users.map(u=>u.id))+1 : 1),
          nextExpenseId: data.nextExpenseId || (data.expenses.length ? Math.max(...data.expenses.map(e=>e.id))+1 : 1)
        };
      }
    }
  } catch (e) {
    console.error('readBlob list fallback error', e.message);
  }
  return { users: [], expenses: [], nextUserId: 1, nextExpenseId: 1 };
}

async function writeBlob(data) {
  try {
    const { put } = await import('@vercel/blob');
    await put(BLOB_PATH, JSON.stringify(data), {
      access: 'public',
      allowOverwrite: true,
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 0
    });
  } catch (e) {
    console.error('writeBlob error', e.message);
    // retry once with fresh import
    const { put } = await import('@vercel/blob');
    await put(BLOB_PATH, JSON.stringify(data), {
      access: 'public',
      allowOverwrite: true,
      addRandomSuffix: false,
      cacheControlMaxAge: 0
    });
  }
}

// --- Public API (works with both backends) ---
export async function findUserByUsernameOrEmail(identifier) {
  if (isVercel) {
    const db = await readBlob();
    return db.users.find(u => u.username === identifier || u.email === identifier) || null;
  } else {
    const db = await getSqlite();
    return db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(identifier, identifier) || null;
  }
}

export async function findUserByUsernameOrEmailExists(username, email) {
  if (isVercel) {
    const db = await readBlob();
    return db.users.find(u => u.username === username || u.email === email) || null;
  } else {
    const db = await getSqlite();
    return db.prepare('SELECT id FROM users WHERE username=? OR email=?').get(username, email) || null;
  }
}

export async function findUserById(id) {
  if (isVercel) {
    const db = await readBlob();
    const u = db.users.find(x => x.id === Number(id));
    if (!u) return null;
    return { id: u.id, username: u.username, email: u.email, created_at: u.created_at };
  } else {
    const db = await getSqlite();
    return db.prepare('SELECT id, username, email, created_at FROM users WHERE id=?').get(id) || null;
  }
}

export async function createUser(username, email, passwordHash) {
  if (isVercel) {
    const db = await readBlob();
    // double-check exists (race protection)
    if (db.users.find(u => u.username === username || u.email === email)) {
      throw new Error('exists');
    }
    const id = db.nextUserId++;
    const user = { id, username, email, password: passwordHash, created_at: new Date().toISOString() };
    db.users.push(user);
    await writeBlob(db);
    return { id, username, email };
  } else {
    const db = await getSqlite();
    const result = db.prepare('INSERT INTO users (username,email,password) VALUES (?,?,?)').run(username, email, passwordHash);
    return { id: Number(result.lastInsertRowid), username, email };
  }
}

export async function getExpenses(userId, { month, category, search, year }) {
  if (isVercel) {
    const db = await readBlob();
    let rows = db.expenses.filter(e => e.user_id === Number(userId));
    if (month) rows = rows.filter(e => e.date.slice(0,7) === month);
    else if (year) rows = rows.filter(e => e.date.slice(0,4) === year);
    if (category && category !== 'All') rows = rows.filter(e => e.category === category);
    if (search) rows = rows.filter(e => e.description.toLowerCase().includes(search.toLowerCase()));
    rows.sort((a,b)=> b.date.localeCompare(a.date) || b.id - a.id);
    return rows;
  } else {
    const db = await getSqlite();
    let query = 'SELECT * FROM expenses WHERE user_id=?';
    const params = [userId];
    if (month) { query += ' AND substr(date,1,7)=?'; params.push(month); }
    else if (year) { query += ' AND substr(date,1,4)=?'; params.push(year); }
    if (category && category !== 'All') { query += ' AND category=?'; params.push(category); }
    if (search) { query += ' AND description LIKE ?'; params.push(`%${search}%`); }
    query += ' ORDER BY date DESC, id DESC';
    return db.prepare(query).all(...params);
  }
}

export async function createExpense(userId, amount, description, category, date) {
  if (isVercel) {
    const db = await readBlob();
    const id = db.nextExpenseId++;
    const exp = { id, user_id: Number(userId), amount: Number(amount), description, category, date, created_at: new Date().toISOString() };
    db.expenses.push(exp);
    await writeBlob(db);
    return exp;
  } else {
    const db = await getSqlite();
    const result = db.prepare('INSERT INTO expenses (user_id,amount,description,category,date) VALUES (?,?,?,?,?)').run(userId, amount, description, category, date);
    return db.prepare('SELECT * FROM expenses WHERE id=?').get(result.lastInsertRowid);
  }
}

export async function findExpenseByIdForUser(id, userId) {
  if (isVercel) {
    const db = await readBlob();
    return db.expenses.find(e => e.id === Number(id) && e.user_id === Number(userId)) || null;
  } else {
    const db = await getSqlite();
    return db.prepare('SELECT * FROM expenses WHERE id=? AND user_id=?').get(id, userId) || null;
  }
}

export async function updateExpense(id, userId, { amount, description, category, date }) {
  if (isVercel) {
    const db = await readBlob();
    const exp = db.expenses.find(e => e.id === Number(id) && e.user_id === Number(userId));
    if (!exp) return null;
    if (amount != null) exp.amount = Number(amount);
    if (description != null) exp.description = description;
    if (category) exp.category = category;
    if (date) exp.date = date;
    await writeBlob(db);
    return exp;
  } else {
    const db = await getSqlite();
    db.prepare('UPDATE expenses SET amount=?, description=?, category=?, date=? WHERE id=?').run(amount, description, category, date, id);
    return db.prepare('SELECT * FROM expenses WHERE id=?').get(id);
  }
}

export async function deleteExpense(id, userId) {
  if (isVercel) {
    const db = await readBlob();
    const idx = db.expenses.findIndex(e => e.id === Number(id) && e.user_id === Number(userId));
    if (idx === -1) return 0;
    db.expenses.splice(idx, 1);
    await writeBlob(db);
    return 1;
  } else {
    const db = await getSqlite();
    const result = db.prepare('DELETE FROM expenses WHERE id=? AND user_id=?').run(id, userId);
    return result.changes;
  }
}

export async function getMonthlyStats(userId, year) {
  if (isVercel) {
    const db = await readBlob();
    const rows = db.expenses.filter(e => e.user_id === Number(userId) && e.date.slice(0,4) === year);
    const map = {};
    rows.forEach(e => {
      const m = e.date.slice(0,7);
      map[m] = (map[m] || 0) + Number(e.amount);
    });
    const result = [];
    for (let m=1;m<=12;m++) {
      const mm = String(m).padStart(2,'0');
      const key = `${year}-${mm}`;
      result.push({ month: key, label: new Date(`${key}-01`).toLocaleString('en',{month:'short'}), total: map[key] || 0 });
    }
    return result;
  } else {
    const db = await getSqlite();
    const rows = db.prepare(`SELECT substr(date,1,7) as month, SUM(amount) as total FROM expenses WHERE user_id=? AND substr(date,1,4)=? GROUP BY month ORDER BY month`).all(userId, year);
    const map = Object.fromEntries(rows.map(r=>[r.month, r.total]));
    const result = [];
    for(let m=1;m<=12;m++){
      const mm = String(m).padStart(2,'0');
      const key = `${year}-${mm}`;
      result.push({ month: key, label: new Date(`${key}-01`).toLocaleString('en',{month:'short'}), total: map[key] || 0 });
    }
    return result;
  }
}

export async function getCategoryStats(userId, month) {
  if (isVercel) {
    const db = await readBlob();
    let rows = db.expenses.filter(e => e.user_id === Number(userId));
    if (month) rows = rows.filter(e => e.date.slice(0,7) === month);
    const grouped = {};
    rows.forEach(e => {
      if (!grouped[e.category]) grouped[e.category] = { category: e.category, total: 0, count: 0 };
      grouped[e.category].total += Number(e.amount);
      grouped[e.category].count += 1;
    });
    const breakdown = Object.values(grouped).sort((a,b)=>b.total-a.total);
    const total = breakdown.reduce((a,b)=>a+b.total,0);
    return { total, breakdown };
  } else {
    const db = await getSqlite();
    let query = 'SELECT category, SUM(amount) as total, COUNT(*) as count FROM expenses WHERE user_id=?';
    const params=[userId];
    if (month) { query+=' AND substr(date,1,7)=?'; params.push(month); }
    query+=' GROUP BY category ORDER BY total DESC';
    const rows = db.prepare(query).all(...params);
    const total = rows.reduce((a,b)=>a+b.total,0);
    return { total, breakdown: rows };
  }
}

export async function getSummary(userId) {
  if (isVercel) {
    const db = await readBlob();
    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const prev = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
    const curTotal = db.expenses.filter(e=>e.user_id===Number(userId) && e.date.slice(0,7)===curMonth).reduce((a,b)=>a+Number(b.amount),0);
    const prevTotal = db.expenses.filter(e=>e.user_id===Number(userId) && e.date.slice(0,7)===prevMonth).reduce((a,b)=>a+Number(b.amount),0);
    const all = db.expenses.filter(e=>e.user_id===Number(userId));
    const allTotal = all.reduce((a,b)=>a+Number(b.amount),0);
    return { currentMonth: curMonth, currentTotal: curTotal, prevTotal, allTotal, count: all.length };
  } else {
    const db = await getSqlite();
    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const prev = new Date(now.getFullYear(), now.getMonth()-1, 1);
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
    const curTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE user_id=? AND substr(date,1,7)=?').get(userId, curMonth).total;
    const prevTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE user_id=? AND substr(date,1,7)=?').get(userId, prevMonth).total;
    const allTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM expenses WHERE user_id=?').get(userId);
    return { currentMonth: curMonth, currentTotal: curTotal, prevTotal, allTotal: allTotal.total, count: allTotal.count };
  }
}

export const CATEGORIES = ['Food','Transport','Entertainment','Bills','Shopping','Health','Other'];
