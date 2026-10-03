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
import { CLAUDE_AGENT_MESSAGE_REFUSED_PROMPT } from "./input.ts";

// Claude Code answers a SendMessage to an unknown recipient with an ordinary
// tool result whose payload says `success: false`. The message was never
// delivered, so its row reads as a failed call.
export function assertClaudeAgentMessageRefusedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_AGENT_MESSAGE_REFUSED_PROMPT]);

  const messages = projection.turnItems.flatMap((item) =>
    item.type === "dynamic_tool" && item.toolName === "SendMessage" ? [item] : [],
  );
  assert.lengthOf(messages, 1);
  const [message] = messages;
  assert.equal(message?.status, "failed");
  assert.equal(message?.title, "Message to ghost-agent");
}
