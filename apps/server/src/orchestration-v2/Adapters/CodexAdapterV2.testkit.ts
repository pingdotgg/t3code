import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as CodexReplay from "effect-codex-app-server/replay";
import { Effect, Layer, Schema } from "effect";

import { ProviderAdapterRegistryV2FromSingleAdapterLayer } from "../Layers/ProviderAdapterRegistryStatic.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { CodexAdapterV2LiveLayer } from "./CodexAdapterV2.ts";

export class CodexReplayTranscriptDecodeError extends Schema.TaggedErrorClass<CodexReplayTranscriptDecodeError>()(
  "CodexReplayTranscriptDecodeError",
  {
    provider: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to decode Codex app-server replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export const CodexOrchestratorReplayHarnessError = Schema.Union([
  CodexReplayTranscriptDecodeError,
  CodexReplay.CodexAppServerReplayError,
]);
export type CodexOrchestratorReplayHarnessError = typeof CodexOrchestratorReplayHarnessError.Type;

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

export const CodexOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  CodexReplay.CodexAppServerReplayTranscript,
  CodexOrchestratorReplayHarnessError
> = {
  provider: "codex",
  decodeTranscript: (transcript) =>
    Schema.decodeUnknownEffect(CodexReplay.CodexAppServerReplayTranscript)(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new CodexReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) => {
    const replayLayer = CodexReplay.layerReplay(transcript);
    const adapterLayer = CodexAdapterV2LiveLayer.pipe(Layer.provide(replayLayer));

    return ProviderAdapterRegistryV2FromSingleAdapterLayer.pipe(Layer.provide(adapterLayer));
  },
};
