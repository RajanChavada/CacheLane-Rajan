import { describe, expect, it } from "vitest";
import { detectReferences } from "../index.js";
import type { DetectionBlock } from "../types.js";

const LONG_TEXT =
  "function authenticateUser(username, password) { return verify(username, hash(password)); }";

function block(id: string, file_path: string | null = null, content = "default content"): DetectionBlock {
  return { id, file_path, content };
}

describe("detectReferences — combined evaluation", () => {
  it("returns empty result when no blocks are referenced", () => {
    const result = detectReferences(
      [block("B1", "src/auth.py", LONG_TEXT)],
      { role: "assistant", content: [{ type: "text", text: "Nothing relevant." }] },
    );
    expect(result.referenced_ids.size).toBe(0);
    expect(result.references).toHaveLength(0);
  });

  it("signal 1 match populates referenced_ids with reference_type tool_call", () => {
    const result = detectReferences(
      [block("B1", "src/auth.py")],
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }] },
    );
    expect(result.referenced_ids.has("B1")).toBe(true);
    expect(result.references[0].signal).toBe(1);
  });

  it("signal 2 match populates referenced_ids with reference_type id_mention", () => {
    const result = detectReferences(
      [block("01JBLOCK000001")],
      { role: "assistant", content: [{ type: "text", text: "Referencing block 01JBLOCK000001." }] },
    );
    expect(result.referenced_ids.has("01JBLOCK000001")).toBe(true);
    expect(result.references[0].signal).toBe(2);
  });

  it("signal 3 match populates referenced_ids with reference_type text_quote", () => {
    const shingle = LONG_TEXT.slice(0, 40);
    const result = detectReferences(
      [block("B3", null, LONG_TEXT)],
      { role: "assistant", content: [{ type: "text", text: `Code: ${shingle}` }] },
    );
    expect(result.referenced_ids.has("B3")).toBe(true);
    expect(result.references[0].signal).toBe(3);
  });

  it("block matched by signal 1 is NOT passed to signal 3 (evaluation-order invariant)", () => {
    // B1 matches on Signal 1 (file path). The same content also has a shingle match.
    // Signal 3 must be skipped for B1 — result must contain exactly ONE reference entry (signal=1).
    const result = detectReferences(
      [block("B1", "src/auth.py", LONG_TEXT)],
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } },
          { type: "text", text: LONG_TEXT },
        ],
      },
    );
    expect(result.referenced_ids.has("B1")).toBe(true);
    expect(result.references).toHaveLength(1);
    expect(result.references[0].signal).toBe(1);
  });

  it("multiple blocks matched by different signals in one call", () => {
    const shingle = LONG_TEXT.slice(0, 40);
    const result = detectReferences(
      [block("B1", "src/auth.py"), block("B2", null, LONG_TEXT)],
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } },
          { type: "text", text: `Result: ${shingle}` },
        ],
      },
    );
    expect(result.referenced_ids.has("B1")).toBe(true);
    expect(result.referenced_ids.has("B2")).toBe(true);
    expect(result.references).toHaveLength(2);
  });

  it("does not throw on empty blocks array", () => {
    expect(() =>
      detectReferences([], { role: "assistant", content: [{ type: "text", text: "hi" }] }),
    ).not.toThrow();
  });

  it("does not throw on empty assistant content array", () => {
    expect(() =>
      detectReferences([block("B1", "src/auth.py")], { role: "assistant", content: [] }),
    ).not.toThrow();
  });

  it("referenced_ids is a Set — membership test works", () => {
    const result = detectReferences(
      [block("B1", "src/auth.py")],
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/auth.py" } }] },
    );
    expect(result.referenced_ids instanceof Set).toBe(true);
    expect(result.referenced_ids.has("B1")).toBe(true);
    expect(result.referenced_ids.has("NONEXISTENT")).toBe(false);
  });
});
