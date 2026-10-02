import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SKILL_INVOCATION_CURSOR_MESSAGE,
  SKILL_INVOCATION_PROMPT,
} from "../shared.ts";
import { SKILL_INVOCATION_FINAL } from "./input.ts";

export function assertSkillInvocationCursorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // Replay matches outbound frames exactly, so reaching completion already
  // proves the adapter sent `/review` for the discovered workspace skill.
  const sentMessages = transcript.entries.flatMap((entry) => {
    if (entry.type !== "expect_outbound") return [];
    const frame = entry.frame as { readonly type?: unknown; readonly message?: unknown };
    return frame.type === "run.start" && typeof frame.message === "string" ? [frame.message] : [];
  });
  assert.lengthOf(sentMessages, 1);
  assert.isTrue(
    sentMessages[0]?.startsWith(`${SKILL_INVOCATION_CURSOR_MESSAGE}\n\n`),
    "discovered $skill mentions must reach Cursor as native slash invocations",
  );

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  // The user's own text stays as typed; only the provider sees the rewrite.
  assertUserMessagesInclude(projection, [SKILL_INVOCATION_PROMPT]);
  assertAssistantTextIncludes(projection, SKILL_INVOCATION_FINAL);
}
