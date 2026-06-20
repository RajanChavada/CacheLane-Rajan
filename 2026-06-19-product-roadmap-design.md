# CacheLane Product Roadmap Design
**Date:** 2026-06-19  
**Status:** Approved  
**Author:** Aditya Tripuraneni  

---

## Problem Statement

CacheLane has a strong technical foundation (M1–M7 complete) and a unique architectural position — the only tool in the Claude Code ecosystem that combines non-lossy K-pruning stubs with volatility-region cache orchestration. However three gaps block the next growth phase:

1. **Reliability gap** — M8 (keepalive executor) is stubbed; long sessions silently lose cache hits after TTL expiry. M9 (bulk refetch) forces multiple round-trips for multi-stub expansion.
2. **Adoption gap** — installation requires multiple manual steps; users have no real-time visibility into savings; tool-call output verbosity (the #1 pain point by community signal — RTK has 63.9k stars solving this alone) is unaddressed.
3. **Positioning gap** — competitors (Headroom, 38.4k stars) are shipping fast. CacheLane needs to establish its identity as the unified Anthropic-native pipeline before the market consolidates.

---

## Background

### Market Context

- 38,500+ Claude Code repos exist; 749 specifically target token optimization
- Top tools are single-mechanism point solutions: RTK (output filtering, 63.9k ⭐), caveman (output compression, 74.9k ⭐), Headroom (3-stage pipeline, 38.4k ⭐, Python+Rust)
- The input-side / cache-optimization space is undersolved: the most-starred cache-specific tool is a bug-fix shim (308 ⭐)
- No competitor implements volatility-region reordering + non-lossy K-pruning stubs as a unified pipeline
- Headroom is the closest architectural peer but is Python+Rust, lossy, and multi-provider

### CacheLane's Differentiation

**Positioning:** "The unified Anthropic-native pipeline" — one install that handles input structure, cache optimization, context pruning, and visibility, tuned specifically to how Anthropic's KV cache works.

**Technical moat:**
- Non-lossy K-pruning (refetchable stubs, never permanent drops)
- SHA-256 cache-stability gate (merge blocker — provably stable prefix)
- Classifier → Pruner → Reorderer pipeline (unique in the space)
- Fail-open guarantee (any error returns unmutated request)
- Local-only, zero data outside api.anthropic.com path
- TypeScript/Node — no Python deps, no ML inference latency

---

## User Stories

1. As a Claude Code user, I want my cache to stay warm across a long session so I don't pay full input cost on every turn after the first few minutes.
2. As a developer starting CacheLane, I want to run one command and have everything configured so I don't spend 20 minutes debugging hooks and MCP registration.
3. As a daily CacheLane user, I want to see how much money I've saved this session so I can understand the tool's value without reading logs.
4. As a developer in a long coding session, I want tool outputs (file listings, JSON responses, build logs) to be compressed before they fill my context window.
5. As a dev referencing multiple stubbed blocks, I want them all expanded in one request so I don't trigger multiple round-trips.

---

## Architecture: Parallel Track Model

Two independent development tracks run concurrently. A third track activates when the third developer joins.

### Track A — Completion (Dev 1)
Closes the existing milestone spec. Sequential: each feature depends on the previous.

| Feature | Branch | 30/60/90 |
|---|---|---|
| M8 Keepalive Executor | `feat/m8-keepalive-executor` | Day 30 |
| M9 Bulk Refetch | `feat/m9-bulk-refetch` | Day 60 |

### Track B — Capabilities (Dev 2)
Additive new features. All touch different modules — no conflicts with Track A.

| Feature | Branch | 30/60/90 |
|---|---|---|
| Install UX | `feat/install-ux` | Day 30 |
| Cost Dashboard | `feat/cost-dashboard` | Day 60 |
| Tool Output Compression | `feat/tool-output-compression` | Day 90 |

### Track C — Documentation & Benchmarks (Dev 3, when joined)

| Feature | Branch | 30/60/90 |
|---|---|---|
| Docs depth (architecture, CLI ref, K-pruning explainer, troubleshooting) | `docs/depth` | Day 30 |
| Real-world benchmarks published to docs site | `chore/real-world-benchmarks` | Day 60 |

---

## Feature Scopes

### M8 — Keepalive Executor
**In:** Extract API key ephemerally from intercepted requests → fire minimal TTL-refresh ping when KeepaliveWorker threshold fires → record ping result in DB → surface in `cachelane_health` and `cachelane stats`  
**Out:** Bedrock keepalive, multi-key rotation, persistent key storage, user-configurable ping content

### M9 — Bulk Refetch
**In:** Batch multiple stub handle DB reads into one query → return all expanded blocks in single `cachelane_expand` response → track aggregate refetch cost per session  
**Out:** Cross-session refetch, TTL-based expiry of refetch handles, ML relevance ranking

### Install UX
**In:** `npx cachelane@latest install` one-liner (MCP + hooks + proxy config + first-run health check) → actionable `cachelane doctor` error messages with suggested fixes → clean `cachelane uninstall`  
**Out:** GUI installer, Windows .exe, auto-update

### Cost Dashboard
**In:** `cachelane dashboard` → local server port 9999 → single-page vanilla JS/HTML → current session savings (tokens before/after, USD delta), all-time savings, cache hit ratio, pruning stats, last 10 sessions → reads from existing SQLite, no schema changes  
**Out:** Cloud sync, multi-machine aggregation, WebSocket real-time streaming, authentication

### Tool Output Compression
**In:** Intercept tool result blocks pre-orchestrator → detect JSON vs log/CLI vs plain text → deterministic compression (JSON: strip whitespace + null values + empty arrays + verbose metadata; logs: keep ERROR/WARN/stack frames/assert/test failure lines) → track tokens saved → user exclusion via `cachelane exclude-compression <glob>`  
**Out:** AST-based code compression, ML content routing, image compression, reversible CCR storage

---

## 30/60/90 Day Breakdown

### Day 30
- Track A: M8 Keepalive Executor — real TTL pings firing, integrated tested, health reflected
- Track B: Install UX — `npx cachelane@latest install` clean on macOS + Linux, doctor gives actionable errors
- Track C: Docs architecture + CLI reference pages live on Vercel

### Day 60
- Track A: M9 Bulk Refetch — multi-stub single-call expansion, refetch cost tracked
- Track B: Cost Dashboard — `cachelane dashboard` shows USD savings, cache hit ratio, last 10 sessions
- Track C: Real-world benchmarks (3+ workloads) published to docs site

### Day 90
- Track A: M8+M9 hardened — stress-tested on 100-turn sessions, coverage ≥ 90% on new code
- Track B: Tool Output Compression — JSON + log compression in pipeline, tokens-saved tracked, exclusion support
- Track C: K-pruning explainer + troubleshooting guide live

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| API key extraction breaks on Anthropic SDK version change | Medium | High | Pin extraction to header name (`x-api-key`); add integration test that validates extraction across SDK versions |
| Dashboard port 9999 conflicts with other local services | Low | Low | Make port configurable; fail gracefully with clear error |
| Tool compression breaks structured tool outputs Claude expects | Medium | High | Compression is opt-out per glob; integration tests verify Claude still parses compressed outputs correctly |
| Track A storage migrations block Track B PRs | Medium | Medium | Sequence M8 storage changes first; communicate schema changes in PRs before merging |
| Keepalive ping counted as billable usage | Medium | Medium | Use absolute minimum request (1 token system prompt); document expected minimal cost in CLI output |
| M9 bulk refetch increases DB read latency in large sessions | Low | Medium | Benchmark before/after; index on `refetch_handle` if needed |

---

## Assumption Register

| Assumption | Confidence | How to Validate |
|---|---|---|
| API key is always present in `x-api-key` header on intercepted requests | High | Check proxy intercept logs for header presence across Anthropic SDK versions |
| Existing SQLite schema has all data needed for dashboard without migrations | Medium | Verify `cachelane stats --scope all` returns all fields the dashboard needs before starting Track B dashboard work |
| JSON tool outputs are well-formed (parseable) before compression | High | Add try-catch; fallback to passthrough if JSON.parse fails |
| Port 9999 is not in common use on developer machines | Medium | Make configurable from day 1 |
| Users will opt into compression for most tool outputs | Medium | Ship with opt-out per glob rather than opt-in; measure exclusion usage |

---

## Non-Functional Requirements

- **Latency:** Tool output compression must add < 5ms overhead per turn (measured at p99)
- **Reliability:** All new features must follow fail-open: any error returns unmutated request/response
- **Storage:** Dashboard reads only — no new writes to SQLite from Track B (avoids schema conflicts with Track A)
- **Privacy:** No prompt text, tool output content, or API keys written to disk by any new feature
- **Testing:** All new code ≥ 85% line coverage; integration tests for every public-facing behaviour change

---

## Per-Feature Spec Folders

Full specs for each feature live in `docs/specs/`:

```
docs/specs/
  feat-m8-keepalive-executor/
  feat-m9-bulk-refetch/
  feat-install-ux/
  feat-cost-dashboard/
  feat-tool-output-compression/
```

Each folder contains: `overview.md`, `requirements.md`, `architecture.md`, `implementation-plan.md`, `testing-plan.md`, `rollout-plan.md`

Each `overview.md` opens with a **"Context for the agent"** section so the folder is self-contained for handoff.
