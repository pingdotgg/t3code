import type { ProviderKind, ProviderReplayTranscript } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { OrchestratorV2LiveLayer } from "../Layers/OrchestratorLive.ts";
import type { OrchestratorV2Error } from "../Services/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../Services/ProviderAdapterRegistry.ts";
import {
  runOrchestratorV2Scenario,
  type OrchestratorV2ScenarioStepError,
  type OrchestratorV2Scenario,
  type OrchestratorV2ScenarioResult,
} from "./OrchestratorScenario.ts";

export interface OrchestratorV2ProviderReplayScenario<
  Transcript extends ProviderReplayTranscript = ProviderReplayTranscript,
> extends OrchestratorV2Scenario {
  readonly transcript: Transcript;
}

export interface OrchestratorV2ProviderReplayHarness<
  Transcript extends ProviderReplayTranscript = ProviderReplayTranscript,
  Error = never,
> {
  readonly provider: ProviderKind;
  readonly decodeTranscript: (
    transcript: ProviderReplayTranscript,
  ) => Effect.Effect<Transcript, Error>;
  readonly makeProviderAdapterRegistryLayer: (
    transcript: Transcript,
  ) => Layer.Layer<ProviderAdapterRegistryV2, Error>;
}

export function runOrchestratorV2ProviderReplayScenario<
  Transcript extends ProviderReplayTranscript,
  Error,
>(
  scenario: OrchestratorV2ProviderReplayScenario<Transcript>,
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
): Effect.Effect<
  OrchestratorV2ScenarioResult,
  OrchestratorV2Error | OrchestratorV2ScenarioStepError | Error,
  never
> {
  const registryLayer = harness.makeProviderAdapterRegistryLayer(scenario.transcript);
  const layer = OrchestratorV2LiveLayer.pipe(Layer.provide(registryLayer));

  return runOrchestratorV2Scenario(scenario).pipe(Effect.provide(layer));
}
