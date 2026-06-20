# Cost Dashboard — Implementation Plan

**Branch:** `feat/cost-dashboard`  
**Base:** `feat/install-ux` (merged to main first) or `main`  
**Owner:** Dev 2 (Track B)  
**Estimated complexity:** Medium (3–4 days with AI assistance)  
**No conflicts with Track A** — reads DB only, no schema changes

---

## Task Order

### Task 1 — `/api/stats` query
**File:** `src/storage/index.ts`

Add `getDashboardStats()` method that returns the full `DashboardStats` shape (see `architecture.md`). Reuses existing query patterns. Unit test with a populated test DB.

---

### Task 2 — DashboardServer
**File:** `src/cli/dashboard.ts`

Implement `startDashboard(port)`:
- `http.createServer` with two routes
- Port conflict detection (try `server.listen`, catch `EADDRINUSE`)
- SIGINT/SIGTERM handler for graceful shutdown
- Cross-platform browser open

Unit tests:
- `/api/stats` returns correct JSON from DB
- Empty DB returns correct null/zero state
- Port conflict returns actionable error

---

### Task 3 — HTML page
**File:** `src/cli/dashboard-html.ts` (exports `getDashboardHtml(): string`)

Write the self-contained HTML string. Keep it < 50KB. Include:
- Current session card (with "No active session" state)
- All-time savings card
- Recent sessions table (10 rows)
- Auto-refresh every 30s
- Last updated timestamp
- Clean dark theme (matches CacheLane's terminal aesthetic)

No tests needed for HTML string — it's validated by the integration test.

---

### Task 4 — CLI command registration
**File:** `src/cli/index.ts`

Register `cachelane dashboard [--port <n>]` command. Call `startDashboard(port)`.

---

### Task 5 — Integration test
**File:** `src/cli/__tests__/dashboard.test.ts`

- Start server on random port
- Hit `/api/stats` — assert shape matches `DashboardStats` type
- Hit `/` — assert response is HTML, contains expected sections
- Send SIGINT to process — server shuts down cleanly

---

## Definition of Done

- [ ] All 5 tasks complete
- [ ] `npm test` passes
- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] Manual test: `cachelane dashboard` opens browser with live data
- [ ] `cachelane dashboard --port 9998` works
- [ ] Port conflict shows correct error message
- [ ] USD estimates display with `~$` prefix
