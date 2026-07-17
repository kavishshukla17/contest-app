# Coding Contest Platform

College coding contest platform — **Codeforces-only** imports, **Judge0** sandbox, **Passport JWT** auth, **PostgreSQL + Prisma**, **BullMQ** submission queue.

## Architecture decisions

| Challenge | Solution |
|-----------|----------|
| LeetCode/AtCoder APIs | **Not used.** Codeforces REST API only; problems cached in `problem_bank` with test cases in DB |
| Code sandboxing | **Judge0** (Docker) — never execute student code on the API server |
| Concurrent submissions | **BullMQ + Redis** queue; worker processes with configurable concurrency |
| Test case storage | `test_cases` table — judge runs offline from DB, not from Codeforces at submit time |
| Solve time reporting | `question_timings` — `opened_at` on problem click, `solved_at` on first AC |
| Auth | **Passport.js** — Local strategy (login) + JWT strategy (API routes) |

## Quick start

### 1. Start infrastructure

```bash
docker compose up -d
```

Starts: PostgreSQL, Redis, Judge0 (+ workers)

### 2. Configure server

```bash
cp server/.env.example server/.env
cd server
npm install
npm run db:generate
npm run db:push
npm run db:seed
```

### 3. Run API + worker (two terminals)

```bash
# Terminal A — API
npm run dev:server

# Terminal B — submission judge worker
npm run dev:worker --prefix server
```

### 4. Run frontend

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Demo accounts

- Teacher: `teacher@college.edu` / `teacher123`
- Student: `student@college.edu` / `student123`

## Flow

1. **Teacher** creates contest → imports Codeforces problems (by tag/rating)
2. Problems + test cases cached in PostgreSQL (`problem_bank`, `test_cases`)
3. **Student** starts contest → clicks problem → `opened_at` logged
4. Run samples (sync, sample tests only) → Submit (queued → Judge0 → hidden tests)
5. First AC sets `solved_at` → teacher report shows solve time per question

## Key tables

```
users
contests
problem_bank      ← cached Codeforces metadata
test_cases        ← stored locally after import
contest_problems  ← problems attached to a contest
participations
submissions       ← queued → running → verdict
question_timings  ← opened_at, solved_at (reporting heart)
```

## Environment

See `server/.env.example` for `DATABASE_URL`, `REDIS_URL`, `JUDGE0_URL`, `JWT_SECRET`.

## Production build

```bash
npm run build
npm run build:server
```
