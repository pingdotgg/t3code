import { describe, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OpenCodeOrchestratorReplayHarness } from "../Adapters/OpenCodeAdapterV2.testkit.ts";
import {
  OPENCODE2_HTTP_PROTOCOL,
  OpenCode2OrchestratorReplayHarness,
} from "../Adapters/OpenCode2AdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  readReplayFixtureTranscript,
  runReplayFixture,
  type ReplayFixtureCase,
} from "./ProviderReplayFixtures.ts";

// OpenCode fixtures are recorded against either the v1 or the v2 HTTP protocol.
function runOpenCodeReplayFixture(input: ReplayFixtureCase) {
  return readReplayFixtureTranscript(input.driver.transcriptFile).pipe(
    Effect.flatMap((transcript) =>
      transcript.protocol === OPENCODE2_HTTP_PROTOCOL
        ? runReplayFixture({ ...input, harness: OpenCode2OrchestratorReplayHarness })
        : runReplayFixture({ ...input, harness: OpenCodeOrchestratorReplayHarness }),
    ),
  );
}

describe("OpenCode replay fixtures", () => {
  itRunsReplayFixtures("opencode", runOpenCodeReplayFixture);

  it.effect.each(
    (
      [
        ["opencode2_subagent", "session.execution.started.2"],
        ["opencode2_background", "session.execution.started.3"],
      ] as const
    ).flatMap(([fixtureName, label]) => {
      const fixture = findReplayFixture(fixtureName);
      const provider = fixture?.providers[0];
      return fixture === undefined || provider === undefined
        ? []
        : [[fixtureName, label, fixture, provider] as const];
    }),
  )(
    "runs %s when %s is an execution start this build cannot decode",
    ([fixtureName, label, fixture, provider]) =>
      runOpenCodeReplayFixture({
        fixtureName,
        buildInput: fixture.buildInput,
        driver: provider,
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.map((entry) =>
            entry.type === "emit_inbound" && entry.label === label
              ? undecodableEvent(entry)
              : entry,
          ),
        }),
      }),
  );
});

function undecodableEvent(entry: ProviderReplayEntry): ProviderReplayEntry {
  if (entry.type !== "emit_inbound") return entry;
  const frame = entry.frame as { readonly event: Record<string, unknown> };
  return { ...entry, frame: { ...frame, event: { ...frame.event, durable: "not-an-envelope" } } };
}
