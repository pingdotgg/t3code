import { describe, it } from "@effect/vitest";
import type { ProviderKind, ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";

import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
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
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";

const PROVIDER_REPLAY_HARNESSES = [CodexOrchestratorReplayHarness] as const;

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

function harnessFor(provider: ProviderKind) {
  const harness = PROVIDER_REPLAY_HARNESSES.find((candidate) => candidate.provider === provider);
  if (!harness) {
    throw new Error(`No replay harness registered for provider ${provider}.`);
  }
  return harness;
}

async function runFixtureProvider<Transcript extends ProviderReplayTranscript, Error>(input: {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly provider: ProviderOrchestratorReplayVariant;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
}) {
  const rawTranscript = await readTranscript(input.provider.transcriptFile);
  const transcript = await Effect.runPromise(input.harness.decodeTranscript(rawTranscript));
  const materialized = materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput: input.buildInput(),
    modelSelection: input.provider.modelSelection,
  });
  const scenario = {
    name: `${input.fixtureName}/${input.provider.provider}`,
    transcript,
    commands: materialized.commands,
    steps: materialized.steps,
    projectionThreadIds: materialized.projectionThreadIds,
  };

  const result = await Effect.runPromise(
    runOrchestratorV2ProviderReplayScenario(scenario, input.harness).pipe(
      provideDeterministicTestRuntime,
    ),
  );

  input.provider.assertOutput(result, transcript);
}

describe("orchestrator replay fixtures", () => {
  for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
    for (const provider of fixture.providers) {
      it(`runs ${fixture.name}/${provider.provider} through OrchestratorV2 using deterministic replay`, async () => {
        await runFixtureProvider({
          fixtureName: fixture.name,
          buildInput: fixture.buildInput,
          provider,
          harness: harnessFor(provider.provider),
        });
      });
    }
  }
});
