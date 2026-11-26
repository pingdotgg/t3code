import { assert, describe, it } from "@effect/vitest";
import * as Tracer from "effect/Tracer";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

/** A transcript borrowed from another scenario names the thread after that scenario's title. */
const renameRecordedThread =
  (recordedScenario: string, scenario: string) =>
  (transcript: ProviderReplayTranscript): ProviderReplayTranscript => ({
    ...transcript,
    entries: transcript.entries.map((entry) =>
      entry.type === "expect_outbound" &&
      Predicate.isObject(entry.frame) &&
      entry.frame.method === "thread/name/set" &&
      Predicate.isObject(entry.frame.params) &&
      entry.frame.params.name === `Replay fixture: ${recordedScenario}`
        ? {
            ...entry,
            frame: {
              ...entry.frame,
              params: { ...entry.frame.params, name: `Replay fixture: ${scenario}` },
            },
          }
        : entry,
    ),
  });

describe("Codex replay fixtures", () => {
  itRunsReplayFixtures("codex", (input) =>
    runReplayFixture({
      ...input,
      harness: CodexOrchestratorReplayHarness,
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
      ...(input.driver.recordedScenario === undefined
        ? {}
        : {
            transformTranscript: renameRecordedThread(
              input.driver.recordedScenario,
              input.fixtureName,
            ),
          }),
    }),
  );

  it.effect.each([true, false])("records prompt delivery after Stop (received: %s)", (received) =>
    Effect.gen(function* () {
      const fixture = findReplayFixture("turn_interrupt")!;
      const driver = fixture.providers.find((provider) => provider.driver === "codex")!;
      const result = yield* runReplayFixture({
        fixtureName: fixture.name,
        buildInput: fixture.buildInput,
        driver,
        harness: CodexOrchestratorReplayHarness,
        materializeWorkspace: (transcript, workspace) =>
          Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
        // In the early-Stop trace Codex sends the same terminal notification without the user item.
        transformTranscript: (transcript) => ({
          ...transcript,
          entries: transcript.entries.filter(
            (entry) =>
              received ||
              entry.type !== "emit_inbound" ||
              (entry.label !== "item/started" && entry.label !== "item/completed"),
          ),
        }),
      });
      const projection = [...result.projections.values()][0];
      assert.equal(projection?.providerTurns[0]?.promptDropped, received ? undefined : true);
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
