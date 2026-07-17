import * as Effect from "effect/Effect";

import { type GrokSettings, TextGenerationError } from "@t3tools/contracts";

import { makeStandardAcpTextGeneration } from "./StandardAcpTextGeneration.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../provider/acp/GrokAcpSupport.ts";

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* makeStandardAcpTextGeneration(
    {
      displayName: "Grok",
      agentName: "Grok Agent",
      resolveBaseModelId: resolveGrokAcpBaseModelId,
      makeRuntime: (input) =>
        makeGrokAcpRuntime({
          ...input,
          grokSettings,
        }),
      applyModelSelection: ({ runtime, started, model, operation }) =>
        applyGrokAcpModelSelection({
          runtime,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          requestedModelId: model,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Grok ACP base model for text generation.",
              cause,
            }),
        }).pipe(Effect.asVoid),
    },
    environment,
  );
});
