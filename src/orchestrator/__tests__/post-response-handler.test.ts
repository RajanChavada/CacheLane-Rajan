import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../storage/index.js";
import type { CachelaneDb } from "../../storage/index.js";
import { handlePostResponse } from "../post-response-handler.js";
import type { PostResponseInput } from "../post-response-handler.js";

let tmpDir: string;
let db: CachelaneDb;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cachelane-pr-test-"));
  db = openDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  try { db?.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedBlock(id: string, filePath: string | null = null, unusedTurns = 0) {
  db.insertBlock({
    id,
    workspace_id: "ws-1",
    session_id: "sess-1",
    content_hash: id.slice(0, 64).padEnd(64, "0"),
    kind: "file_read",
    volatility: "SEMI",
    is_pinned: false,
    token_count: 100,
    added_at_turn: 1,
    last_referenced_at_turn: 1,
    unused_turns: unusedTurns,
    is_stub: false,
    stub_summary: null,
    refetch_handle: filePath ? `view:${filePath}:1-50` : null,
    created_at: NOW,
    updated_at: NOW,
  });
}

function seedTurn(turnId: string) {
  db.insertTurn({
    id: turnId,
    workspace_id: "ws-1",
    session_id: "sess-1",
    turn_number: 2,
    model: "claude-opus-4-7",
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    cache_read_tokens: 0,
    effective_cost_units: 100,
    prefix_breakpoint_hash: null,
    middle_breakpoint_hash: null,
    pruned_blocks_count: 0,
    keepalive_pings_since_last_turn: 0,
    created_at: NOW,
  });
}

describe("handlePostResponse", () => {
  it("increments unused_turns for blocks not referenced", () => {
    seedBlock("B_UNREFERENCED", null, 1);
    seedTurn("T_UNUSED");

    const input: PostResponseInput = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_UNUSED",
      assistant_message: { role: "assistant", content: [{ type: "text", text: "nothing here" }] },
      detection_blocks: [{ id: "B_UNREFERENCED", content: "some content", file_path: null }],
      db,
      now: NOW + 1000,
    };

    handlePostResponse(input);

    expect(db.getBlock("B_UNREFERENCED")!.unused_turns).toBe(2);
  });

  it("resets unused_turns to 0 for referenced block (signal 1)", () => {
    seedBlock("B_AUTH", "src/auth.py", 2);
    seedTurn("T_REF");

    const input: PostResponseInput = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_REF",
      assistant_message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }],
      },
      detection_blocks: [{ id: "B_AUTH", content: "def login(): pass", file_path: "src/auth.py" }],
      db,
      now: NOW + 1000,
    };

    handlePostResponse(input);

    const block = db.getBlock("B_AUTH")!;
    expect(block.unused_turns).toBe(0);
    expect(block.last_referenced_at_turn).toBe(2);
  });

  it("writes a block_reference audit log entry for each detected reference", () => {
    seedBlock("B_AUTH", "src/auth.py", 0);
    seedTurn("T_AUDIT");

    const input: PostResponseInput = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_AUDIT",
      assistant_message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }],
      },
      detection_blocks: [{ id: "B_AUTH", content: "def login(): pass", file_path: "src/auth.py" }],
      db,
      now: NOW + 1000,
    };

    handlePostResponse(input);

    const refs = db.getBlockReferencesForTurn("T_AUDIT");
    expect(refs).toHaveLength(1);
    expect(refs[0].block_id).toBe("B_AUTH");
    expect(refs[0].reference_type).toBe("tool_call");
  });

  it("handles mixed referenced and unreferenced blocks correctly", () => {
    seedBlock("B_REF", "src/auth.py", 1);
    seedBlock("B_IDLE", null, 0);
    seedTurn("T_MIXED");

    const input: PostResponseInput = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_MIXED",
      assistant_message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }],
      },
      detection_blocks: [
        { id: "B_REF", content: "auth content", file_path: "src/auth.py" },
        { id: "B_IDLE", content: "other content that is definitely longer than forty characters yes", file_path: null },
      ],
      db,
      now: NOW + 1000,
    };

    handlePostResponse(input);

    expect(db.getBlock("B_REF")!.unused_turns).toBe(0);
    expect(db.getBlock("B_IDLE")!.unused_turns).toBe(1);
  });

  it("returns referenced_count and unreferenced_count in result", () => {
    seedBlock("B_REF", "src/auth.py", 0);
    seedBlock("B_IDLE", null, 0);
    seedTurn("T_COUNTS");

    const result = handlePostResponse({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_COUNTS",
      assistant_message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }],
      },
      detection_blocks: [
        { id: "B_REF", content: "auth content", file_path: "src/auth.py" },
        { id: "B_IDLE", content: "idle content longer than forty chars for sure yes indeed", file_path: null },
      ],
      db,
      now: NOW + 1000,
    });

    expect(result.referenced_count).toBe(1);
    expect(result.unreferenced_count).toBe(1);
    expect(result.signals).toContain("post_response_processed");
  });

  it("is fail-open: does not throw on a broken db, returns error signal", () => {
    const input: PostResponseInput = {
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_ERR",
      assistant_message: { role: "assistant", content: [] },
      detection_blocks: [],
      db: null as unknown as CachelaneDb,
      now: NOW,
    };

    let result: ReturnType<typeof handlePostResponse> | undefined;
    expect(() => { result = handlePostResponse(input); }).not.toThrow();
    expect(result?.signals).toContain("error:fallback");
  });

  it("only processes blocks present in detection_blocks — blocks from other sessions not passed by the caller are untouched", () => {
    // Insert a block for sess-2 directly. The handler is told it's running for sess-1.
    // The detection_blocks list only contains sess-1 blocks (sess-2 not passed).
    // This ensures the handler only acts on what it's given.
    db.insertBlock({
      id: "B_SESS2",
      workspace_id: "ws-1",
      session_id: "sess-2",
      content_hash: "0".repeat(64),
      kind: "file_read",
      volatility: "SEMI",
      is_pinned: false,
      token_count: 100,
      added_at_turn: 1,
      last_referenced_at_turn: 1,
      unused_turns: 0,
      is_stub: false,
      stub_summary: null,
      refetch_handle: "view:src/auth.py:1-50",
      created_at: NOW,
      updated_at: NOW,
    });
    seedTurn("T_ISOLATION");

    handlePostResponse({
      workspace_id: "ws-1",
      session_id: "sess-1",
      turn_number: 2,
      turn_id: "T_ISOLATION",
      assistant_message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }],
      },
      detection_blocks: [],  // sess-2 block is NOT in the list
      db,
      now: NOW + 1000,
    });

    // sess-2 block must be unchanged
    expect(db.getBlock("B_SESS2")!.unused_turns).toBe(0);
  });
});
