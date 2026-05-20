import { describe, expect, it } from "vitest";
import {
  detectByFilePath,
  detectByIdMention,
  detectByShingle,
  extractAssistantText,
  extractToolCallArgStrings,
} from "../signals.js";
import type { DetectionBlock, AssistantMessage } from "../types.js";

function block(overrides: Partial<DetectionBlock> & { id: string }): DetectionBlock {
  return { content: "some block content", file_path: null, ...overrides };
}

function textMsg(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolMsg(name: string, input: unknown): AssistantMessage {
  return { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name, input }] };
}

describe("extractAssistantText", () => {
  it("concatenates multiple text blocks with newline separator", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "text", text: " world" },
      ],
    };
    expect(extractAssistantText(msg)).toBe("Hello\n world");
  });

  it("returns empty string when no text blocks present", () => {
    expect(extractAssistantText(toolMsg("Read", { path: "foo.ts" }))).toBe("");
  });
});

describe("extractToolCallArgStrings", () => {
  it("returns JSON string of each tool_use input", () => {
    const strs = extractToolCallArgStrings(toolMsg("Read", { file_path: "src/auth.py" }));
    expect(strs).toHaveLength(1);
    expect(strs[0]).toContain("src/auth.py");
  });

  it("returns empty array when no tool calls", () => {
    expect(extractToolCallArgStrings(textMsg("hi"))).toEqual([]);
  });

  it("handles non-serializable tool input without throwing", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "X", input: circular }],
    };
    expect(() => extractToolCallArgStrings(msg)).not.toThrow();
  });
});

describe("detectByFilePath — Signal 1", () => {
  it("detects block whose file_path appears in a tool call argument", () => {
    const blocks = [block({ id: "B1", file_path: "src/auth.py" })];
    const refs = detectByFilePath(blocks, toolMsg("Read", { file_path: "src/auth.py" }));
    expect(refs).toHaveLength(1);
    expect(refs[0].block_id).toBe("B1");
    expect(refs[0].signal).toBe(1);
    expect(refs[0].reference_type).toBe("tool_call");
  });

  it("returns empty when file_path not present in tool calls", () => {
    const blocks = [block({ id: "B1", file_path: "src/auth.py" })];
    expect(detectByFilePath(blocks, toolMsg("Read", { file_path: "src/other.py" }))).toHaveLength(0);
  });

  it("skips blocks with null file_path", () => {
    const blocks = [block({ id: "B1", file_path: null })];
    expect(detectByFilePath(blocks, toolMsg("Read", { file_path: "anything" }))).toHaveLength(0);
  });

  it("matches when block file_path is a substring of tool call string", () => {
    // "auth.py" is a substring of "src/auth.py" in the tool arg JSON
    const blocks = [block({ id: "B1", file_path: "auth.py" })];
    const refs = detectByFilePath(blocks, toolMsg("Read", { file_path: "src/auth.py" }));
    expect(refs).toHaveLength(1);
  });

  it("returns empty when there are no tool calls", () => {
    const blocks = [block({ id: "B1", file_path: "src/auth.py" })];
    expect(detectByFilePath(blocks, textMsg("no tools here"))).toHaveLength(0);
  });
});

describe("detectByIdMention — Signal 2", () => {
  it("detects block ID appearing in assistant text", () => {
    const blocks = [block({ id: "01J_BLOCK_001" })];
    const refs = detectByIdMention(blocks, textMsg("I referenced block 01J_BLOCK_001 in my analysis."));
    expect(refs).toHaveLength(1);
    expect(refs[0].block_id).toBe("01J_BLOCK_001");
    expect(refs[0].signal).toBe(2);
    expect(refs[0].reference_type).toBe("id_mention");
    expect(refs[0].evidence).toContain("01J_BLOCK_001");
  });

  it("detects block ID appearing in tool call args (not just text)", () => {
    const blocks = [block({ id: "01J_BLOCK_002" })];
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Expand", input: { block_id: "01J_BLOCK_002" } }],
    };
    const refs = detectByIdMention(blocks, msg);
    expect(refs).toHaveLength(1);
    expect(refs[0].block_id).toBe("01J_BLOCK_002");
  });

  it("returns empty when no ID appears anywhere", () => {
    const blocks = [block({ id: "01J_BLOCK_999" })];
    expect(detectByIdMention(blocks, textMsg("Nothing relevant here."))).toHaveLength(0);
  });
});

describe("detectByShingle — Signal 3", () => {
  const LONG_CONTENT =
    "def authenticate(user: str, password: str) -> bool:\n    # check credentials\n    return check_hash(password, user.hash)";

  it("detects when a 40-char shingle from block content appears in assistant text", () => {
    const shingle = LONG_CONTENT.slice(0, 40);
    const blocks = [block({ id: "B3", content: LONG_CONTENT })];
    const refs = detectByShingle(blocks, textMsg(`The function: ${shingle} and continues...`));
    expect(refs).toHaveLength(1);
    expect(refs[0].block_id).toBe("B3");
    expect(refs[0].signal).toBe(3);
    expect(refs[0].reference_type).toBe("text_quote");
    expect(refs[0].evidence).toBe(shingle);
  });

  it("returns empty when content is shorter than 40 chars", () => {
    const blocks = [block({ id: "B3", content: "short" })];
    expect(detectByShingle(blocks, textMsg("short"))).toHaveLength(0);
  });

  it("returns empty when no shingle matches", () => {
    const blocks = [block({ id: "B3", content: LONG_CONTENT })];
    expect(detectByShingle(blocks, textMsg("completely unrelated response"))).toHaveLength(0);
  });

  it("reports only one match per block (first matching shingle)", () => {
    const blocks = [block({ id: "B3", content: LONG_CONTENT })];
    const refs = detectByShingle(blocks, textMsg(LONG_CONTENT)); // full content in output
    expect(refs).toHaveLength(1);
  });

  it("content exactly 40 chars is eligible for shingle matching", () => {
    const content = "a".repeat(40);
    const blocks = [block({ id: "B3", content })];
    expect(detectByShingle(blocks, textMsg(`prefix ${"a".repeat(40)} suffix`))).toHaveLength(1);
  });
});
