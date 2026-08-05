import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationV2Command, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  type OrchestratorFixtureInput,
} from "./fixtures/shared.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const readTranscript = Effect.fn("readOrchestratorReplayContractTranscript")(function* (file: URL) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(decodeURIComponent(file.pathname));
  return yield* decodeProviderReplayNdjson(text);
}, Effect.provide(NodeServices.layer));

function assertUnique(values: ReadonlyArray<string>, label: string) {
  assert.deepEqual(new Set(values).size, values.length, `${label} must be unique`);
}

describe("orchestrator replay fixture contract", () => {
  it.effect("materializes queued fixture messages as queue-after-active dispatches", () =>
    Effect.gen(function* () {
      const materialized = yield* materializeFixtureInput({
        scenario: "queued-message-dispatch-mode",
        fixtureInput: {
          steps: [
            { type: "message", text: "active run" },
            { type: "queue_message", text: "queued run" },
          ],
        },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      });
      const queuedCommand = materialized.commands.find(
        (command) => command.type === "message.dispatch" && command.text === "queued run",
      );

      assert.isDefined(queuedCommand);
      assert.deepInclude(queuedCommand, {
        dispatchMode: { type: "queue_after_active" },
      });
    }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );

  it.effect(
    "keeps consecutive queue_message inputs queued without an intermediate idle barrier",
    () =>
      Effect.gen(function* () {
        const materialized = yield* materializeFixtureInput({
          scenario: "consecutive-queue-message-ordering",
          fixtureInput: {
            steps: [
              { type: "message", text: "active run" },
              { type: "queue_message", text: "queued run 1" },
              { type: "queue_message", text: "queued run 2" },
            ],
          },
          driver: ProviderDriverKind.make("codex"),
          modelSelection: CODEX_MODEL_SELECTION,
        });
        const queueCommands = materialized.commands.filter(
          (command) =>
            command.type === "message.dispatch" &&
            (command.text === "queued run 1" || command.text === "queued run 2"),
        );
        assert.lengthOf(queueCommands, 2);
        for (const command of queueCommands) {
          assert.deepInclude(command, {
            dispatchMode: { type: "queue_after_active" },
          });
        }

        const firstQueueDispatchIndex = materialized.steps.findIndex(
          (step) =>
            step.type === "dispatch" &&
            step.command.type === "message.dispatch" &&
            step.command.text === "queued run 1",
        );
        const secondQueueDispatchIndex = materialized.steps.findIndex(
          (step) =>
            step.type === "dispatch" &&
            step.command.type === "message.dispatch" &&
            step.command.text === "queued run 2",
        );
        assert.isAtLeast(firstQueueDispatchIndex, 0);
        assert.isAbove(secondQueueDispatchIndex, firstQueueDispatchIndex);

        const betweenQueueSteps = materialized.steps.slice(
          firstQueueDispatchIndex + 1,
          secondQueueDispatchIndex,
        );
        assert.isFalse(
          betweenQueueSteps.some(
            (step) => step.type === "await" || step.type === "await_thread_idle",
          ),
          "consecutive queue_message steps must not await the active run or thread idle between queues",
        );

        const afterSecondQueue = materialized.steps.slice(secondQueueDispatchIndex + 1);
        const barrierAwaitIndex = afterSecondQueue.findIndex((step) => step.type === "await");
        const barrierIdleIndex = afterSecondQueue.findIndex(
          (step) => step.type === "await_thread_idle",
        );
        assert.isAtLeast(
          barrierAwaitIndex,
          0,
          "the final queue_message still inserts the post-queue await barrier",
        );
        assert.deepEqual(afterSecondQueue[barrierAwaitIndex], {
          type: "await",
          key: "run:1",
        });
        assert.isAbove(
          barrierIdleIndex,
          barrierAwaitIndex,
          "the final queue_message still inserts await_thread_idle after its await",
        );
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );

  it.effect(
    "does not await thread idle between steer/restart and answer_next_user_input_request",
    () =>
      Effect.gen(function* () {
        for (const steeringType of ["steer", "restart"] as const) {
          const answers = { "question-0": "answer" };
          const materialized = yield* materializeFixtureInput({
            scenario: `${steeringType}-then-answer-user-input-ordering`,
            fixtureInput: {
              steps: [
                { type: "message", text: "active run" },
                {
                  type: steeringType,
                  text: `${steeringType} active run`,
                  targetRunIndex: 1,
                },
                {
                  type: "answer_next_user_input_request",
                  answers,
                },
              ],
            },
            driver: ProviderDriverKind.make("codex"),
            modelSelection: CODEX_MODEL_SELECTION,
          });

          const steeringDispatchIndex = materialized.steps.findIndex(
            (step) =>
              step.type === "dispatch" &&
              step.command.type === "message.dispatch" &&
              step.command.text === `${steeringType} active run`,
          );
          const answerStepIndex = materialized.steps.findIndex(
            (step) =>
              step.type === "respond_to_next_runtime_request" &&
              step.answers !== undefined &&
              Object.keys(step.answers).includes("question-0"),
          );
          assert.isAtLeast(steeringDispatchIndex, 0, `${steeringType} dispatch must materialize`);
          assert.isAbove(
            answerStepIndex,
            steeringDispatchIndex,
            `${steeringType} answer must follow the steering dispatch`,
          );

          const betweenSteps = materialized.steps.slice(steeringDispatchIndex + 1, answerStepIndex);
          assert.isFalse(
            betweenSteps.some((step) => step.type === "await" || step.type === "await_thread_idle"),
            `${steeringType} followed by answer_next_user_input_request must not await idle before answering`,
          );
        }
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );

  it.effect("keeps the active dispatch barrier through queued-run replacement", () =>
    Effect.gen(function* () {
      const materialized = yield* materializeFixtureInput({
        scenario: "queued-run-replacement-ordering",
        fixtureInput: {
          steps: [
            { type: "message", text: "active run" },
            { type: "queue_message", text: "queued run" },
            { type: "cancel_queued_run", targetRunIndex: 2 },
            { type: "queue_message", text: "replacement queued run" },
          ],
        },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      });
      const replacementQueueDispatchIndex = materialized.steps.findIndex(
        (step) =>
          step.type === "dispatch" &&
          step.command.type === "message.dispatch" &&
          step.command.text === "replacement queued run",
      );
      assert.isAtLeast(replacementQueueDispatchIndex, 0);

      const afterReplacementQueue = materialized.steps.slice(replacementQueueDispatchIndex + 1);
      const barrierAwait = afterReplacementQueue.find((step) => step.type === "await");
      assert.deepEqual(barrierAwait, {
        type: "await",
        key: "run:1",
      });
    }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );

  it.effect("materializes fixture run-status waits against derived run IDs", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const materialized = yield* materializeFixtureInput({
        scenario: "await-fixture-run-status",
        fixtureInput: {
          steps: [{ type: "await_run_status", targetRunIndex: 1, status: "running" }],
        },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      });
      const threadId = materialized.projectionThreadIds[0];
      assert.isDefined(threadId);
      const runStatusWait = materialized.steps.find((step) => step.type === "await_run_status");

      assert.deepEqual(runStatusWait, {
        type: "await_run_status",
        threadId,
        runId: idAllocator.derive.run({ threadId, ordinal: 1 }),
        status: "running",
      });
    }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );

  it.effect("keeps message ordinals separate from app run ordinals after steering", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      for (const steeringType of ["steer", "restart"] as const) {
        const fixtureInput: OrchestratorFixtureInput = {
          steps: [
            { type: "message", text: "first run" },
            { type: steeringType, text: "steer first run", targetRunIndex: 1 },
            { type: "message", text: "second run" },
            { type: "interrupt", targetRunIndex: 2 },
          ],
        };
        const materialized = yield* materializeFixtureInput({
          scenario: `run-index-after-${steeringType}`,
          fixtureInput,
          driver: ProviderDriverKind.make("codex"),
          modelSelection: CODEX_MODEL_SELECTION,
        });
        const secondRunCommand = materialized.commands.find(
          (command) => command.type === "message.dispatch" && command.text === "second run",
        );
        assert.isDefined(secondRunCommand);
        const secondRunDispatch = materialized.steps.find(
          (step) => step.type === "dispatch" && step.command === secondRunCommand,
        );
        assert.deepInclude(secondRunDispatch, {
          type: "dispatch",
          await: false,
          key: "run:2",
        });
        const expectedSecondRunId = idAllocator.derive.run({
          threadId: materialized.projectionThreadIds[0]!,
          ordinal: 2,
        });
        assert.isTrue(
          materialized.steps.some(
            (step) => step.type === "await_run_steerable" && step.runId === expectedSecondRunId,
          ),
        );
      }
    }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );

  it.effect(
    "defines one stable input and provider-specific replay/output contracts per scenario",
    () =>
      Effect.gen(function* () {
        assertUnique(
          ORCHESTRATOR_REPLAY_FIXTURES.map((fixture) => fixture.name),
          "fixture names",
        );

        for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
          assert.isAtLeast(fixture.providers.length, 1, `${fixture.name} must have providers`);
          assertUnique(
            fixture.providers.map((provider) => provider.driver),
            `${fixture.name} provider variants`,
          );

          for (const provider of fixture.providers) {
            const transcript = yield* readTranscript(provider.transcriptFile);
            const replayGateLabels = fixture
              .buildInput()
              .steps.flatMap((step) =>
                step.type === "release_replay_gate" ||
                step.type === "release_replay_gate_after_waiting"
                  ? [step.label]
                  : [],
              );
            const materialized = yield* materializeFixtureInput({
              scenario: fixture.name,
              fixtureInput: fixture.buildInput(),
              driver: provider.driver,
              modelSelection: provider.modelSelection,
            }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
            const firstCommand = materialized.commands[0];

            assert.equal(transcript.scenario, provider.recordedScenario ?? fixture.name);
            if (provider.driver === "acpRegistry") {
              assert.include(
                ["acpRegistry", "grok"],
                transcript.provider,
                "ACP Registry may retarget protocol-standard Grok ACP evidence",
              );
            } else {
              assert.equal(transcript.provider, provider.driver);
            }
            assert.equal(
              provider.modelSelection.instanceId,
              ProviderInstanceId.make(provider.driver),
            );
            assert.isDefined(materialized.projectionThreadIds[0]);
            assert.equal(firstCommand?.type, "thread.create");
            if (firstCommand?.type !== "thread.create") {
              throw new Error(`${fixture.name}/${provider.driver} must start with thread.create`);
            }
            assert.equal(firstCommand.threadId, materialized.projectionThreadIds[0]);
            // These fixture steps coordinate the test runtime; every other
            // input step dispatches a command.
            const commandProducingSteps = fixture
              .buildInput()
              .steps.filter(
                (step) =>
                  step.type !== "advance_clock" &&
                  step.type !== "await_run_status" &&
                  step.type !== "capture_shell_snapshot" &&
                  step.type !== "release_replay_gate" &&
                  step.type !== "release_replay_gate_after_waiting",
              );
            assert.equal(materialized.commands.length, commandProducingSteps.length + 1);
            assert.isAtLeast(materialized.steps.length, materialized.commands.length);
            assert.equal(typeof provider.assertOutput, "function");
            for (const label of replayGateLabels) {
              assert.isTrue(
                transcript.entries.some(
                  (entry) => entry.type === "emit_inbound" && entry.label === label,
                ),
                `${fixture.name}/${provider.driver} replay gate ${label} must label an inbound frame`,
              );
            }
            if (provider.transcriptEntriesThroughLabel !== undefined) {
              assert.isTrue(
                transcript.entries.some(
                  (entry) =>
                    entry.type === "emit_inbound" &&
                    entry.label === provider.transcriptEntriesThroughLabel,
                ),
                `${fixture.name}/${provider.driver} transcript slice must name an inbound frame`,
              );
            }

            assertUnique(
              materialized.commands.map((command) => command.commandId),
              `${fixture.name}/${provider.driver} command IDs`,
            );

            for (const command of materialized.commands) {
              yield* decodeCommand(command);
            }

            for (const command of materialized.commands) {
              assert.isTrue(
                materialized.steps.some(
                  (step) =>
                    (step.type === "dispatch" && step.command === command) ||
                    (step.type === "respond_to_next_runtime_request" &&
                      step.commandId === command.commandId),
                ),
                `${fixture.name}/${provider.driver} command ${command.commandId} must appear in the timeline`,
              );
            }
          }
        }
      }),
  );

  it.effect("keeps Codex fixture transcripts at the codex app-server boundary", () =>
    Effect.gen(function* () {
      for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
        for (const provider of fixture.providers.filter((entry) => entry.driver === "codex")) {
          const transcript = yield* readTranscript(provider.transcriptFile);
          const first = transcript.entries[0];
          const last = transcript.entries.at(-1);

          assert.equal(transcript.protocol, "codex.app-server");
          assert.equal(first?.type, "expect_outbound");
          if (first?.type === "expect_outbound") {
            assert.equal(first.label, "initialize");
          }
          assert.deepEqual(last, {
            type: "runtime_exit",
            status: "success",
          });
        }
      }
    }),
  );
});
