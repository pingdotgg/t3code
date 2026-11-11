import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "../shared.ts";

const FIRST_FINAL = "provider thread resume fixture first turn complete";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * After the idle release a fresh `kiro-cli acp` process must `session/load`
 * the first session, and the resumed model still sees the first exchange.
 */
export function assertKiroProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const requests = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "kind") === "request"
      ? [field(entry.frame, "method")]
      : [],
  );
  assert.equal(
    requests.filter((method) => method === "initialize").length,
    2,
    "the idle release must retire the first Kiro process",
  );
  assert.deepEqual(
    requests.filter((method) => method === "session/new" || method === "session/load"),
    ["session/new", "session/load"],
    "the respawned process must load the first session, not start another",
  );

  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1, "resume must keep one provider thread");
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.include(answers.at(-1), FIRST_FINAL, "the resumed session must remember the first answer");
}
