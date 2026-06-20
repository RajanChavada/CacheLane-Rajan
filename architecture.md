# Cost Dashboard — Architecture

## Component Overview

```
cachelane dashboard --port 9999
  → DashboardServer (src/cli/dashboard.ts)
      ├── HTTP server (Node http module — no Express)
      │     ├── GET /          → serves inline HTML page
      │     └── GET /api/stats → reads DB, returns JSON
      └── opens browser (cross-platform: open/xdg-open/start)
```

## New File: `src/cli/dashboard.ts`

```typescript
export async function startDashboard(port: number): Promise<void>
```

- Creates a `http.createServer` (Node built-in, no Express)
- Handles two routes: `/` (HTML) and `/api/stats` (JSON)
- On start: detects port conflict, prints URL, opens browser
- Handles SIGINT/SIGTERM for graceful shutdown

## `/api/stats` Response Shape

```typescript
{
  current_session: {
    session_id: string,
    started_at: string,           // ISO8601
    turns: number,
    input_tokens_baseline: number,
    input_tokens_actual: number,
    reduction_pct: number,
    usd_saved_estimate: number,
    cache_hit_ratio: number,
    blocks_pruned: number,
    stubs_expanded: number,
  } | null,
  all_time: {
    total_sessions: number,
    total_input_tokens_saved: number,
    total_usd_saved_estimate: number,
  },
  recent_sessions: Array<{
    session_id: string,
    date: string,
    turns: number,
    tokens_saved: number,
    usd_saved: number,
    cache_hit_ratio: number,
  }>,
  model_pricing: {
    model: string,
    input_per_mtok: number,        // USD per million tokens
  }
}
```

## USD Pricing Table (static, in code)

```typescript
const MODEL_PRICING: Record<string, number> = {
  "claude-opus-4-8":        15.00,   // per million input tokens
  "claude-sonnet-4-6":       3.00,
  "claude-haiku-4-5":        0.80,
  // defaults to sonnet pricing if model unknown
};
```

Shown with `~` prefix always — clearly an estimate.

## HTML Page

Single file, inline everything. No external deps. Structure:
```
<head> inline CSS (dark theme, monospace, minimal) </head>
<body>
  <h1>CacheLane Dashboard</h1>
  <div id="current-session">...</div>
  <div id="all-time">...</div>
  <table id="recent-sessions">...</table>
  <span id="last-updated">...</span>
  <script>
    async function refresh() {
      const data = await fetch('/api/stats').then(r => r.json());
      // update DOM
    }
    refresh();
    setInterval(refresh, 30_000);
  </script>
</body>
```

## No New Storage Schema

All data comes from existing tables queried by the same methods as `cachelane stats`. No migrations needed.

## Cross-Platform Browser Open

```typescript
const cmd = process.platform === 'darwin' ? 'open'
           : process.platform === 'win32'  ? 'start'
           : 'xdg-open';
child_process.exec(`${cmd} http://localhost:${port}`);
```
