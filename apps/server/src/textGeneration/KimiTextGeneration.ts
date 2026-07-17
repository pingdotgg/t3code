import { type KimiSettings, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  applyKimiAcpModelSelection,
  currentKimiModelIdFromConfigOptions,
  isKimiModelCatalogEmpty,
  KIMI_AUTH_REQUIRED_MESSAGE,
  makeKimiAcpRuntime,
  resolveKimiAcpBaseModelId,
} from "../provider/acp/KimiAcpSupport.ts";
import { makeStandardAcpTextGeneration } from "./StandardAcpTextGeneration.ts";

export const makeKimiTextGeneration = Effect.fn("makeKimiTextGeneration")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* makeStandardAcpTextGeneration(
    {
      displayName: "Kimi Code",
      agentName: "Kimi Code CLI",
      resolveBaseModelId: resolveKimiAcpBaseModelId,
      makeRuntime: (input) =>
        makeKimiAcpRuntime({
          ...input,
          kimiSettings,
        }),
      applyModelSelection: ({ runtime, model, operation }) =>
        runtime.getConfigOptions.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Failed to read Kimi ACP config options for text generation.",
                cause,
              }),
          ),
          Effect.flatMap((configOptions) => {
            if (isKimiModelCatalogEmpty(configOptions)) {
              return Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: KIMI_AUTH_REQUIRED_MESSAGE,
                }),
              );
            }
            return applyKimiAcpModelSelection({
              runtime,
              currentModelId: currentKimiModelIdFromConfigOptions(configOptions),
              requestedModelId: model,
              mapError: (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Failed to set Kimi ACP base model for text generation.",
                  cause,
                }),
            });
          }),
          Effect.asVoid,
        ),
    },
    environment,
  );
});
