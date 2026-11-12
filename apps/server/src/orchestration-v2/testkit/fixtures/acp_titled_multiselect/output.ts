import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { ACP_TITLED_MULTISELECT_PROMPT } from "./input.ts";

/** The transcript's expected `elicitation/create` response pins the typed answer. */
export function assertAcpTitledMultiSelectOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestKinds(projection, ["user_input"]);
  assertAllRuntimeRequestsResolved(projection);
  assertTurnItemTypes(projection, ["user_message", "user_input_request", "assistant_message"]);
  assertUserMessagesInclude(projection, [ACP_TITLED_MULTISELECT_PROMPT]);
  assertAssistantTextIncludes(projection, "titled multi-select fixture complete");

  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.deepStrictEqual(requestItem?.type === "user_input_request" && requestItem.questions, [
    {
      id: "fixture_areas",
      header: "Areas",
      question: "Which areas should this fixture cover?",
      options: [
        { label: "Strict schemas", description: "Typed wire shapes", value: "schemas" },
        { label: "UI flexibility", description: "UI flexibility", value: "ui" },
        { label: "Docs", description: "Docs", value: "docs" },
      ],
      allowCustomAnswer: false,
      multiSelect: true,
    },
  ]);
}
