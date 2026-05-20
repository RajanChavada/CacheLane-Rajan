import type { DetectionBlock, DetectionResult, AssistantMessage } from "./types.js";
import { detectByFilePath, detectByIdMention, detectByShingle } from "./signals.js";

export type {
  DetectionBlock,
  DetectionResult,
  DetectedReference,
  AssistantMessage,
  SignalNumber,
} from "./types.js";

// Evaluates the three reference-detection signals in spec order (REQ-F-023):
//   1. File paths in tool call arguments   — O(B), cheapest
//   2. Block IDs in assistant text/tools   — O(B), cheap
//   3. 40-char shingle overlap             — O(B × C × T), skipped for already-matched blocks
export function detectReferences(
  blocks: DetectionBlock[],
  message: AssistantMessage,
): DetectionResult {
  const referenced_ids = new Set<string>();
  const references = [];

  // Signal 1
  for (const ref of detectByFilePath(blocks, message)) {
    referenced_ids.add(ref.block_id);
    references.push(ref);
  }

  // Signal 2 — skip already matched
  const afterS1 = blocks.filter((b) => !referenced_ids.has(b.id));
  for (const ref of detectByIdMention(afterS1, message)) {
    referenced_ids.add(ref.block_id);
    references.push(ref);
  }

  // Signal 3 — skip already matched (expensive; only for unmatched blocks)
  const afterS2 = afterS1.filter((b) => !referenced_ids.has(b.id));
  for (const ref of detectByShingle(afterS2, message)) {
    referenced_ids.add(ref.block_id);
    references.push(ref);
  }

  return { referenced_ids, references };
}
