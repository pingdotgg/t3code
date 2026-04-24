import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2Command, type ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";

import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

function assertUnique(values: ReadonlyArray<string>, label: string) {
  assert.deepEqual(new Set(values).size, values.length, `${label} must be unique`);
}

describe("orchestrator replay fixture contract", () => {
  it("defines one stable input and provider-specific replay/output contracts per scenario", async () => {
    assertUnique(
      ORCHESTRATOR_REPLAY_FIXTURES.map((fixture) => fixture.name),
      "fixture names",
    );

    for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
      assert.isAtLeast(fixture.providers.length, 1, `${fixture.name} must have providers`);
      assertUnique(
        fixture.providers.map((provider) => provider.provider),
        `${fixture.name} provider variants`,
      );

      for (const provider of fixture.providers) {
        const transcript = await readTranscript(provider.transcriptFile);
        const materialized = await Effect.runPromise(
          materializeFixtureInput({
            scenario: fixture.name,
            fixtureInput: fixture.buildInput(),
            modelSelection: provider.modelSelection,
          }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
        );
        const firstCommand = materialized.commands[0];

        assert.equal(transcript.scenario, fixture.name);
        assert.equal(transcript.provider, provider.provider);
        assert.equal(provider.modelSelection.provider, provider.provider);
        assert.isDefined(materialized.projectionThreadIds[0]);
        assert.equal(firstCommand?.type, "thread.create");
        if (firstCommand?.type !== "thread.create") {
          throw new Error(`${fixture.name}/${provider.provider} must start with thread.create`);
        }
        assert.equal(firstCommand.threadId, materialized.projectionThreadIds[0]);
        assert.equal(materialized.commands.length, fixture.buildInput().steps.length + 1);
        assert.isAtLeast(materialized.steps.length, materialized.commands.length);
        assert.equal(typeof provider.assertOutput, "function");

        assertUnique(
          materialized.commands.map((command) => command.commandId),
          `${fixture.name}/${provider.provider} command IDs`,
        );

        for (const command of materialized.commands) {
          Schema.decodeUnknownSync(OrchestrationV2Command)(command);
        }

        for (const command of materialized.commands) {
          assert.isTrue(
            materialized.steps.some(
              (step) =>
                (step.type === "dispatch" && step.command === command) ||
                (step.type === "respond_to_next_runtime_request" &&
                  step.commandId === command.commandId),
            ),
            `${fixture.name}/${provider.provider} command ${command.commandId} must appear in the timeline`,
          );
        }
      }
    }
  });

  it("keeps Codex fixture transcripts at the codex app-server boundary", async () => {
    for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
      for (const provider of fixture.providers.filter((entry) => entry.provider === "codex")) {
        const transcript = await readTranscript(provider.transcriptFile);
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
  });
});
