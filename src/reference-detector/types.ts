// src/reference-detector/types.ts

// Signal number corresponds to spec §Reference Detection evaluation order
export type SignalNumber = 1 | 2 | 3;

// Transient per-block metadata the detector needs.
// Content is NEVER persisted (REQ-F-015); callers pass it at runtime.
export interface DetectionBlock {
  id: string;               // Signal 2: exact substring search in assistant output
  content: string;          // Signal 3: 40-char shingle match against assistant output
  file_path: string | null; // Signal 1: exact match in assistant tool call arguments
}

export interface DetectedReference {
  block_id: string;
  signal: SignalNumber;
  reference_type: "tool_call" | "id_mention" | "text_quote";
  evidence: string; // short snippet (≤ 200 chars) proving the match
}

export interface DetectionResult {
  referenced_ids: Set<string>;
  references: DetectedReference[];
}

// Minimal shape of the assistant response needed for detection.
// Defined here to avoid importing from the orchestrator (upward dependency).
export interface AssistantMessage {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
}
