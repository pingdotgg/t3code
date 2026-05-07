import { assert, describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect } from "effect";
import { readFile, rm } from "node:fs/promises";

import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import {
  materializeFixtureInput,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { makeCheckpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

async function runFixtureProvider<Transcript extends ProviderReplayTranscript, Error>(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly provider: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
}) {
  const rawTranscript = await readTranscript(input.provider.transcriptFile);
  const transcript = await Effect.runPromise(input.harness.decodeTranscript(rawTranscript));
  const checkpointWorkspace = await makeCheckpointWorkspace(input.fixtureName);
  const materialized = await Effect.runPromise(
    materializeFixtureInput({
      scenario: input.fixtureName,
      fixtureInput: input.buildInput(),
      modelSelection: input.provider.modelSelection,
    }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime),
  );
  try {
    const scenario = {
      name: `${input.fixtureName}/${input.provider.provider}`,
      transcript,
      commands: materialized.commands,
      steps: materialized.steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: {
        ...input.provider.runtimePolicyOverride,
        cwd: checkpointWorkspace,
      },
    };

    const result = await Effect.runPromise(
      runOrchestratorV2ProviderReplayScenario(scenario, input.harness).pipe(
        provideDeterministicTestRuntime,
      ),
    );

    input.provider.assertOutput(result, transcript);
    const projectionThreadId = materialized.projectionThreadIds[0];
    assert.isDefined(projectionThreadId);
    const projection = result.projections.get(projectionThreadId);
    assert.isDefined(projection);
    const latestRun = projection.runs.at(-1);
    assert.deepEqual(latestRun?.modelSelection, input.provider.modelSelection);
  } finally {
    await rm(checkpointWorkspace, { recursive: true, force: true });
  }
}

async function runFixtureProviderWithRegisteredHarness(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly provider: ProviderOrchestratorReplayVariant;
}) {
  switch (input.provider.provider) {
    case "codex":
      return await runFixtureProvider({
        ...input,
        harness: CodexOrchestratorReplayHarness,
      });
    case "claudeAgent":
      return await runFixtureProvider({
        ...input,
        harness: ClaudeOrchestratorReplayHarness,
      });
    default:
      throw new Error(`No replay harness registered for provider ${input.provider.provider}.`);
  }
}

describe("orchestrator replay fixtures", () => {
  for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
    for (const provider of fixture.providers) {
      it(`runs ${fixture.name}/${provider.provider} through OrchestratorV2 using deterministic replay`, async () => {
        await runFixtureProviderWithRegisteredHarness({
          fixtureName: fixture.name,
          buildInput: fixture.buildInput,
          provider,
        });
      });
    }
  }
});
