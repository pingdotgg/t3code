import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { PiOrchestratorReplayHarness } from "../Adapters/PiAdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

describe("Pi replay fixtures", () => {
  it.effect("does not persist a recovered Pi message error as a failed run", () =>
    Effect.gen(function* () {
      const fixture = findReplayFixture("simple");
      assert.isDefined(fixture);
      if (fixture === undefined) return;
      const driver = fixture.providers.find((provider) => provider.driver === "pi");
      assert.isDefined(driver);
      if (driver === undefined) return;
      const result = yield* runReplayFixture({
        fixtureName: fixture.name,
        buildInput: fixture.buildInput,
        driver,
        harness: PiOrchestratorReplayHarness,
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.flatMap<ProviderReplayTranscript["entries"][number]>(
            (entry) =>
              entry.type === "emit_inbound" && entry.label === "agent_start"
                ? [
                    entry,
                    {
                      type: "emit_inbound",
                      frame: {
                        type: "message_end",
                        message: {
                          role: "assistant",
                          content: [],
                          stopReason: "error",
                          errorMessage: "This operation was aborted",
                        },
                      },
                    },
                    {
                      type: "emit_inbound",
                      frame: { type: "agent_end", messages: [], willRetry: false },
                    },
                    { type: "emit_inbound", frame: { type: "agent_start" } },
                  ]
                : [entry],
          ),
        }),
      });
      for (const projection of result.projections.values()) {
        assert.deepEqual(
          projection.attempts.map((attempt) => attempt.status),
          ["completed"],
        );
        assert.deepEqual(
          projection.providerSessions.map((session) => ({
            status: session.status,
            lastError: session.lastError,
          })),
          [{ status: "ready", lastError: null }],
        );
        assert.isTrue(projection.providerTurns.every((turn) => turn.status === "completed"));
        assert.isFalse(projection.turnItems.some((item) => item.type === "error"));
      }
    }).pipe(
      // The recording uses POSIX argv, without Windows npm .cmd wrapping.
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
  );

  itRunsReplayFixtures("pi", (input) =>
    runReplayFixture({ ...input, harness: PiOrchestratorReplayHarness }),
  );
});
