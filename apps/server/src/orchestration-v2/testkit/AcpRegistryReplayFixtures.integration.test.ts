import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { AcpRegistryOrchestratorReplayHarness } from "../Adapters/AcpRegistryAdapterV2.testkit.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { materializeFixtureInput, SIMPLE_PROMPT } from "./fixtures/shared.ts";
import {
  itRunsReplayFixtures,
  readReplayFixtureTranscript,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";
import { layerProviderReplay } from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

describe("ACP registry replay fixtures", () => {
  it.effect.each([
    { name: "open", firstTurn: false, code: -32602 },
    { name: "switch", firstTurn: true, code: -32602 },
    { name: "authentication", firstTurn: false, code: -32000 },
  ])("preserves the ACP model-write $name failure through orchestration", (testCase) =>
    Effect.gen(function* () {
      const name = `acp_model_write_${testCase.name}`;
      const sessionId = "grok-replay-session-1";
      const rejectedModel = "replay-model-b";
      const modelSelection = {
        instanceId: ProviderInstanceId.make("acpRegistry"),
        model: rejectedModel,
      };
      const recorded = yield* readReplayFixtureTranscript(
        new URL("./fixtures/simple/registry_transcript.ndjson", import.meta.url),
      );
      const sessionIndex = recorded.entries.findIndex(
        (entry) => "label" in entry && entry.label === "session.created",
      );
      assert.isAtLeast(sessionIndex, 0);
      const transcript = {
        ...recorded,
        scenario: name,
        entries: [
          ...recorded.entries.slice(0, sessionIndex),
          {
            type: "emit_inbound",
            label: "session.created",
            frame: {
              kind: "response",
              method: "session/new",
              result: {
                sessionId,
                configOptions: [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "replay-model-a",
                    options: [
                      { value: "replay-model-a", name: "Model A" },
                      { value: rejectedModel, name: "Model B" },
                    ],
                  },
                ],
              },
            },
          },
          ...(testCase.firstTurn
            ? recorded.entries
                .slice(sessionIndex + 1)
                .filter((entry) => entry.type !== "runtime_exit")
            : []),
          {
            type: "expect_outbound",
            label: "session.set_model",
            frame: {
              kind: "request",
              method: "session/set_config_option",
              params: { sessionId, configId: "model", value: rejectedModel },
            },
          },
          {
            type: "emit_inbound",
            label: "session.set_model.rejected",
            frame: {
              kind: "response",
              method: "session/set_config_option",
              error: {
                code: testCase.code,
                message: testCase.code === -32602 ? "Invalid provider" : "Authentication required",
              },
            },
          },
        ],
      } satisfies ProviderReplayTranscript;
      const materialized = yield* materializeFixtureInput({
        scenario: name,
        fixtureInput: {
          steps: Array.from({ length: testCase.firstTurn ? 2 : 1 }, () => ({
            type: "message" as const,
            text: SIMPLE_PROMPT,
          })),
        },
        driver: ProviderDriverKind.make("acpRegistry"),
        modelSelection: {
          ...modelSelection,
          model: testCase.firstTurn ? "replay-model-a" : rejectedModel,
        },
      });
      const scenario = {
        ...materialized,
        name,
        transcript: yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(transcript, {
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "replay-model-a",
          }),
        ),
        runtimePolicyOverride: { cwd: yield* checkpointWorkspace(name) },
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        if (testCase.firstTurn) yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
        for (const [index, command] of materialized.commands.entries()) {
          const isFirstTurn =
            testCase.firstTurn && command.type === "message.dispatch" && index === 1;
          yield* orchestrator.dispatch(
            command.type === "message.dispatch" && !isFirstTurn
              ? { ...command, modelSelection }
              : command,
          );
          if (isFirstTurn) {
            // Wait for the committed terminal event before switching models.
            yield* orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.runHead,
            );
          }
        }
        if (testCase.firstTurn) {
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) => event.type === "run.updated" && event.payload.status === "failed",
            ),
            Stream.runHead,
          );
        } else {
          // Failed opens retry on the outbox schedule. Advance to each recorded
          // deadline, draining effects instead of polling the projection.
          for (let attempt = 0; attempt < 10; attempt++) {
            yield* worker.drain();
            const next = yield* worker.nextClaimableAt;
            if (Option.isNone(next)) break;
            const now = yield* DateTime.now;
            yield* TestClock.adjust(
              Math.max(0, DateTime.toEpochMillis(next.value) - DateTime.toEpochMillis(now)),
            );
          }
        }
        const projection = yield* orchestrator.getThreadProjection(
          materialized.projectionThreadIds[0]!,
        );
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          testCase.firstTurn ? ["completed", "failed"] : ["failed"],
        );
        const errors = projection.turnItems.filter((item) => item.type === "error");
        assert.lengthOf(errors, 1);
        assert.equal(errors[0]?.failure.class, "provider_error");
        if (testCase.code === -32602) {
          assert.equal(
            errors[0]?.failure.message,
            'The agent did not accept the model "replay-model-b". Choose another model for this provider, then retry.',
          );
        } else {
          assert.match(
            errors[0]?.failure.message ?? "",
            /^Failed to open acpRegistry provider session \S+\.$/u,
          );
        }
      }).pipe(
        Effect.provide(
          layerProviderReplay(scenario, AcpRegistryOrchestratorReplayHarness, {
            runEffectWorker: false,
          }),
        ),
      );
    }).pipe(
      Effect.scoped,
      provideDeterministicTestRuntime,
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    ),
  );

  itRunsReplayFixtures("acpRegistry", (input) =>
    runReplayFixture({ ...input, harness: AcpRegistryOrchestratorReplayHarness }),
  );
});
