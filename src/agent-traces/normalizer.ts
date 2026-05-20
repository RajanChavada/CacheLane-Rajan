import { readFileSync } from "node:fs";
import { createTraceBlock } from "./blocks.js";
import type {
  AgentTraceTurn,
  NormalizedTraceSession,
  RawTraceContentBlock,
  RawTraceSession,
  RawTraceToolCall,
  RawTraceTurn,
  TraceCorpusBlock,
  TraceToolCall,
} from "./types.js";

interface RawTranscriptEvent {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface TranscriptMessage {
  role: string;
  content: RawTraceContentBlock[];
}

const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path", "target_file"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toContentBlocks(content: unknown): RawTraceContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];

  const blocks: RawTraceContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      blocks.push({
        type: "tool_use",
        id: typeof block.id === "string" ? block.id : undefined,
        name: block.name,
        input: isRecord(block.input) ? block.input : {},
      });
    } else if (block.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        content: block.content,
      });
    }
  }
  return blocks;
}

function textOf(blocks: RawTraceContentBlock[] | undefined): string {
  return (blocks ?? [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolCallsFromContent(blocks: RawTraceContentBlock[] | undefined): RawTraceToolCall[] {
  return (blocks ?? [])
    .filter(
      (block): block is { type: "tool_use"; id?: string; name: string; input?: Record<string, unknown> } =>
        block.type === "tool_use",
    )
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    }));
}

function toToolCalls(turn: RawTraceTurn): TraceToolCall[] {
  const calls = [...(turn.tool_calls ?? []), ...toolCallsFromContent(turn.content)];
  const seen = new Set<string>();
  const out: TraceToolCall[] = [];

  for (const call of calls) {
    const key = `${call.name}\u0000${JSON.stringify(call.input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: call.name, input: call.input });
  }

  return out;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function decomposePromptBlocks(messages: TranscriptMessage[]): TraceCorpusBlock[] {
  const blocks: TraceCorpusBlock[] = [];
  const toolUsePath = new Map<string, string>();
  let index = 0;

  for (const message of messages) {
    for (const block of message.content) {
      index += 1;
      if (block.type === "tool_use") {
        const path = extractPath(block.input);
        if (path && block.id) toolUsePath.set(block.id, path);
        continue;
      }

      if (block.type === "text") {
        if (!block.text.trim()) continue;
        blocks.push(
          createTraceBlock({
            kind: message.role === "user" ? "user_message" : "prior_turn",
            content: block.text,
            salt: `${index}:${message.role}`,
          }),
        );
        continue;
      }

      const content = stringifyContent(block.content);
      if (!content.trim()) continue;
      const filePath = block.tool_use_id ? toolUsePath.get(block.tool_use_id) : undefined;
      blocks.push(
        createTraceBlock({
          kind: filePath ? "file_read" : "tool_output",
          file_path: filePath,
          content,
          salt: `${index}:${block.tool_use_id ?? "tool-result"}`,
        }),
      );
    }
  }

  return blocks;
}

function parseTranscriptLine(line: string): RawTranscriptEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    return {
      type: parsed.type,
      message: isRecord(parsed.message)
        ? {
            role: typeof parsed.message.role === "string" ? parsed.message.role : undefined,
            content: parsed.message.content,
          }
        : undefined,
    };
  } catch {
    return null;
  }
}

function rawTurnsFromClaudeTranscript(path: string): RawTraceTurn[] {
  const events = readFileSync(path, "utf8")
    .split("\n")
    .map(parseTranscriptLine)
    .filter((event): event is RawTranscriptEvent => event !== null);

  const priorMessages: TranscriptMessage[] = [];
  const turns: RawTraceTurn[] = [];

  for (const event of events) {
    if (event.type !== "user" && event.type !== "assistant") continue;
    const role = event.message?.role ?? event.type;
    const content = toContentBlocks(event.message?.content);

    if (role === "assistant") {
      turns.push({
        content,
        prompt_blocks: decomposePromptBlocks(priorMessages),
      });
    }

    priorMessages.push({ role, content });
  }

  return turns;
}

function normalizeTurn(turn: RawTraceTurn, turnNumber: number): AgentTraceTurn {
  return {
    turn_number: turnNumber,
    assistant_text: turn.assistant_text ?? textOf(turn.content),
    tool_calls: toToolCalls(turn),
    blocks_in_prompt: (turn.prompt_blocks ?? []).map((block) => ({ ...block })),
  };
}

export function normalizeTrace(raw: RawTraceSession): NormalizedTraceSession {
  const rawTurns =
    raw.turns.length > 0
      ? raw.turns
      : raw.transcript_path
        ? rawTurnsFromClaudeTranscript(raw.transcript_path)
        : [];

  return {
    session_id: raw.session_id,
    provider: raw.provider,
    scenario_id: raw.scenario_id,
    source: {
      transcript_path: raw.transcript_path,
    },
    turns: rawTurns.map((turn, index) => normalizeTurn(turn, index)),
  };
}
