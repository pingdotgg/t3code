import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { GROK_WAKE_AFTER_HANDLED_LAST_LINE, GROK_WAKE_AFTER_HANDLED_PROMPT } from "./input.ts";

// A task read inside the root turn makes later agent text for that task
// chatter. It must not silence Grok's wake reply for a different task that
// ended after the root prompt settled.
export function assertGrokBackgroundBashWakeAfterHandledOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [GROK_WAKE_AFTER_HANDLED_PROMPT]);

  const [rootRun, wakeRun] = projection.runs;
  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.isAtLeast(commands.length, 2);
  for (const command of commands) {
    assert.notEqual(command.status, "running", `${command.title} must not stay running`);
  }

  const rootTexts = projection.turnItems.flatMap((item) =>
    item.runId === rootRun?.id && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
  assert.include(rootTexts, "ROOT_DONE");

  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  const wakeTexts = projection.turnItems.flatMap((item) =>
    item.runId === wakeRun?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.include(
    wakeTexts.join("\n"),
    GROK_WAKE_AFTER_HANDLED_LAST_LINE,
    "Grok's reply to the second command must land in the continuation run",
  );
}
