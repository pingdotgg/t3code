import { type CursorSettings, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
} from "../provider/acp/CursorAcpSupport.ts";
import { makeAcpTextGeneration } from "./AcpTextGeneration.ts";

export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")(function* (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  return makeAcpTextGeneration({
    providerLabel: "Cursor Agent",
    requestLabel: "Cursor ACP",
    makeRuntime: ({ cwd, operation }) =>
      makeCursorAcpRuntime({
        cursorSettings,
        environment: resolvedEnvironment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to start Cursor ACP for text generation.",
              cause,
            }),
        ),
      ),
    prepareRuntime: ({ operation, runtime, modelSelection }) =>
      Effect.gen(function* () {
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            new TextGenerationError({
              operation,
              detail:
                step === "set-config-option"
                  ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                  : "Failed to set Cursor ACP base model for text generation.",
              cause,
            }),
        });
      }),
  });
});
