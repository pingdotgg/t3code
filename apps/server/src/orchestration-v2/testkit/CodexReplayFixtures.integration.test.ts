import { assert, describe, it } from "@effect/vitest";
import * as Tracer from "effect/Tracer";
import * as Effect from "effect/Effect";

import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

describe("Codex replay fixtures", () => {
  itRunsReplayFixtures("codex", (input) =>
    runReplayFixture({
      ...input,
      harness: CodexOrchestratorReplayHarness,
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
    }),
  );
});

it.effect(
  "persists recorded Codex snapshots through provider transactions in the real run consumer",
  () =>
    Effect.gen(function* () {
      const fixture = findReplayFixture("multi_turn")!;
      const driver = fixture.providers.find((provider) => provider.driver === "codex")!;
      const writes: number[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            if (span.name === "orchestrationV2.EventSink.providerBatch") {
              writes.push(Number(span.attributes.get("orchestration_v2.batch_writes")));
            }
          };
          return span;
        },
      });
      yield* runReplayFixture({
        fixtureName: fixture.name,
        buildInput: fixture.buildInput,
        driver,
        harness: CodexOrchestratorReplayHarness,
        materializeWorkspace: (transcript, workspace) =>
          Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
      }).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
      assert.equal(
        writes.reduce((total, count) => total + count, 0),
        6,
      );
      assert.isTrue(writes.every((count) => count <= 3));
    }),
);
