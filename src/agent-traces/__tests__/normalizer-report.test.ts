import { describe, expect, it } from "vitest";
import { createTraceBlock } from "../blocks.js";
import { normalizeTrace } from "../normalizer.js";
import { generateTraceReport } from "../report.js";
import type { RawTraceSession } from "../types.js";

describe("agent trace normalization and reports", () => {
  it("normalizes raw provider turns into CorpusTurn-compatible records", () => {
    const block = createTraceBlock({
      kind: "file_read",
      file_path: "src/a.ts",
      content: "export const cachedPrefix = 'stable'; This line is long enough for shingle detection.",
      salt: "normalizer",
    });
    const raw: RawTraceSession = {
      session_id: "session-1",
      provider: "fake",
      scenario_id: "scenario-1",
      started_at: "2026-05-20T00:00:00.000Z",
      ended_at: "2026-05-20T00:00:00.000Z",
      turns: [
        {
          assistant_text: "I read src/a.ts and found cachedPrefix.",
          tool_calls: [{ name: "read_file", input: { path: "src/a.ts" } }],
          prompt_blocks: [block],
        },
      ],
    };

    const normalized = normalizeTrace(raw);

    expect(normalized.turns).toEqual([
      {
        turn_number: 0,
        assistant_text: "I read src/a.ts and found cachedPrefix.",
        tool_calls: [{ name: "read_file", input: { path: "src/a.ts" } }],
        blocks_in_prompt: [block],
      },
    ]);
  });

  it("counts sessions, turns, blocks, tool calls, and referenced candidates", () => {
    const block = createTraceBlock({
      kind: "file_read",
      file_path: "src/a.ts",
      content: "export const cachedPrefix = 'stable'; This line is long enough for shingle detection.",
      salt: "report",
    });
    const normalized = normalizeTrace({
      session_id: "session-1",
      provider: "fake",
      scenario_id: "scenario-1",
      started_at: "2026-05-20T00:00:00.000Z",
      ended_at: "2026-05-20T00:00:00.000Z",
      turns: [
        {
          assistant_text: "I read src/a.ts and found cachedPrefix.",
          tool_calls: [{ name: "read_file", input: { path: "src/a.ts" } }],
          prompt_blocks: [block],
        },
      ],
    });

    const report = generateTraceReport({
      run_id: "run",
      generated_at: "2026-05-20T00:00:00.000Z",
      provider: "fake",
      dry_run: false,
      sessions: [normalized],
    });

    expect(report.counts).toEqual({
      sessions: 1,
      turns: 1,
      blocks: 1,
      tool_calls: 1,
      referenced_candidates: 1,
    });
  });
});
