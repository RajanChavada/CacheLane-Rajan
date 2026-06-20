# Cost Dashboard — Testing Plan

## Unit Tests

### `src/storage/__tests__/dashboard.test.ts`
| Test | Expected |
|---|---|
| getDashboardStats with no sessions | current_session: null, all_time zeros, recent_sessions: [] |
| getDashboardStats with one completed session | correct token counts, correct reduction_pct |
| getDashboardStats with 15 sessions | recent_sessions has exactly 10 entries (most recent first) |
| USD estimate calculation | `tokens_saved / 1_000_000 * price_per_mtok` correct |
| Unknown model falls back to Sonnet pricing | usd estimate uses Sonnet rate |

### `src/cli/__tests__/dashboard-server.test.ts`
| Test | Expected |
|---|---|
| GET /api/stats returns JSON with correct shape | all required fields present |
| GET / returns HTML (Content-Type: text/html) | response body contains `<html` |
| Port conflict (EADDRINUSE) | error message contains port number and `--port` suggestion |
| SIGINT handler | server closes within 1s |
| Empty DB (no sessions) | returns 200 with null current_session, not 500 |

## Manual Verification

Before shipping, verify manually:
1. `cachelane dashboard` opens browser
2. Dashboard shows data from a real 10-turn session
3. Auto-refresh fires at 30s (watch the "last updated" timestamp)
4. `Ctrl+C` in terminal stops server and browser tab shows connection refused

## Edge Cases

- DB file doesn't exist yet (first install, no sessions) — shows "Run a Claude Code session to see stats"
- Very long session (500+ turns) — query doesn't time out, stats are correct
- Multiple `cachelane dashboard` processes — second one gets port conflict error
- No default browser configured (headless server) — print URL instead of opening browser, don't crash
