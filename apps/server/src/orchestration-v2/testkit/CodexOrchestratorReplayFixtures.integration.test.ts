import { describe, it } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";

import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import { materializeFixtureInput } from "./fixtures/shared.ts";
import { decodeProviderReplayNdjson } from "./ReplayTranscriptNdjson.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { runOrchestratorV2ReplayScenario } from "./OrchestratorScenario.ts";

async function readTranscript(file: URL): Promise<ProviderReplayTranscript> {
  const text = await readFile(file, "utf8");
  return await Effect.runPromise(decodeProviderReplayNdjson(text));
}

describe("Codex orchestrator replay fixtures", () => {
  for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
    for (const provider of fixture.providers) {
      it(`runs ${fixture.name}/${provider.provider} through OrchestratorV2 using deterministic replay`, async () => {
        const transcript = await readTranscript(provider.transcriptFile);
        const input = materializeFixtureInput({
          scenario: fixture.name,
          fixtureInput: fixture.buildInput(),
          modelSelection: provider.modelSelection,
        });
        const scenario = {
          name: `${fixture.name}/${provider.provider}`,
          transcript,
          commands: input.commands,
          projectionThreadIds: input.projectionThreadIds,
        };

        const result = await Effect.runPromise(
          runOrchestratorV2ReplayScenario(scenario).pipe(provideDeterministicTestRuntime),
        );

        provider.assertOutput(result, transcript);
      });
    }
  }
});
