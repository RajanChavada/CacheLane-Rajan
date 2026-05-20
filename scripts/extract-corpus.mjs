#!/usr/bin/env node
/**
 * scripts/extract-corpus.mjs
 *
 * Automated corpus generator for the reference-detector (Q001 resolution).
 *
 * TWO-STAGE PIPELINE:
 *
 *   Stage 1 — Deterministic extraction (Approach 1)
 *     Reads Claude Code JSONL session logs (~/.claude/projects/**\/*.jsonl),
 *     reconstructs each conversation thread, pairs every assistant turn with
 *     the tool-result blocks that were in context at that point, runs
 *     detectReferences() (the actual detector under test), and emits a corpus
 *     fixture for every turn that has at least one detectable block.
 *
 *   Stage 2 — LLM semantic annotation (Approach 2)
 *     For turns where the detector fired zero signals yet the assistant clearly
 *     did *something* with the preceding tool results (non-trivial text
 *     response), sends the turn to Claude Haiku via the Anthropic API and asks
 *     it to judge which blocks were semantically referenced.  These are the
 *     high-value false-negative candidates that the synthetic corpus misses.
 *     Stage 2uses Claude Code's existing OAuth token from
 *     ~/.claude/.credentials.json — no separate API key or SDK required.
 *     If the token is absent the script still completes with Stage 1 only.
 *
 * USAGE:
 *   node scripts/extract-corpus.mjs [options]
 *
 *   --sessions-dir <path>   Root to scan for .jsonl files
 *                           (default: ~/.claude/projects)
 *   --out-dir <path>        Where to write corpus-NNN.json fixtures
 *                           (default: src/reference-detector/__tests__/corpus)
 *   --start-index <n>       First fixture number to emit (default: 21,
 *                           i.e. after the 20 synthetic ones)
 *   --max-fixtures <n>      Stop after emitting this many new fixtures
 *                           (default: 100)
 *   --min-content-len <n>   Minimum tool-result content length to include as a
 *                           detection block (default: 20 chars — filters noise)
 *   --skip-stage2           Skip LLM annotation even if OAuth token is present
 *   --dry-run               Print fixtures to stdout, don't write files
 *   --verbose               Extra logging
 *
 * CORPUS FIXTURE SHAPE (matches existing corpus-*.json):
 *   {
 *     "id": "corpus-NNN",
 *     "description": "<source>: <tool names> → <signal summary>",
 *     "detection_blocks": [{ "id", "file_path", "content" }],
 *     "assistant_message": { "role": "assistant", "content": [...] },
 *     "ground_truth": {
 *       "referenced_block_ids": [...],
 *       "unreferenced_block_ids": [...]
 *     },
 *     "_meta": {            // non-schema annotation for traceability
 *       "source": "deterministic" | "llm_annotated",
 *       "session_file": "...",
 *       "turn_uuid": "...",
 *       "annotation_model": "..."  // only present for llm_annotated
 *     }
 *   }
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// ─── CLI args ────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    "sessions-dir":      { type: "string" },
    "out-dir":           { type: "string" },
    "start-index":       { type: "string" },
    "max-fixtures":      { type: "string" },
    "min-content-len":   { type: "string" },
    "max-negatives-pct": { type: "string" },  // 0-100, default 60
    "skip-stage2":       { type: "boolean", default: false },
    "dry-run":           { type: "boolean", default: false },
    "verbose":           { type: "boolean", default: false },
  },
  strict: false,
});

const SESSIONS_DIR  = args["sessions-dir"]
  ? resolve(args["sessions-dir"])
  : join(homedir(), ".claude", "projects");

const OUT_DIR = args["out-dir"]
  ? resolve(args["out-dir"])
  : resolve("src/reference-detector/__tests__/corpus");

const START_INDEX        = parseInt(args["start-index"]       ?? "21",  10);
const MAX_FIXTURES       = parseInt(args["max-fixtures"]      ?? "100", 10);
const MIN_CONTENT_LEN    = parseInt(args["min-content-len"]   ?? "20",  10);
// Max percentage of emitted fixtures that can be true-negatives (0 refs).
// Positives are always emitted first; negatives fill remaining budget up to this cap.
const MAX_NEGATIVES_PCT  = parseInt(args["max-negatives-pct"] ?? "60",  10) / 100;
const SKIP_STAGE2        = args["skip-stage2"] ?? false;
const DRY_RUN            = args["dry-run"]     ?? false;
const VERBOSE            = args["verbose"]     ?? false;

const log  = (...a) => console.log("[extract-corpus]", ...a);
const dbg  = (...a) => { if (VERBOSE) console.log("[extract-corpus:dbg]", ...a); };
const warn = (...a) => console.warn("[extract-corpus:warn]", ...a);

// ─── Detector (inlined so the script is self-contained) ──────────────────────
// We inline the three signals rather than importing from src/ because this
// script runs as plain ESM without tsc, and src/ uses .js extension imports
// that reference compiled output paths.

const SHINGLE_SIZE = 40;

function extractAssistantText(message) {
  return (message.content ?? [])
    .filter(c => c?.type === "text")
    .map(c => c.text)
    .join("\n");
}

function extractToolCallArgStrings(message) {
  return (message.content ?? [])
    .filter(c => c?.type === "tool_use")
    .map(c => { try { return JSON.stringify(c.input); } catch { return ""; } });
}

/**
 * Runs the three deterministic signals and returns:
 *   { referenced_ids: Set<string>, signals_fired: Map<string, number> }
 */
function detectReferences(blocks, message) {
  const referenced_ids = new Set();
  const signals_fired  = new Map(); // block_id → signal number

  const toolArgStrings = extractToolCallArgStrings(message);
  const combinedArgs   = toolArgStrings.join(" ");
  const assistantText  = extractAssistantText(message);
  const searchable     = `${assistantText} ${combinedArgs}`;

  // Signal 1 — file_path substring in any tool call argument JSON
  for (const block of blocks) {
    if (!block.file_path) continue;
    if (combinedArgs.includes(block.file_path)) {
      referenced_ids.add(block.id);
      signals_fired.set(block.id, 1);
    }
  }

  // Signal 2 — block ID substring in assistant text or tool args
  for (const block of blocks) {
    if (referenced_ids.has(block.id)) continue;
    if (searchable.includes(block.id)) {
      referenced_ids.add(block.id);
      signals_fired.set(block.id, 2);
    }
  }

  // Signal 3 — 40-char shingle overlap in assistant text
  if (assistantText) {
    for (const block of blocks) {
      if (referenced_ids.has(block.id)) continue;
      if (block.content.length < SHINGLE_SIZE) continue;
      for (let i = 0; i <= block.content.length - SHINGLE_SIZE; i++) {
        const shingle = block.content.slice(i, i + SHINGLE_SIZE);
        if (assistantText.includes(shingle)) {
          referenced_ids.add(block.id);
          signals_fired.set(block.id, 3);
          break;
        }
      }
    }
  }

  return { referenced_ids, signals_fired };
}

// ─── JSONL parsing ───────────────────────────────────────────────────────────

/**
 * Walk directory recursively, yield all .jsonl file paths.
 * Skips directories named "subagents" — those JSONL files are sub-conversations
 * whose records are a strict subset of their parent session file. Processing
 * them separately would produce duplicate or partial fixtures and, worse, would
 * pollute the globalSeen set before the parent file is processed.
 */
function* walkJsonl(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  // Yield files before recursing so parent session files are processed first
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) yield join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== "subagents") yield* walkJsonl(join(dir, e.name));
  }
}

/** Parse a JSONL file; skip malformed lines. */
function parseJsonl(path) {
  const lines = readFileSync(path, "utf-8").split("\n");
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { /* skip */ }
  }
  return records;
}

/**
 * Reconstruct ALL conversation sub-threads from a flat JSONL record list.
 *
 * Claude Code sessions can contain many independent sub-conversations — e.g.
 * the main thread plus one chain per Agent/subagent dispatch. Each has its
 * own root (a record whose parentUuid points to a non-message record or is
 * absent). We walk ALL roots fully and return them as separate chains so the
 * pair extractor can treat each chain's context independently.
 *
 * Returns an array of chains: Chain = { threadId, records[] }
 * where records[] is ordered parent→child by timestamp within the chain.
 */
function reconstructAllThreads(records) {
  const byUuid = new Map();
  for (const r of records) {
    if (r.uuid) byUuid.set(r.uuid, r);
  }

  // Build child lists (non-sidechain only)
  const children = new Map();
  for (const r of records) {
    if (!r.uuid || !["user","assistant"].includes(r.type)) continue;
    if (r.isSidechain) continue;
    const p = r.parentUuid ?? "__root__";
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(r);
  }

  // Identify roots: message records whose parentUuid is absent or points
  // to a non-message record (permission-mode, last-prompt, snapshot, etc.)
  const msgUuids = new Set(
    records.filter(r => ["user","assistant"].includes(r.type) && r.uuid).map(r => r.uuid)
  );
  const roots = records.filter(r =>
    ["user","assistant"].includes(r.type) &&
    r.uuid &&
    !r.isSidechain &&
    (!r.parentUuid || !msgUuids.has(r.parentUuid))
  ).sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  if (roots.length === 0) return [];

  // Walk each root to its full linear chain.
  // At branching points (multiple children) we walk ALL branches independently,
  // producing one chain per branch. This handles Agent sub-conversations where
  // each agent dispatch hangs off a different parent.
  const chains = [];
  // globalSeen is scoped to THIS call of reconstructAllThreads (one file).
  // It must NOT be shared across files — subagent .jsonl files share UUIDs
  // with their parent session and would poison the seen-set if shared.
  const globalSeen = new Set();

  function walkChain(startRecord) {
    const chain = [];

    const walk = (r) => {
      if (!r || globalSeen.has(r.uuid)) return;
      globalSeen.add(r.uuid);
      chain.push(r);
      const kids = (children.get(r.uuid) ?? [])
        .filter(c => !c.isSidechain && !globalSeen.has(c.uuid))
        .sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
      // Walk first child inline (continuation), spawn new chains for branches
      for (let i = 0; i < kids.length; i++) {
        if (i === 0) walk(kids[0]);
        else chains.push(walkChain(kids[i])); // branch → new chain
      }
    };

    walk(startRecord);
    return chain;
  }

  for (const root of roots) {
    const chain = walkChain(root);
    if (chain.length > 0) chains.push(chain);
  }

  return chains.filter(c => c.length > 0);
}

// Keep backward-compat alias returning flat array (used by older call sites)
function reconstructThread(records) {
  const chains = reconstructAllThreads(records);
  // Flatten all chains sorted by timestamp — for sessions with one main thread
  // this is identical to the old behavior
  return chains.flat().sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
}

// ─── Tool result → DetectionBlock conversion ─────────────────────────────────

/**
 * Extract a file_path from a tool_use input object.
 * Handles Read (file_path), Edit (file_path), Write (file_path),
 * Bash (no file_path — returns null), and any tool whose input
 * has a top-level "file_path" or "path" key.
 */
function inferFilePath(toolName, input) {
  if (!input || typeof input !== "object") return null;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  // Bash commands sometimes encode a path, but it's too noisy to parse reliably
  return null;
}

/**
 * Given the ordered thread, extract "candidate pairs":
 * each pair is { assistantRecord, detectionBlocks[] }
 * where detectionBlocks are the tool_result blocks from the immediately
 * preceding user turn(s) that delivered results to this assistant response.
 *
 * In practice Claude Code alternates:
 *   user (tool_result*) → assistant (text + tool_use*) → user (tool_result*) → ...
 *
 * We also carry a rolling window of all tool_results seen so far
 * (capped at MAX_CONTEXT_BLOCKS) to simulate the accumulating context,
 * since older results stay in the prompt until pruned.
 */
const MAX_CONTEXT_BLOCKS = 30; // cap to keep fixtures manageable

function extractCandidatePairs(thread) {
  // Build a map from tool_use_id → { name, input } from assistant records
  const toolUseById = new Map();
  for (const r of thread) {
    if (r.type !== "assistant") continue;
    for (const c of r.message?.content ?? []) {
      if (c?.type === "tool_use" && c.id) {
        toolUseById.set(c.id, { name: c.name, input: c.input ?? {} });
      }
    }
  }

  const pairs = [];
  // Rolling context: all DetectionBlocks seen so far (deduped by id)
  const contextBlocksMap = new Map(); // block_id → DetectionBlock

  for (let i = 0; i < thread.length; i++) {
    const r = thread[i];

    // Absorb tool_results from user records into rolling context
    if (r.type === "user") {
      for (const c of r.message?.content ?? []) {
        if (c?.type !== "tool_result") continue;
        const toolUseId = c.tool_use_id;
        const toolUse   = toolUseById.get(toolUseId);
        if (!toolUse) continue;

        // Flatten content to string
        let rawContent = "";
        if (typeof c.content === "string") {
          rawContent = c.content;
        } else if (Array.isArray(c.content)) {
          rawContent = c.content.map(x => (typeof x === "string" ? x : x?.text ?? JSON.stringify(x))).join("\n");
        }
        if (rawContent.length < MIN_CONTENT_LEN) continue;

        const filePath = inferFilePath(toolUse.name, toolUse.input);
        // Use the tool_use_id as block id (stable, unique within session)
        const blockId = toolUseId;

        contextBlocksMap.set(blockId, {
          id:        blockId,
          file_path: filePath,
          content:   rawContent.slice(0, 4000), // cap content size
          _tool_name: toolUse.name,
        });
      }
    }

    // Emit a pair for every assistant turn that has at least one tool call
    // or non-trivial text response AND there are context blocks available.
    if (r.type === "assistant") {
      const content = r.message?.content ?? [];
      const hasToolUse = content.some(c => c?.type === "tool_use");
      const text       = extractAssistantText(r.message ?? {});
      const hasText    = text.trim().length > 30;

      if ((!hasToolUse && !hasText) || contextBlocksMap.size === 0) continue;

      // Take the most recent MAX_CONTEXT_BLOCKS blocks
      const allBlocks = [...contextBlocksMap.values()];
      const detectionBlocks = allBlocks.slice(-MAX_CONTEXT_BLOCKS).map(b => ({
        id:        b.id,
        file_path: b.file_path,
        content:   b.content,
      }));

      // Build a clean AssistantMessage (only type/id/name/input/text fields)
      const assistantMessage = {
        role: "assistant",
        content: content.map(c => {
          if (c?.type === "text")     return { type: "text", text: c.text ?? "" };
          if (c?.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} };
          return null;
        }).filter(Boolean),
      };

      if (assistantMessage.content.length === 0) continue;

      pairs.push({
        assistantRecord: r,
        detectionBlocks,
        assistantMessage,
        contextSize: contextBlocksMap.size,
      });
    }
  }

  return pairs;
}

// ─── Corpus fixture builder ───────────────────────────────────────────────────

function buildDescription(pair, source, signalsFired) {
  const toolNames = [...new Set(
    pair.assistantMessage.content
      .filter(c => c.type === "tool_use")
      .map(c => c.name)
  )];
  const sigNums = [...new Set(signalsFired.values())].sort();
  const sigStr  = sigNums.length
    ? `signals [${sigNums.join(",")}] fired`
    : "no signals fired (semantic)";
  const toolStr = toolNames.length ? toolNames.slice(0,3).join("+") : "text-only";
  return `${source}: ${toolStr} — ${sigStr}`;
}

function buildFixture(pair, index, source, referencedIds, unreferencedIds, annotationModel) {
  const { assistantRecord, detectionBlocks, assistantMessage } = pair;
  const fixture = {
    id:          `corpus-${String(index).padStart(3, "0")}`,
    description: buildDescription(pair, source, new Map()),
    detection_blocks: detectionBlocks,
    assistant_message: assistantMessage,
    ground_truth: {
      referenced_block_ids:   [...referencedIds],
      unreferenced_block_ids: [...unreferencedIds],
    },
    _meta: {
      source,
      session_file: assistantRecord.sessionId ?? "unknown",
      turn_uuid:    assistantRecord.uuid ?? "unknown",
      ...(annotationModel ? { annotation_model: annotationModel } : {}),
    },
  };
  return fixture;
}

// ─── Stage 2: LLM semantic annotation ────────────────────────────────────────

/**
 * Read the OAuth access token from Claude Code's own credentials file.
 *
 * Claude Code stores its Pro/Max subscription token at:
 *   ~/.claude/.credentials.json  →  { claudeAiOauth: { accessToken, refreshToken, ... } }
 *
 * This token has the "user:inference" scope, which is exactly what the
 * Anthropic messages API requires. We use it with a plain fetch() call —
 * no @anthropic-ai/sdk needed, no separate API key, no console.anthropic.com.
 *
 * Returns the access token string, or null if the file is missing/unreadable.
 */
function readClaudeOAuthToken() {
  const credPath = join(homedir(), ".claude", ".credentials.json");
  try {
    const creds = JSON.parse(readFileSync(credPath, "utf-8"));
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.length > 10) return token;
    return null;
  } catch {
    return null;
  }
}

/**
 * Call the Anthropic messages API using Claude Code's OAuth token.
 * Uses plain Node.js fetch — no SDK required.
 */
async function callAnthropicApi(oauthToken, messages, model, maxTokens) {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages,
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "anthropic-version": "2023-06-01",
      // Claude Code Pro subscription uses OAuth Bearer, not x-api-key
      "Authorization":     `Bearer ${oauthToken}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Ask Claude Haiku whether each block was semantically referenced by the
 * assistant response. This catches cases the three deterministic signals miss:
 * the model used a block's content in its reasoning but didn't quote it
 * verbatim, name the file path, or use the block ID.
 *
 * Returns a Set of referenced block IDs, or null on failure.
 */
async function llmAnnotate(oauthToken, pair) {
  const { detectionBlocks, assistantMessage } = pair;

  const blockDescriptions = detectionBlocks.map((b, i) => {
    const fp = b.file_path ? ` (file: ${b.file_path})` : "";
    return `Block ${i+1} [ID: ${b.id}]${fp}:\n${b.content.slice(0, 300)}`;
  }).join("\n\n");

  const assistantText = extractAssistantText(assistantMessage);
  const toolCalls = assistantMessage.content
    .filter(c => c.type === "tool_use")
    .map(c => `  Tool: ${c.name}, input: ${JSON.stringify(c.input).slice(0, 200)}`)
    .join("\n");
  const assistantSummary = [
    assistantText ? `Text response:\n${assistantText.slice(0, 500)}` : "",
    toolCalls     ? `Tool calls:\n${toolCalls}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are annotating a corpus for a reference-detection system.

An assistant response is shown below, along with the tool-result blocks that were in context when it was generated.

Your task: for each block, decide whether the assistant REFERENCED it. "Referenced" means the assistant used the block's content to produce its response — read it, quoted it, acted on it, called a tool with its file path, or clearly drew on its information. If the block was merely present in context but the assistant did NOT use it, it is NOT referenced.

BLOCKS IN CONTEXT:
${blockDescriptions}

ASSISTANT RESPONSE:
${assistantSummary}

Reply with JSON only, no prose:
{
  "referenced_block_ids": ["<id>", ...],
  "reasoning": "<one sentence>"
}`;

  try {
    const response = await callAnthropicApi(
      oauthToken,
      [{ role: "user", content: prompt }],
      "claude-haiku-4-5",
      256,
    );
    const raw = response?.content?.[0]?.text ?? "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const ids = Array.isArray(parsed.referenced_block_ids)
      ? parsed.referenced_block_ids.filter(id => detectionBlocks.some(b => b.id === id))
      : [];
    dbg(`LLM annotation: referenced ${ids.length}/${detectionBlocks.length} blocks. Reasoning: ${parsed.reasoning ?? "?"}`);
    return new Set(ids);
  } catch (err) {
    warn("LLM annotation failed:", err.message);
    return null;
  }
}

// ─── Dedup: skip turns too similar to ones already emitted ───────────────────

/**
 * Fingerprint a pair for deduplication.
 *
 * We want to prevent identical fixtures (same tool, same result, same response)
 * but NOT collapse fixtures that look superficially similar but reference
 * different blocks or different file paths. The fingerprint must include
 * the actual block IDs and file paths that appear in this pair so that
 * "Read file A" and "Read file B" produce distinct fixtures even if the
 * assistant text starts identically.
 */
function fingerprint(pair) {
  const tools = pair.assistantMessage.content
    .filter(c => c.type === "tool_use")
    .map(c => {
      const fp = c.input?.file_path ?? c.input?.command?.slice(0, 40) ?? "";
      return `${c.name}:${fp}`;
    })
    .sort()
    .join(",");
  // Include block IDs and file_paths — two pairs with different blocks are distinct
  const blockSig = pair.detectionBlocks
    .map(b => b.file_path ?? b.id.slice(-8))
    .sort()
    .join("|");
  const text = extractAssistantText(pair.assistantMessage).slice(0, 80);
  return `${tools}||${blockSig}||${text}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Scanning sessions dir: ${SESSIONS_DIR}`);
  log(`Output dir:            ${OUT_DIR}`);
  log(`Start index:           ${START_INDEX}`);
  log(`Max fixtures:          ${MAX_FIXTURES}`);

  if (!existsSync(SESSIONS_DIR)) {
    log(`Sessions dir not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }

  if (!DRY_RUN && !existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  // ── Stage 2 setup ──────────────────────────────────────────────────────────
  // Uses Claude Code's existing OAuth token — no API key or SDK required.
  let oauthToken = null;
  const annotationModel = "claude-haiku-4-5";

  if (!SKIP_STAGE2) {
    oauthToken = readClaudeOAuthToken();
    if (!oauthToken) {
      log("Could not read OAuth token from ~/.claude/.credentials.json — Stage 2 disabled.");
      log("Make sure you are logged in to Claude Code (claude auth login).");
    } else {
      log(`Stage 2 enabled — using Claude Code OAuth token for ${annotationModel} annotation.`);
    }
  } else {
    log("Stage 2 skipped (--skip-stage2).");
  }

  // ── Collect all JSONL files, sorted largest-first ────────────────────────
  // Bug 1 fix: sort by file size descending so the richest sessions (e.g. the
  // active CacheLane coding session at 7MB) are processed before smaller
  // diagnostic/personal sessions that would exhaust the fixture budget first.
  const { statSync } = await import("node:fs");
  const jsonlFiles = [...walkJsonl(SESSIONS_DIR)]
    .map(p => ({ path: p, size: (() => { try { return statSync(p).size; } catch { return 0; } })() }))
    .sort((a, b) => b.size - a.size)
    .map(f => f.path);
  log(`Found ${jsonlFiles.length} JSONL files (sorted largest-first).`);
  if (jsonlFiles.length > 0) {
    dbg(`Largest: ${basename(jsonlFiles[0])} (${statSync(jsonlFiles[0]).size} bytes)`);
  }

  // ── Collect ALL candidate pairs across all sessions first ─────────────────
  // Bug 2 fix: we can't enforce a negative cap if we emit greedily per-session,
  // because we'd fill up on negatives from early sessions before seeing the
  // positives buried in later ones. Instead: gather all pairs, run detection on
  // each, split into positives and negatives, then fill the budget in order:
  //   1. All positives (up to MAX_FIXTURES)
  //   2. Negatives up to MAX_NEGATIVES_PCT of total budget
  log("Scanning all sessions for candidate pairs...");
  const allCandidates = []; // { pair, jsonlPath }
  for (const jsonlPath of jsonlFiles) {
    let records;
    try { records = parseJsonl(jsonlPath); }
    catch (e) { warn(`Failed to parse ${jsonlPath}: ${e.message}`); continue; }

    const chains = reconstructAllThreads(records);
    if (chains.length === 0) continue;

    let sessionPairs = 0;
    for (const chain of chains) {
      for (const pair of extractCandidatePairs(chain)) {
        allCandidates.push({ pair, jsonlPath });
        sessionPairs++;
      }
    }
    if (sessionPairs > 0) {
      dbg(`${basename(jsonlPath)}: ${chains.length} chains → ${sessionPairs} pairs`);
    }
  }
  log(`Total candidate pairs across all sessions: ${allCandidates.length}`);

  // ── Dedup candidates ──────────────────────────────────────────────────────
  const seenFingerprints = new Set();
  const dedupedCandidates = [];
  let skippedNoBlocks = 0;
  let skippedDedup    = 0;

  for (const c of allCandidates) {
    if (c.pair.detectionBlocks.length === 0) { skippedNoBlocks++; continue; }
    const fp = fingerprint(c.pair);
    if (seenFingerprints.has(fp)) { skippedDedup++; continue; }
    seenFingerprints.add(fp);
    dedupedCandidates.push(c);
  }
  log(`After dedup: ${dedupedCandidates.length} unique pairs (dropped ${skippedDedup} dupes, ${skippedNoBlocks} empty).`);

  // ── Run Stage 1 detection on all deduped candidates ──────────────────────
  const positiveCandidates = []; // detector fired ≥ 1 signal
  const negativeCandidates = []; // detector fired 0 signals

  for (const c of dedupedCandidates) {
    const { referenced_ids, signals_fired } = detectReferences(
      c.pair.detectionBlocks,
      c.pair.assistantMessage,
    );
    c.referenced_ids  = referenced_ids;
    c.signals_fired   = signals_fired;
    if (referenced_ids.size > 0) positiveCandidates.push(c);
    else                          negativeCandidates.push(c);
  }
  log(`Positives (signals fired): ${positiveCandidates.length}`);
  log(`Negatives (no signals):    ${negativeCandidates.length}`);

  // ── Budget allocation ─────────────────────────────────────────────────────
  // Take all positives first (up to MAX_FIXTURES), then fill remaining slots
  // with negatives, but never let negatives exceed MAX_NEGATIVES_PCT of total.
  const maxNegatives = Math.floor(MAX_FIXTURES * MAX_NEGATIVES_PCT);
  const selectedPositives = positiveCandidates.slice(0, MAX_FIXTURES);
  const remainingBudget   = MAX_FIXTURES - selectedPositives.length;
  const selectedNegatives = negativeCandidates.slice(0, Math.min(remainingBudget, maxNegatives));
  const selected = [...selectedPositives, ...selectedNegatives];

  log(`Selected for emission: ${selectedPositives.length} positives + ${selectedNegatives.length} negatives = ${selected.length} total`);
  log(`(Negative cap: ${MAX_NEGATIVES_PCT * 100}% of ${MAX_FIXTURES} = max ${maxNegatives} negatives)`);

  // ── Emit fixtures ─────────────────────────────────────────────────────────
  const emittedFingerprints = new Set();
  let fixtureIndex = START_INDEX;
  let emittedCount = 0;
  let stage1Count  = 0;
  let stage2Count  = 0;

  for (const c of selected) {
    const { pair, jsonlPath, referenced_ids, signals_fired } = c;
    const allBlockIds    = new Set(pair.detectionBlocks.map(b => b.id));
    const unreferencedIds = new Set([...allBlockIds].filter(id => !referenced_ids.has(id)));

    let source        = "deterministic";
    let finalRefIds   = referenced_ids;
    let finalUnrefIds = unreferencedIds;

    // ── Stage 2: LLM annotation for zero-signal turns ───────────────────
    // Send to Claude Haiku when: no signals fired, assistant has real text,
    // and blocks have meaningful content. This catches semantic references
    // the three deterministic signals miss.
    const hasText = extractAssistantText(pair.assistantMessage).trim().length > 50;
    const hasMeaningfulBlocks = pair.detectionBlocks.some(b => b.content.length >= 80);

    if (referenced_ids.size === 0 && oauthToken && hasText && hasMeaningfulBlocks) {
      dbg("Zero signals — sending to LLM annotator...");
      const llmRefs = await llmAnnotate(oauthToken, pair);
      if (llmRefs !== null) {
        finalRefIds    = llmRefs;
        finalUnrefIds  = new Set([...allBlockIds].filter(id => !llmRefs.has(id)));
        source         = "llm_annotated";
        stage2Count++;
      } else {
        stage1Count++;
      }
    } else {
      stage1Count++;
    }

    // Build fixture
    const fixture = buildFixture(
      pair,
      fixtureIndex,
      source,
      finalRefIds,
      finalUnrefIds,
      source === "llm_annotated" ? annotationModel : undefined,
    );

    // Write description
    const sigNums = [...new Set(signals_fired.values())].sort();
    const toolNames = [...new Set(
      pair.assistantMessage.content.filter(c => c.type === "tool_use").map(c => c.name)
    )].slice(0, 3).join("+") || "text-only";
    const sigStr = sigNums.length
      ? `signals [${sigNums.join(",")}] fired on ${finalRefIds.size}/${allBlockIds.size} blocks`
      : finalRefIds.size > 0
        ? `LLM: ${finalRefIds.size}/${allBlockIds.size} blocks referenced`
        : `true negative: 0/${allBlockIds.size} blocks referenced`;
    fixture.description = `${source}: ${toolNames} — ${sigStr}`;

    if (DRY_RUN) {
      console.log(JSON.stringify(fixture, null, 2));
    } else {
      const outPath = join(OUT_DIR, `${fixture.id}.json`);
      writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
      log(`Wrote ${fixture.id} (${source}, ${finalRefIds.size} refs / ${allBlockIds.size} blocks)`);
    }

    fixtureIndex++;
    emittedCount++;
  }

  // ── Benchmark: compute precision/recall across ALL corpus entries on disk ──
  // This runs over every .json in OUT_DIR — including pre-existing synthetic
  // fixtures — and prints a full breakdown so you can see exactly how the
  // detector performs across real vs synthetic data.
  log("");
  log("=== Benchmark: running detector across full corpus on disk ===");

  const allFixtureFiles = existsSync(OUT_DIR)
    ? readdirSync(OUT_DIR).filter(f => f.endsWith(".json")).sort()
    : [];

  let bTP = 0, bFP = 0, bFN = 0;
  let bSyntheticTP = 0, bSyntheticFP = 0, bSyntheticFN = 0;
  let bRealTP = 0, bRealFP = 0, bRealFN = 0;
  let bLLMTP = 0, bLLMFP = 0, bLLMFN = 0;
  let totalFixtures = 0;
  let positiveFixtures = 0;  // fixtures with at least one ground-truth ref
  let trueNegFixtures = 0;   // fixtures with zero ground-truth refs
  const signalCounts = { 1: 0, 2: 0, 3: 0 };

  for (const fname of allFixtureFiles) {
    try {
      const entry = JSON.parse(readFileSync(join(OUT_DIR, fname), "utf-8"));
      totalFixtures++;

      const want = new Set(entry.ground_truth.referenced_block_ids);
      if (want.size > 0) positiveFixtures++; else trueNegFixtures++;

      const { referenced_ids, signals_fired } = detectReferences(
        entry.detection_blocks,
        entry.assistant_message,
      );

      // Count signal firings
      for (const sig of signals_fired.values()) {
        if (sig in signalCounts) signalCounts[sig]++;
      }

      const isReal      = !!entry._meta;
      const isLLM       = entry._meta?.source === "llm_annotated";
      const isSynthetic = !isReal;

      for (const id of referenced_ids) {
        if (want.has(id)) { bTP++; if (isSynthetic) bSyntheticTP++; if (isReal && !isLLM) bRealTP++; if (isLLM) bLLMTP++; }
        else              { bFP++; if (isSynthetic) bSyntheticFP++; if (isReal && !isLLM) bRealFP++; if (isLLM) bLLMFP++; }
      }
      for (const id of want) {
        if (!referenced_ids.has(id)) { bFN++; if (isSynthetic) bSyntheticFN++; if (isReal && !isLLM) bRealFN++; if (isLLM) bLLMFN++; }
      }
    } catch { /* skip malformed */ }
  }

  const pct  = (tp, fp, fn) => {
    const prec = tp+fp === 0 ? 1.0 : tp/(tp+fp);
    const rec  = tp+fn === 0 ? 1.0 : tp/(tp+fn);
    return { prec, rec };
  };

  const overall  = pct(bTP, bFP, bFN);
  const synthP   = pct(bSyntheticTP, bSyntheticFP, bSyntheticFN);
  const realP    = pct(bRealTP, bRealFP, bRealFN);
  const llmP     = pct(bLLMTP, bLLMFP, bLLMFN);

  const fmt = (p, r) => `precision=${( p*100).toFixed(1)}%  recall=${( r*100).toFixed(1)}%`;
  const gate = overall.prec >= 0.95 && overall.rec >= 0.85 ? "PASS" : "FAIL";

  log(`Total fixtures on disk:     ${totalFixtures}`);
  log(`  Positive (has refs):      ${positiveFixtures}`);
  log(`  True-negative (no refs):  ${trueNegFixtures}`);
  log(`  Positive rate:            ${totalFixtures > 0 ? (positiveFixtures/totalFixtures*100).toFixed(1) : 0}%`);
  log("");
  log(`Signal firing breakdown (across positive fixtures):`);
  log(`  Signal 1 (file_path):     ${signalCounts[1]} matches`);
  log(`  Signal 2 (id mention):    ${signalCounts[2]} matches`);
  log(`  Signal 3 (shingle):       ${signalCounts[3]} matches`);
  log("");
  log(`Overall   TP=${bTP} FP=${bFP} FN=${bFN}  ${fmt(overall.prec, overall.rec)}  [gate: ${gate}]`);
  log(`Synthetic TP=${bSyntheticTP} FP=${bSyntheticFP} FN=${bSyntheticFN}  ${fmt(synthP.prec, synthP.rec)}`);
  log(`Real-det  TP=${bRealTP} FP=${bRealFP} FN=${bRealFN}  ${fmt(realP.prec, realP.rec)}`);
  if (bLLMTP + bLLMFP + bLLMFN > 0) {
    log(`Real-LLM  TP=${bLLMTP} FP=${bLLMFP} FN=${bLLMFN}  ${fmt(llmP.prec, llmP.rec)}`);
  } else {
    log(`Real-LLM  (no LLM-annotated fixtures yet)`);
  }
  log("");
  log(`Gate (precision>=95% AND recall>=85%): ${gate}`);

  // ── Emit summary ────────────────────────────────────────────────────────────
  log("");
  log("=== Extraction summary ===");
  log(`Fixtures emitted this run:  ${emittedCount}`);
  log(`  Stage 1 (deterministic):  ${stage1Count}`);
  log(`  Stage 2 (LLM annotated):  ${stage2Count}`);
  log(`Skipped (dedup):            ${skippedDedup}`);
  log(`Skipped (no blocks):        ${skippedNoBlocks}`);
  log(`Positive candidates found:  ${positiveCandidates.length}`);
  log(`Negative candidates found:  ${negativeCandidates.length}`);
  log(`Output dir:                 ${OUT_DIR}`);

  if (emittedCount < MAX_FIXTURES) {
    log("");
    log(`NOTE: Only ${emittedCount} new fixtures emitted (target ${MAX_FIXTURES}).`);
    log("Tips to get more:");
    log("  - Run more Claude Code sessions and re-run this script.");
    log(`  - Lower --min-content-len (currently ${MIN_CONTENT_LEN}) to include shorter tool results.`);
    log("  - Pass --sessions-dir to point at additional session archives.");
  }

  if (!oauthToken && !SKIP_STAGE2) {
    log("");
    log("Stage 2 (LLM annotation) was disabled — zero-signal turns are marked as");
    log("true negatives without semantic verification. To enable, ensure you are");
    log("logged in to Claude Code:");
    log("  claude auth login");
    log("  node scripts/extract-corpus.mjs --start-index <next-index>");
  }
}

main().catch(err => {
  console.error("[extract-corpus] Fatal:", err);
  process.exit(1);
});
