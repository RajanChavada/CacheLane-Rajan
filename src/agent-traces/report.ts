import { detectReferences, type ReferenceTurn } from "../references/index.js";
import type { AgentTraceTurn, NormalizedTraceSession, TraceRunReport } from "./types.js";

function referencedCandidatesForTurn(turn: AgentTraceTurn): number {
  const result = detectReferences(turn as unknown as ReferenceTurn);
  return result.size;
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
