# Cost Dashboard — Overview

## Context for the Agent

CacheLane is a local MCP server + Claude Code hooks that intercepts traffic between Claude Code and `api.anthropic.com`. All session data is stored in SQLite at `~/.cachelane/cachelane.db` using `better-sqlite3`. The `cachelane stats` CLI command already reads aggregate data from this DB — see `src/storage/index.ts` and `src/server/tools.ts` for the existing query patterns. The `CachelaneStats` type in `src/storage/types.ts` defines the available fields. The CLI is in `src/cli/index.ts`. No proxy, pruner, or orchestrator code is touched by this feature.

The project already has a Next.js website in `web/` (or `app/`) deployed on Vercel. The dashboard is a **separate local server** (not the Vercel site) — a lightweight HTML page served by the CLI on `localhost:9999`.

---

## Problem Statement

CacheLane users currently have no real-time visibility into what the tool is doing. Savings information exists in the DB and is accessible via `cachelane stats` (CLI) and `cachelane_stats` (MCP tool), but:

1. The CLI output requires users to know to run it
2. There is no visual, persistent view of savings over time
3. Users cannot see the "holy shit it works" moment — the dollar amount saved this session
4. No easy way to share evidence of ROI with teammates

Headroom and tokdiet both ship dashboards. `ccusage` (community tool) has become the standard reference for per-session cost metering. Users expect to see cost in real-time.

---

## User Stories

- As a CacheLane user, I want to open a browser tab that shows how much I've saved this session so I can feel the ROI directly.
- As a developer evaluating CacheLane, I want to see a before/after comparison (tokens without vs with CacheLane) so I can decide whether to keep it.
- As a power user, I want to see the last 10 sessions at a glance to understand how CacheLane performs across different workflows.
- As a team member, I want to share a screenshot of the dashboard to show teammates the savings we're getting.

---

## Goals

- `cachelane dashboard` starts a local HTTP server on port 9999 and opens the browser
- Single-page dashboard shows: current session savings (tokens + estimated USD), all-time totals, cache hit ratio trend, last 10 sessions table, pruning activity
- Reads entirely from existing SQLite DB — no new writes, no new schema migrations needed
- Vanilla HTML + JS — no framework, no npm deps for the frontend, no build step
- Auto-refreshes every 30 seconds
- Port configurable via `--port` flag

## Non-Goals

- Cloud sync or multi-machine aggregation
- WebSocket real-time streaming (polling every 30s is sufficient)
- Authentication (local-only, no auth needed)
- Persistent dashboard process (stops when terminal closes)
- Integration into the Vercel docs site
