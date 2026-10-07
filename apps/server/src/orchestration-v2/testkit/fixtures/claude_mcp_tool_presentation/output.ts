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
import { CLAUDE_MCP_TOOL_PRESENTATION_PROMPT } from "./input.ts";

// The scrape frame carries Claude Code's `tool_use_meta` as recorded. The map
// frame's entry was removed from the recording, so it stands in for an MCP
// tool Claude Code sends no display metadata for.
export function assertClaudeMcpToolPresentationOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_MCP_TOOL_PRESENTATION_PROMPT]);

  const tools = projection.turnItems.flatMap((item) =>
    item.type === "dynamic_tool" ? [item] : [],
  );
  assert.deepEqual(
    tools.map((item) => item.toolName),
    ["mcp__claude_ai_Firecrawl__firecrawl_scrape", "mcp__claude_ai_Firecrawl__firecrawl_map"],
  );
  const [scrape, map] = tools;

  assert.equal(scrape?.status, "completed");
  assert.equal(scrape?.title, "Firecrawl scrape");
  assert.deepEqual(scrape?.toolIcon, scrape?.toolSource?.icon);
  assert.deepEqual(scrape?.toolSource, {
    key: "mcp:firecrawl",
    name: "Firecrawl",
    kind: "integration",
    icon: {
      _tag: "themed-logo",
      logoUrl: "https://www.google.com/s2/favicons?domain=firecrawl.dev&sz=64",
    },
  });

  assert.equal(map?.status, "completed");
  assert.equal(map?.title, "firecrawl map");
  assert.deepEqual(map?.toolSource, {
    key: "mcp:firecrawl",
    name: "Firecrawl",
    kind: "integration",
  });
}
