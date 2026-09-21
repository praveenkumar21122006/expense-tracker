# Expense Tracker — Full-Stack

User-authenticated expense logging with categorization and monthly visualization.

**Stack:** Node.js + Express + `node:sqlite` (built-in) + JWT + bcryptjs — Vanilla JS frontend + Chart.js  
**Live:** `npm start` → http://localhost:3000  
**Repo:** https://github.com/praveenkumar21122006/expense-tracker

## Quick Start
```bash
npm install
npm start
# http://localhost:3000
# set JWT_SECRET in .env for production
```

## Features
- **Auth:** Register / Login (JWT, 7d), per-user isolation, `/api/auth/me`
- **Expenses CRUD:** amount, description, category, date — `GET/POST/PUT/DELETE /api/expenses`
- **Categories:** Food, Transport, Entertainment, Bills, Shopping, Health, Other
- **Filtering:** by month (`?month=YYYY-MM`), category, search, year
- **Visualization:**
  - Monthly bar chart (`/api/expenses/stats/monthly?year=YYYY`) — 12 months
  - Category doughnut (`/api/expenses/stats/category?month=YYYY-MM`)
  - Summary cards (`/api/expenses/stats/summary`) — this month vs last month, total

## API
| Method | Path | Auth | Body |
|---|---|---|---|
| POST | /api/auth/register | — | {username,email,password} |
| POST | /api/auth/login | — | {username|email,password} |
| GET | /api/auth/me | Bearer | — |
| GET | /api/expenses?month=&category=&search= | Bearer | — |
| POST | /api/expenses | Bearer | {amount,description,category,date} |
| PUT | /api/expenses/:id | Bearer | partial |
| DELETE | /api/expenses/:id | Bearer | — |
| GET | /api/expenses/stats/monthly | Bearer | — |
| GET | /api/expenses/stats/category | Bearer | — |
| GET | /api/expenses/stats/summary | Bearer | — |

DB file: `server/expense.db` (auto-created, gitignored).

## Frontend
Single-page `public/` — Auth view → Dashboard with stats grid, Chart.js monthly + category charts, add/edit form, searchable/filtered table.

## Deploy

### Render (recommended for Node + SQLite)
1. Connect repo to https://dashboard.render.com → New Web Service
2. Build: `npm install`  Start: `npm start`  Node 22
3. Env: `JWT_SECRET=<random>` `PORT=10000`
4. Deploy — SQLite file is ephemeral; for persistence add Render Disk at `/opt/render/project/src/server`

### Vercel
1. `vercel --prod` — uses `vercel.json` (`server/server.js` → @vercel/node)
2. Note: SQLite on Vercel is ephemeral ( /tmp ); swap to Postgres/Neon for persistence.

### Railway / Fly.io
Standard `npm start`, expose `$PORT`.

## License
MIT
