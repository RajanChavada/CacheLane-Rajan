import type { DetectionBlock, DetectedReference, AssistantMessage } from "./types.js";

const SHINGLE_SIZE = 40;

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function extractToolCallArgStrings(message: AssistantMessage): string[] {
  return message.content
    .filter(
      (c): c is { type: "tool_use"; id: string; name: string; input: unknown } =>
        c.type === "tool_use",
    )
    .map((c) => {
      try {
        return JSON.stringify(c.input);
      } catch {
        return "";
      }
    });
}

// Signal 1 — REQ-F-023: exact substring match of block.file_path in any tool call input JSON
export function detectByFilePath(
  blocks: DetectionBlock[],
  message: AssistantMessage,
): DetectedReference[] {
  const toolArgStrings = extractToolCallArgStrings(message);
  if (toolArgStrings.length === 0) return [];
  const combined = toolArgStrings.join(" ");
  const refs: DetectedReference[] = [];
  for (const block of blocks) {
    if (!block.file_path) continue;
    // Substring match is intentionally loose: a short path like "index.ts" can match
    // inside unrelated JSON (e.g. "reindex.ts"). This produces false positives (counter
    // resets that weren't needed) but never false negatives — conservative for billing.
    if (combined.includes(block.file_path)) {
      refs.push({
        block_id: block.id,
        signal: 1,
        reference_type: "tool_call",
        evidence: `file_path=${block.file_path}`,
      });
    }
  }
  return refs;
}

// Signal 2 — REQ-F-023: substring match of block.id in text AND tool call strings
export function detectByIdMention(
  blocks: DetectionBlock[],
  message: AssistantMessage,
): DetectedReference[] {
  const text = extractAssistantText(message);
  const toolArgs = extractToolCallArgStrings(message).join(" ");
  const searchable = `${text} ${toolArgs}`;
  const refs: DetectedReference[] = [];
  for (const block of blocks) {
    const idx = searchable.indexOf(block.id);
    if (idx !== -1) {
      const start = Math.max(0, idx - 20);
      const end = Math.min(searchable.length, idx + block.id.length + 20);
      refs.push({
        block_id: block.id,
        signal: 2,
        reference_type: "id_mention",
        evidence: searchable.slice(start, end),
      });
    }
  }
  return refs;
}

// Signal 3 — REQ-F-023: exact 40-char sliding-window substring match
// Only call this for blocks not already matched by signals 1 or 2.
export function detectByShingle(
  blocks: DetectionBlock[],
  message: AssistantMessage,
): DetectedReference[] {
  const text = extractAssistantText(message);
  if (!text) return [];
  const refs: DetectedReference[] = [];
  // O(B × C/40 × T) worst case; the break on first match bounds per-block work to
  // O(C × T). Acceptable for typical sessions (B≤200, C≤2000, T≤10000).
  for (const block of blocks) {
    if (block.content.length < SHINGLE_SIZE) continue;
    for (let i = 0; i <= block.content.length - SHINGLE_SIZE; i++) {
      const shingle = block.content.slice(i, i + SHINGLE_SIZE);
      if (text.includes(shingle)) {
        refs.push({
          block_id: block.id,
          signal: 3,
          reference_type: "text_quote",
          evidence: shingle,
        });
        break; // one match per block
      }
    }
  }
  return refs;
}
