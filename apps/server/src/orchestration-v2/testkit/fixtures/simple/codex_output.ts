import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertExecutionNodeKinds,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  SIMPLE_PROMPT,
} from "../shared.ts";

export function assertSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1]);
  assertExecutionNodeKinds(projection, ["root_turn", "assistant_message"]);
  assertConversationMessageRoles(projection, ["user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [SIMPLE_PROMPT]);
  assertAssistantTextIncludes(projection, "fixture simple ok");
}
