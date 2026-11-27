import { TextGenerationError } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  makeAcpRegistryManagementRuntime,
  type AcpRegistryConfigurationProbeInput,
} from "./probe.ts";

const TIMEOUT = "3 minutes";
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeAcpRegistryTextGeneration = Effect.fn("AcpRegistryTextGeneration.make")(function* (
  input: Omit<AcpRegistryConfigurationProbeInput, "cwd">,
) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const run: TextGenerationOperations.Runner = Effect.fn("AcpRegistryTextGeneration.run")(
    function* (request) {
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-acp-text-" });
      const runtime = yield* makeAcpRegistryManagementRuntime({ ...input, cwd });
      const output = yield* Ref.make("");
      yield* runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate === "agent_message" && update.content != null) {
          return Ref.set(
            output,
            update.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
          );
        }
        if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
          return Effect.void;
        }
        const chunk = update.content.text;
        return Ref.update(output, (text) => text + chunk);
      });
      // A hidden session must never act on the checkout.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" } } as const),
      );
      const started = yield* runtime.start();
      yield* Effect.addFinalizer(() =>
        runtime
          .deleteSession(started.sessionId)
          .pipe(Effect.interruptible, Effect.timeout("5 seconds"), Effect.ignore),
      );
      const model = request.modelSelection.model;
      const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
      if (model.length > 0 && model !== "default" && modelOption?.currentValue !== model) {
        const modelState = started.sessionSetupResult.models;
        const isCustomModel = readCustomModelEntries(input.settings.customModels).some(
          (entry) => entry.slug === model,
        );
        if (modelOption !== undefined) {
          if (
            isCustomModel ||
            flattenSelectChoices(modelOption.options).some((choice) => choice.value === model)
          ) {
            yield* runtime.setConfigOption(modelOption.id, model, {
              allowUnlistedValue: isCustomModel,
            });
          }
        } else if (
          modelState != null &&
          modelState.currentModelId !== model &&
          (isCustomModel || modelState.availableModels.some((choice) => choice.modelId === model))
        ) {
          yield* runtime.setSessionModel(model);
        }
      }
      yield* runtime.prompt({ prompt: [{ type: "text", text: request.prompt }] });
      const text = (yield* Ref.get(output)).trim();
      if (text.length === 0) {
        return yield* new TextGenerationError({
          operation: request.operation,
          detail: "The ACP agent returned no text.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "ACP agent", text);
    },
    (effect, request) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: TIMEOUT,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({
                operation: request.operation,
                detail: "The ACP agent did not answer in time.",
              }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: request.operation,
                detail: "The ACP text generation request failed.",
                cause,
              }),
        ),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(SecureRandom.SecureRandom, random),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
  );
  return TextGenerationOperations.fromRunner(
    "AcpRegistryTextGeneration",
    TextGenerationOperations.withoutInvestigation("ACP Registry", run),
  ) satisfies ProviderTextGeneration;
});
