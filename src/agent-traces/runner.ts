import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeTrace } from "./normalizer.js";
import { createClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./providers/claude-code.js";
import { createFakeAdapter } from "./providers/fake.js";
import { createGlmAdapter, type GlmAdapterOptions } from "./providers/glm.js";
import { generateTraceReport } from "./report.js";
import { loadScenarioSpecs, selectScenarios } from "./scenarios.js";
import type {
  AgentTraceProviderName,
  NormalizedTraceSession,
  ProviderAdapter,
  RawTraceSession,
  TraceRunReport,
} from "./types.js";

export interface RunAgentScenariosOptions {
  provider: AgentTraceProviderName | ProviderAdapter;
  count?: number;
  scenarioDir?: string;
  outputRoot?: string;
  runId?: string;
  dry_run?: boolean;
  now?: () => Date;
  glm?: GlmAdapterOptions;
  claudeCode?: ClaudeCodeAdapterOptions;
}

export interface RunAgentScenariosResult {
  run_id: string;
  run_dir: string;
  raw_dir: string;
  normalized_dir: string;
  report_path: string;
  report: TraceRunReport;
}

function defaultRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function adapterFor(
  provider: AgentTraceProviderName | ProviderAdapter,
  options: RunAgentScenariosOptions,
): ProviderAdapter {
  if (typeof provider !== "string") return provider;

  switch (provider) {
    case "fake":
      return createFakeAdapter();
    case "glm":
      return createGlmAdapter(options.glm);
    case "claude-code":
      return createClaudeCodeAdapter(options.claudeCode);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runAgentScenarios(
  options: RunAgentScenariosOptions,
): Promise<RunAgentScenariosResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runId = options.runId ?? defaultRunId(startedAt);
  const outputRoot = resolve(options.outputRoot ?? resolve(process.cwd(), "benchmark", "runs"));
  const runDir = resolve(outputRoot, runId);
  const rawDir = resolve(runDir, "raw");
  const normalizedDir = resolve(runDir, "normalized");
  const reportPath = resolve(runDir, "report.json");
  const adapter = adapterFor(options.provider, options);
  const scenarios = selectScenarios(loadScenarioSpecs(options.scenarioDir), options.count);

  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  const normalizedSessions: NormalizedTraceSession[] = [];

  for (const scenario of scenarios) {
    const raw: RawTraceSession = await adapter.runScenario(scenario, {
      dry_run: options.dry_run ?? false,
      run_id: runId,
      run_dir: runDir,
      now,
    });
    const normalized = normalizeTrace(raw);
    normalizedSessions.push(normalized);

    await writeJson(resolve(rawDir, `${scenario.id}.json`), raw);
    await writeJson(resolve(normalizedDir, `${scenario.id}.json`), normalized);
  }

  const report = generateTraceReport({
    run_id: runId,
    generated_at: now().toISOString(),
    provider: adapter.name,
    dry_run: options.dry_run ?? false,
    sessions: normalizedSessions,
  });
  await writeJson(reportPath, report);

  return {
    run_id: runId,
    run_dir: runDir,
    raw_dir: rawDir,
    normalized_dir: normalizedDir,
    report_path: reportPath,
    report,
  };
}
