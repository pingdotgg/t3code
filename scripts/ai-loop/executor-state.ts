import { loadAiLoopConfig } from "./config";
import { GitHubRepoClient } from "./github";
import { parseAiLoopPrMetadata } from "./pr-metadata";
import { createDefaultStickyState } from "./state";

const readRequiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const main = async (): Promise<void> => {
  const mode = process.argv[2];
  if (mode !== "start" && mode !== "finish") {
    throw new Error("Usage: bun run scripts/ai-loop/executor-state.ts <start|finish>");
  }

  const repository = readRequiredEnv("GITHUB_REPOSITORY");
  const token = readRequiredEnv("GITHUB_TOKEN");
  const prNumber = Number.parseInt(readRequiredEnv("AI_LOOP_PR_NUMBER"), 10);
  const config = await loadAiLoopConfig();
  const github = new GitHubRepoClient(repository, token);
  const pullRequest = await github.getPullRequest(prNumber);
  const prMetadata = parseAiLoopPrMetadata(pullRequest.body ?? "");
  const fallbackState = createDefaultStickyState(prMetadata.owner, pullRequest.head.sha);
  const state = await github.loadOrCreateStickyState(prNumber, fallbackState);

  if (mode === "start") {
    await github.upsertStickyComment(prNumber, {
      ...state,
      status: "running",
      attempts_used: state.attempts_used + 1,
      current_sha: pullRequest.head.sha,
      last_processed_at: new Date().toISOString(),
      executor_run_id: process.env.GITHUB_RUN_ID ?? null,
    });
    return;
  }

  const finalStatus = readRequiredEnv("AI_LOOP_FINAL_STATUS");
  const allowedStatus = new Set(["pushed_pending", "blocked", "clean"]);
  if (!allowedStatus.has(finalStatus)) {
    throw new Error(`Invalid AI_LOOP_FINAL_STATUS "${finalStatus}".`);
  }

  await github.upsertStickyComment(prNumber, {
    ...state,
    status: finalStatus as "pushed_pending" | "blocked" | "clean",
    current_sha: readRequiredEnv("AI_LOOP_CURRENT_SHA"),
    last_result_fingerprint:
      process.env.AI_LOOP_FINDING_SET_FINGERPRINT ?? state.last_result_fingerprint,
    blocked_reason:
      finalStatus === "blocked" ? process.env.AI_LOOP_BLOCKED_REASON || "executor_blocked" : null,
    last_processed_at: new Date().toISOString(),
    executor_run_id: process.env.GITHUB_RUN_ID ?? state.executor_run_id,
  });
};

await main();
