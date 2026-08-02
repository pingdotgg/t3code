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
  OPENCODE2_SHELL_PROJECTION_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2ShellProjectionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertConversationMessageRoles(projection, ["user", "assistant"]);
  assertUserMessagesInclude(projection, [OPENCODE2_SHELL_PROJECTION_PROMPT]);
  assertAssistantTextIncludes(projection, "shell projection fixture complete");

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.equal(commands.length, 1, "the tool and shell event families must share one command row");
  const command = commands[0];
  assert.isDefined(command);
  assert.equal(command.status, "completed");
  assert.include(command.input, "printf");
  assert.equal(command.output, "shell page one shell page two");
  assert.equal(command.exitCode, 0);
}
