import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationV2Command, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { readProviderReplayTranscript } from "./ReplayTranscriptNdjson.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const readTranscript = Effect.fn("readOrchestratorReplayContractTranscript")(function* (file: URL) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function assertUnique(values: ReadonlyArray<string>, label: string) {
  assert.deepEqual(new Set(values).size, values.length, `${label} must be unique`);
}

describe("orchestrator replay fixture contract", () => {
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
