import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertThreadRollbackOutput } from "../thread_rollback/codex_output.ts";

/** Codex thread/revert requires a loaded thread; successor sessions must resume it first. */
export function assertThreadRollbackAfterRestartOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertThreadRollbackOutput(result, transcript);
  const methods = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" &&
    typeof entry.frame === "object" &&
    entry.frame !== null &&
    "method" in entry.frame
      ? [String(entry.frame.method)]
      : [],
  );
  const revert = methods.indexOf("thread/revert");
  assert.isAbove(revert, 0, "the rollback must reach thread/revert");
  assert.equal(
    methods.lastIndexOf("thread/resume", revert),
    revert - 2,
    "the fresh app-server must resume the thread right before listing turns and reverting",
  );
}
