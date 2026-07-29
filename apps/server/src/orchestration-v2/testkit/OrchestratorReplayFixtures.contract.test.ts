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
            const materialized = yield* materializeFixtureInput({
              scenario: fixture.name,
              fixtureInput: fixture.buildInput(),
              driver: provider.driver,
              modelSelection: provider.modelSelection,
            }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
            const firstCommand = materialized.commands[0];

            assert.equal(transcript.scenario, fixture.name);
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
            // advance_clock only moves the test clock; every other input step
            // dispatches a command.
            const commandProducingSteps = fixture
              .buildInput()
              .steps.filter((step) => step.type !== "advance_clock");
            assert.equal(materialized.commands.length, commandProducingSteps.length + 1);
            assert.isAtLeast(materialized.steps.length, materialized.commands.length);
            assert.equal(typeof provider.assertOutput, "function");

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
