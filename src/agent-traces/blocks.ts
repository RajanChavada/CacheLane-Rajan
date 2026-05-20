import { createHash } from "node:crypto";
import type { ScenarioSpec, TraceBlockKind, TraceCorpusBlock } from "./types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function idTokenFor(id: string): string {
  return id.slice(0, 8);
}

export function createTraceBlock(input: {
  content: string;
  salt: string;
  kind: TraceBlockKind;
  file_path?: string;
}): TraceCorpusBlock {
  const id = sha256(`${input.salt}\u0000${input.content}`);
  return {
    id,
    id_token: idTokenFor(id),
    kind: input.kind,
    file_path: input.file_path,
    content: input.content,
  };
}

export function blocksForScenario(scenario: ScenarioSpec): TraceCorpusBlock[] {
  return scenario.workspace_files.map((file, index) =>
    createTraceBlock({
      kind: "file_read",
      file_path: file.path,
      content: file.content,
      salt: `${scenario.id}:${index}:${file.path}`,
    }),
  );
}
