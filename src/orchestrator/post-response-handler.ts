import type { CachelaneDb } from "../storage/index.js";
import type { DetectionBlock, AssistantMessage } from "../reference-detector/index.js";
import { detectReferences } from "../reference-detector/index.js";

export type { DetectionBlock } from "../reference-detector/index.js";

export interface PostResponseInput {
  // Provided for caller context / future telemetry; handler trusts detection_blocks is pre-filtered to this session.
  workspace_id: string;
  session_id: string;
  turn_number: number;
  turn_id: string;
  assistant_message: AssistantMessage;
  // Caller provides block content — never read from DB (REQ-F-015)
  detection_blocks: DetectionBlock[];
  db: CachelaneDb;
  now: number; // ms epoch for updated_at stamps
}

export interface PostResponseResult {
  referenced_count: number;
  unreferenced_count: number;
  signals: string[];
}

export function handlePostResponse(input: PostResponseInput): PostResponseResult {
  try {
    // Guard: validate db is present before doing any work
    if (input.db == null) {
      throw new Error("db is required");
    }

    const result = detectReferences(input.detection_blocks, input.assistant_message);

    // Persist audit log entries first (before counter updates)
    for (const ref of result.references) {
      input.db.insertBlockReference({
        block_id: ref.block_id,
        turn_id: input.turn_id,
        reference_type: ref.reference_type,
        evidence: ref.evidence.slice(0, 200),
        created_at: input.now,
      });
    }

    // Update unused_turns for every detection block
    let unreferencedCount = 0;
    for (const block of input.detection_blocks) {
      if (result.referenced_ids.has(block.id)) {
        input.db.resetUnusedTurns(block.id, input.turn_number, input.now);
      } else {
        input.db.incrementUnusedTurns(block.id, input.now);
        unreferencedCount++;
      }
    }

    return {
      referenced_count: result.referenced_ids.size,
      unreferenced_count: unreferencedCount,
      signals: ["post_response_processed"],
    };
  } catch (err) {
    // Fail-open: never let PostResponse processing block the session
    console.error("[cachelane] handlePostResponse error", err);
    return {
      referenced_count: 0,
      unreferenced_count: 0,
      signals: ["error:fallback"],
    };
  }
}
