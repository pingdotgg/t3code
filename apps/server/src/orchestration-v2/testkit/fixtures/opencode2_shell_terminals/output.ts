import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_SHELL_DELETION_PROMPT,
  OPENCODE2_SHELL_FAILURE_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2ShellTerminalsOutput(
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
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertUserMessagesInclude(projection, [
    OPENCODE2_SHELL_FAILURE_PROMPT,
    OPENCODE2_SHELL_DELETION_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, "shell failure fixture complete");
  assertAssistantTextIncludes(projection, "shell deletion fixture complete");

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.equal(commands.length, 2, "each tool and shell event pair must share one command row");

  const failed = commands.find((command) => command.input.includes("exit 7"));
  assert.isDefined(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.output, "shell failed");
  assert.equal(failed.exitCode, 7);

  const deleted = commands.find((command) => command.input.includes("sleep 60"));
  assert.isDefined(deleted);
  assert.equal(deleted.status, "failed");
  assert.isUndefined(deleted.exitCode);
}
