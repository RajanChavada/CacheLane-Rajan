import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentScenarios } from "../runner.js";

function writeScenario(dir: string, index: number): void {
  const id = `scenario-${index}`;
  writeFileSync(
    join(dir, `${index.toString().padStart(2, "0")}-${id}.json`),
    JSON.stringify({
      id,
      title: `Scenario ${index}`,
      description: "Fake provider integration scenario.",
      prompt: `Summarize src/${id}.ts.`,
      workspace_files: [
        {
          path: `src/${id}.ts`,
          content:
            "export const value = 'trace'; This file content is deliberately long enough to be referenced by the fake provider.",
        },
      ],
      expected_references: [`src/${id}.ts`],
      tags: ["fake"],
    }),
  );
}

describe("agent scenario runner", () => {
  it("runs three fake scenarios and writes raw, normalized, and report outputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cachelane-runner-"));
    const scenarioDir = join(root, "scenarios");
    const outputRoot = join(root, "runs");
    writeFileSync(join(root, ".keep"), "");
    await import("node:fs/promises").then((fs) => fs.mkdir(scenarioDir));
    writeScenario(scenarioDir, 1);
    writeScenario(scenarioDir, 2);
    writeScenario(scenarioDir, 3);

    const result = await runAgentScenarios({
      provider: "fake",
      count: 3,
      scenarioDir,
      outputRoot,
      runId: "test-run",
      now: () => new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(existsSync(join(result.raw_dir, "scenario-1.json"))).toBe(true);
    expect(existsSync(join(result.normalized_dir, "scenario-1.json"))).toBe(true);
    expect(existsSync(result.report_path)).toBe(true);
    expect(result.report.counts.sessions).toBe(3);
    expect(result.report.counts.turns).toBe(3);
  });

  it("keeps generated run directories ignored by git", () => {
    const gitignore = readFileSync(resolve(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toContain("benchmark/runs/");
  });
});
