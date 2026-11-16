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
const SECOND_FINAL = "provider thread resume fixture second turn complete";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function assertPiProviderThreadResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const processStarts = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === "process_start"
      ? [entry.frame]
      : [],
  );
  assert.lengthOf(processStarts, 2, "the idle release must retire the first Pi process");
  const switches = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === "switch_session"
      ? [entry]
      : [],
  );
  const resumedArgs = field(processStarts[1], "args");
  assert.deepEqual(
    Array.isArray(resumedArgs) ? resumedArgs.slice(0, 4) : resumedArgs,
    ["--mode", "rpc", "--session", "/pi-sessions/session-1.jsonl"],
    "the respawned process must attach the first session file at startup",
  );
  assert.lengthOf(switches, 0, "an already attached session must not reload extensions");

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
  assert.equal(
    projection.providerThreads[0]?.nativeThreadRef?.nativeId,
    "/pi-sessions/session-1.jsonl",
  );
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.lengthOf(answers, 2);
  assert.include(answers[1], FIRST_FINAL, "the resumed session must remember the first answer");
  assert.include(answers[1], SECOND_FINAL);
}
