import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_TEXT_SEGMENTS_PROMPT } from "./input.ts";

export function assertClaudeTextSegmentsOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_TEXT_SEGMENTS_PROMPT]);

  // The stream interleaved text → tool → text. Each assistant message uuid
  // must be its own item, ordered around the command — never one merged
  // blob after all tools.
  const ordered = [...projection.turnItems]
    .sort((a, b) => a.ordinal - b.ordinal)
    .filter((item) => item.type === "assistant_message" || item.type === "command_execution")
    .map((item) => (item.type === "assistant_message" ? `text:${item.text}` : "command"));
  assert.deepEqual(ordered, [
    "text:Listing the workspace now.",
    "command",
    "text:Two files found: package.json and tsconfig.json.",
  ]);
}
