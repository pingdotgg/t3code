import { type OmpSettings, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  applyOmpAcpModelSelection,
  makeOmpTextGenerationAcpRuntime,
} from "../provider/acp/OmpAcpSupport.ts";
import { makeAcpTextGeneration } from "./AcpTextGeneration.ts";

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;

  return makeAcpTextGeneration({
    providerLabel: "Oh My Pi",
    requestLabel: "Oh My Pi ACP",
    makeRuntime: ({ cwd, operation }) =>
      Effect.gen(function* () {
        const sessionDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-omp-text-session-",
        });
        const runtime = yield* makeOmpTextGenerationAcpRuntime({
          ompSettings,
          environment,
          childProcessSpawner: commandSpawner,
          cwd,
          sessionDir,
          clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));
        yield* runtime.handleElicitation(() =>
          Effect.succeed({ action: { action: "cancel" as const } }),
        );
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
        );
        return runtime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to start Oh My Pi ACP for text generation.",
              cause,
            }),
        ),
      ),
    prepareRuntime: ({ operation, runtime, modelSelection }) =>
      applyOmpAcpModelSelection({
        runtime,
        model: modelSelection.model,
        selections: modelSelection.options,
        mapError: ({ cause, configId, step }) =>
          new TextGenerationError({
            operation,
            detail:
              step === "set-config-option"
                ? `Failed to set Oh My Pi ACP config option "${configId}" for text generation.`
                : "Failed to set Oh My Pi ACP model for text generation.",
            cause,
          }),
      }),
    buildPromptParts: ({ operation, prompt, attachments }) =>
      Effect.gen(function* () {
        const parts: Array<EffectAcpSchema.ContentBlock> = [{ type: "text", text: prompt }];
        for (const attachment of attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new TextGenerationError({
              operation,
              detail: `Invalid attachment id '${attachment.id}' for Oh My Pi text generation.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation,
                  detail: `Failed to read attachment '${attachment.id}' for Oh My Pi text generation.`,
                  cause,
                }),
            ),
          );
          parts.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return parts;
      }),
  });
});
