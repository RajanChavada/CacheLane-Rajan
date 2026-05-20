import { blocksForScenario } from "../blocks.js";
import type { ProviderAdapter, RawTraceSession, RawTraceToolCall, ScenarioSpec } from "../types.js";

const DEFAULT_GLM_URL = "https://api.z.ai/api/paas/v4/chat/completions";
const DEFAULT_GLM_MODEL = "glm-5.1";

type FetchLike = typeof fetch;

export interface GlmAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

export interface GlmChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface GlmToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface GlmChatRequestBody {
  model: string;
  messages: GlmChatMessage[];
  tools: GlmToolDefinition[];
  temperature: number;
  stream: false;
  thinking: {
    type: "disabled";
  };
}

export interface GlmHttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: GlmChatRequestBody;
}

interface GlmToolCallResponse {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface GlmResponseChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: GlmToolCallResponse[];
  };
}

interface GlmResponseBody {
  choices?: GlmResponseChoice[];
}

function envApiKey(): string | undefined {
  return process.env.GLM_API_KEY ?? process.env.ZAI_API_KEY;
}

function scenarioPrompt(scenario: ScenarioSpec): string {
  const files = scenario.workspace_files
    .map((file) => `--- ${file.path}\n${file.content}`)
    .join("\n\n");

  return [
    "Run this scripted coding-agent scenario. Use tool calls when they are useful.",
    `Scenario: ${scenario.title}`,
    scenario.description,
    "",
    "Workspace context:",
    files || "(no files provided)",
    "",
    "User task:",
    scenario.prompt,
  ].join("\n");
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

export function glmToolDefinitions(): GlmToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a workspace file by path.",
        parameters: objectSchema({ path: { type: "string" } }, ["path"]),
      },
    },
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List relevant workspace files.",
        parameters: objectSchema({ pattern: { type: "string" } }, ["pattern"]),
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a safe local command and inspect its output.",
        parameters: objectSchema({ command: { type: "string" } }, ["command"]),
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Describe a small file edit by path.",
        parameters: objectSchema(
          { path: { type: "string" }, summary: { type: "string" } },
          ["path", "summary"],
        ),
      },
    },
  ];
}

export function buildGlmChatRequest(
  scenario: ScenarioSpec,
  options: GlmAdapterOptions = {},
): GlmHttpRequest {
  const apiKey = options.apiKey ?? envApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    method: "POST",
    url: options.baseUrl ?? DEFAULT_GLM_URL,
    headers,
    body: {
      model: options.model ?? process.env.GLM_MODEL ?? DEFAULT_GLM_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are producing realistic coding-agent trace material for benchmark replay.",
        },
        { role: "user", content: scenarioPrompt(scenario) },
      ],
      tools: glmToolDefinitions(),
      temperature: 0.2,
      stream: false,
      thinking: { type: "disabled" },
    },
  };
}

export function summarizeGlmRequest(request: GlmHttpRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: request.url,
    model: request.body.model,
    message_count: request.body.messages.length,
    tool_names: request.body.tools.map((tool) => tool.function.name),
    stream: request.body.stream,
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolCallsFromResponse(choice: GlmResponseChoice | undefined): RawTraceToolCall[] {
  return (choice?.message?.tool_calls ?? [])
    .filter((call) => typeof call.function?.name === "string")
    .map((call) => ({
      id: call.id,
      name: call.function?.name ?? "unknown",
      input: parseToolArguments(call.function?.arguments),
    }));
}

function responseText(choice: GlmResponseChoice | undefined): string {
  const content = choice?.message?.content;
  return typeof content === "string" ? content : "";
}

async function readResponseJson(response: Response): Promise<GlmResponseBody> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GLM request failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  return typeof parsed === "object" && parsed !== null ? (parsed as GlmResponseBody) : {};
}

export function createGlmAdapter(options: GlmAdapterOptions = {}): ProviderAdapter {
  return {
    name: "glm",
    async runScenario(scenario, runOptions): Promise<RawTraceSession> {
      const startedAt = runOptions.now().toISOString();
      const request = buildGlmChatRequest(scenario, options);
      const requestSummary = summarizeGlmRequest(request);

      if (runOptions.dry_run) {
        return {
          session_id: `${runOptions.run_id}-${scenario.id}`,
          provider: "glm",
          scenario_id: scenario.id,
          started_at: startedAt,
          ended_at: runOptions.now().toISOString(),
          request_summary: requestSummary,
          turns: [
            {
              assistant_text: `Dry run only. Planned GLM request for ${scenario.id}.`,
              prompt_blocks: blocksForScenario(scenario),
            },
          ],
        };
      }

      if (!request.headers.Authorization) {
        throw new Error("GLM provider requires GLM_API_KEY or ZAI_API_KEY unless --dry-run is set");
      }

      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      const json = await readResponseJson(response);
      const choice = json.choices?.[0];

      return {
        session_id: `${runOptions.run_id}-${scenario.id}`,
        provider: "glm",
        scenario_id: scenario.id,
        started_at: startedAt,
        ended_at: runOptions.now().toISOString(),
        request_summary: requestSummary,
        turns: [
          {
            assistant_text: responseText(choice),
            tool_calls: toolCallsFromResponse(choice),
            prompt_blocks: blocksForScenario(scenario),
          },
        ],
      };
    },
  };
}
