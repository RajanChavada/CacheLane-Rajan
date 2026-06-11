import fs from "node:fs";
import { openDatabase } from "../storage/index.js";
import { loadConfig, defaultWorkspaceId } from "../config/index.js";
import { cachelaneConfigPath, cachelaneDbPath } from "./paths.js";
import { CacheStateTracker } from "../orchestrator/index.js";
import { logger } from "../logger/index.js";

// A singleton tracker for hook mode (though CLI runs are ephemeral, we keep the pattern)
const hookTracker = new CacheStateTracker();

export async function handleHookMutate(
  env: NodeJS.ProcessEnv,
  parsed: Record<string, unknown>
): Promise<string | undefined> {
  // If the hook payload doesn't contain a prompt, we can't do anything
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : null;
  if (!prompt) return undefined;

  const workspaceId = env.CACHELANE_WORKSPACE_ID ?? defaultWorkspaceId();
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "default";

  // TODO: We will need to decide whether we mutate the `prompt` string
  // or return a full JSON structure depending on Claude Code's capabilities.
  // For now, we will demonstrate modifying the text prompt to include 
  // CacheLane injected metadata.

  let mutatedPrompt = prompt;

  // Let's check if there is a transcript we can read to get the conversation history.
  // If we can get the history, we can run our pruner and decide what to append to the prompt.
  const transcriptPath = typeof parsed.transcript_path === "string" ? parsed.transcript_path : null;

  try {
    const dbPath = cachelaneDbPath(env);
    const configPath = cachelaneConfigPath(env);
    const db = openDatabase(dbPath);
    const config = loadConfig(configPath);

    // Apply any prompt-level mutations here based on DB stats or pruning logic
    if (config.features.mutation_enabled) {
      // Temporary mutation: append a cache marker or instruction.
      // In a full implementation, we'd invoke the classifier/pruner here
      // and append instructions to the prompt to ignore pruned tools.
      
      mutatedPrompt = prompt + "\n\n[CacheLane: Pruning active... (AWS Hook Mode)]";
    }

    db.close();
  } catch (err) {
    logger.error("hook-mutate pipeline error", err instanceof Error ? err.message : String(err));
    // Fail open
    return undefined;
  }

  // If the prompt changed, return it so Claude Code uses the mutated prompt.
  if (mutatedPrompt !== prompt) {
    return mutatedPrompt;
  }

  // No mutation, return undefined
  return undefined;
}
