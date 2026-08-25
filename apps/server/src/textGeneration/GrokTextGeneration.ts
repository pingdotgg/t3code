import { type GrokSettings, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../provider/acp/GrokAcpSupport.ts";
import { makeAcpTextGeneration } from "./AcpTextGeneration.ts";

export const makeGrokTextGeneration = Effect.fn("makeGrokTextGeneration")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return makeAcpTextGeneration({
    providerLabel: "Grok Agent",
    requestLabel: "Grok ACP",
    makeRuntime: ({ cwd, operation }) =>
      makeGrokAcpRuntime({
        grokSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to start Grok ACP for text generation.",
              cause,
            }),
        ),
      ),
    prepareRuntime: ({ operation, runtime, started, modelSelection }) =>
      applyGrokAcpModelSelection({
        runtime,
        currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
        requestedModelId: resolveGrokAcpBaseModelId(modelSelection.model),
        mapError: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to set Grok ACP base model for text generation.",
            cause,
          }),
      }),
  });
});
