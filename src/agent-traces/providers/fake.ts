import { blocksForScenario } from "../blocks.js";
import type { ProviderAdapter, RawTraceSession, ScenarioSpec } from "../types.js";

function assistantTextForScenario(scenario: ScenarioSpec): string {
  if (scenario.tags.includes("true-negative")) {
    return `Scenario ${scenario.id}: no prior block is needed for this response.`;
  }

  const firstFile = scenario.workspace_files[0];
  if (!firstFile) return `Scenario ${scenario.id}: completed without workspace context.`;

  return [
    `Scenario ${scenario.id}: referenced ${firstFile.path}.`,
    firstFile.content.slice(0, 160),
  ].join("\n");
}

export function createFakeAdapter(): ProviderAdapter {
  return {
    name: "fake",
    async runScenario(scenario, options): Promise<RawTraceSession> {
      const now = options.now().toISOString();
      const blocks = blocksForScenario(scenario);
      const firstBlock = blocks[0];
      const toolCalls =
        firstBlock && firstBlock.file_path && !scenario.tags.includes("true-negative")
          ? [{ name: "read_file", input: { path: firstBlock.file_path } }]
          : [];

      return {
        session_id: `${options.run_id}-${scenario.id}`,
        provider: "fake",
        scenario_id: scenario.id,
        started_at: now,
        ended_at: now,
        turns: [
          {
            assistant_text: assistantTextForScenario(scenario),
            tool_calls: toolCalls,
            prompt_blocks: blocks,
          },
        ],
      };
    },
  };
}
