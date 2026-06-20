# Cost Dashboard — Requirements

## Functional Requirements

**REQ-F-DASH-01:** `cachelane dashboard [--port 9999]` MUST start a local HTTP server and open the default browser to `http://localhost:9999`.

**REQ-F-DASH-02:** The dashboard MUST display:
- Current session: input tokens before (baseline), input tokens after (CacheLane), % reduction, estimated USD saved
- All-time: total input tokens saved, total estimated USD saved, total sessions
- Cache hit ratio for current session (as a percentage + trend indicator)
- Pruning stats: blocks pruned, stubs expanded this session
- Last 10 sessions table: date, duration, tokens saved, USD saved, cache hit %

**REQ-F-DASH-03:** USD estimates MUST use Anthropic's published pricing for the detected model (default: Claude Sonnet 4.5 input rate). MUST display as "~$X.XX" with a tilde to indicate it is an estimate.

**REQ-F-DASH-04:** The dashboard MUST auto-refresh every 30 seconds via `setInterval` polling a `/api/stats` JSON endpoint served by the same local process.

**REQ-F-DASH-05:** The `/api/stats` endpoint MUST be a JSON response reading from the existing SQLite DB using the same queries as `cachelane stats`.

**REQ-F-DASH-06:** If the DB is not accessible, the dashboard MUST show a clear error state ("No data yet — start a Claude Code session") rather than crashing.

**REQ-F-DASH-07:** `Ctrl+C` in the terminal MUST gracefully stop the server.

**REQ-F-DASH-08:** Port conflict MUST produce a clear error: "Port 9999 in use. Try: cachelane dashboard --port 9998".

**REQ-F-DASH-09:** The HTML page MUST be self-contained (inline CSS + JS) — no external CDN calls, no network requests except to `localhost:9999/api/stats`.

---

## Non-Functional Requirements

**REQ-NF-DASH-01:** `/api/stats` response MUST return in < 50ms (single synchronous SQLite read with `better-sqlite3`).

**REQ-NF-DASH-02:** The dashboard HTML+JS MUST be < 50KB total (no framework needed for this scope).

**REQ-NF-DASH-03:** Dashboard MUST work in Chrome, Firefox, and Safari.

---

## Acceptance Criteria

- [ ] `cachelane dashboard` opens browser to `http://localhost:9999`
- [ ] Page shows current session stats (or "no data" state if no sessions yet)
- [ ] Page auto-refreshes every 30 seconds
- [ ] Last 10 sessions table is populated after running 2+ Claude Code sessions
- [ ] USD estimate shown with tilde prefix
- [ ] `Ctrl+C` stops the server cleanly
- [ ] `--port 9998` starts on port 9998
- [ ] Port conflict shows actionable error message
- [ ] No external network requests from the HTML page
