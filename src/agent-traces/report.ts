import { detectReferences } from "../reference-detector/index.js";
import type { AssistantMessage, DetectionBlock } from "../reference-detector/types.js";
import type { AgentTraceTurn, NormalizedTraceSession, TraceRunReport } from "./types.js";

function assistantMessageForTurn(turn: AgentTraceTurn): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: turn.assistant_text },
      ...turn.tool_calls.map((call, index) => ({
        type: "tool_use" as const,
        id: `tool-${turn.turn_number}-${index}`,
        name: call.name,
        input: call.input,
      })),
    ],
  };
}

function detectionBlocksForTurn(turn: AgentTraceTurn): DetectionBlock[] {
  return turn.blocks_in_prompt.map((block) => ({
    id: block.id,
    content: block.content,
    file_path: block.file_path ?? null,
  }));
}

function referencedCandidatesForTurn(turn: AgentTraceTurn): number {
  const result = detectReferences(detectionBlocksForTurn(turn), assistantMessageForTurn(turn));
  return result.referenced_ids.size;
}

export function generateTraceReport(input: {
  run_id: string;
  generated_at: string;
  provider: TraceRunReport["provider"];
  dry_run: boolean;
  sessions: NormalizedTraceSession[];
}): TraceRunReport {
  const scenarios = input.sessions.map((session) => {
    const turns = session.turns.length;
    const blocks = session.turns.reduce((sum, turn) => sum + turn.blocks_in_prompt.length, 0);
    const toolCalls = session.turns.reduce((sum, turn) => sum + turn.tool_calls.length, 0);
    const referencedCandidates = session.turns.reduce(
      (sum, turn) => sum + referencedCandidatesForTurn(turn),
      0,
    );

    return {
      scenario_id: session.scenario_id,
      session_id: session.session_id,
      turns,
      blocks,
      tool_calls: toolCalls,
      referenced_candidates: referencedCandidates,
    };
  });

  return {
    run_id: input.run_id,
    generated_at: input.generated_at,
    provider: input.provider,
    dry_run: input.dry_run,
    counts: {
      sessions: input.sessions.length,
      turns: scenarios.reduce((sum, row) => sum + row.turns, 0),
      blocks: scenarios.reduce((sum, row) => sum + row.blocks, 0),
      tool_calls: scenarios.reduce((sum, row) => sum + row.tool_calls, 0),
      referenced_candidates: scenarios.reduce((sum, row) => sum + row.referenced_candidates, 0),
    },
    scenarios,
  };
}
