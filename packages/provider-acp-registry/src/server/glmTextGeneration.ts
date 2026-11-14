import { TextGenerationError } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { type AcpError, AcpRequestError, AcpSpawnError } from "effect-acp/errors";

import type { AcpRegistrySettings } from "../settings.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import { flattenSelectChoices } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";

const GLM_TEXT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export type GlmTextRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "start"
  | "setMode"
  | "getConfigOptions"
  | "getEvents"
  | "setConfigOption"
  | "prompt"
  | "cancel"
  | "closeSession"
  | "handleSessionUpdate"
  | "handleRequestPermission"
  | "handleElicitation"
  | "handleReadTextFile"
  | "handleWriteTextFile"
  | "handleCreateTerminal"
  | "handleTerminalOutput"
  | "handleTerminalWaitForExit"
  | "handleTerminalKill"
  | "handleTerminalRelease"
  | "handleUnknownExtRequest"
>;

export type GlmTextRuntimeFactory = (input: {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}) => Effect.Effect<GlmTextRuntime, AcpError, Scope.Scope>;

export interface GlmTextGenerationOptions {
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly makeRuntime?: GlmTextRuntimeFactory;
}

export const makeGlmTextGeneration = Effect.fn("makeGlmTextGeneration")(function* (
  options: GlmTextGenerationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { settings, environment } = options;
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const customModelSlugs = readCustomModelEntries(settings.customModels).map((entry) => entry.slug);

  const makeRuntime: GlmTextRuntimeFactory =
    options.makeRuntime ??
    ((input) =>
      Effect.gen(function* () {
        const resolved = yield* catalog
          .resolve(settings, input.cwd, environment)
          .pipe(
            Effect.mapError((cause) => new AcpSpawnError({ command: settings.agentId, cause })),
          );
        const context = yield* Layer.build(
          AcpSessionRuntime.layer({
            spawn: {
              ...resolved.spawn,
              env: { ...resolved.spawn.env, ...input.environment },
            },
            cwd: input.cwd,
            clientInfo: { name: "t3-code", version: "0.0.0" },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            ...(settings.authMethodId ? { authMethodId: settings.authMethodId } : {}),
            customModels: customModelSlugs,
            mcpServers: [],
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(SecureRandom.SecureRandom, random),
        );
        return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(context),
        );
      }));

  const runGlmJson = Effect.fn("GlmTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) {
      const { operation } = input;
      const helper = Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-glm-text-" });
        const cwd = path.join(root, "workspace");
        const sessionDirectory = path.join(root, "sessions");
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.makeDirectory(sessionDirectory, { recursive: true });

        const rawResult = yield* Effect.gen(function* () {
          const runtime = yield* makeRuntime({
            cwd,
            environment: {
              ACP_GLM_SESSION_DIR: sessionDirectory,
              // Reads run unprompted in default mode; one turn keeps their output from reaching the model.
              ACP_GLM_MAX_TURNS: "1",
            },
          });
          yield* runtime.getEvents().pipe(
            Stream.runForEach((event) =>
              event._tag === "EventStreamBarrier"
                ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          const output = yield* Ref.make("");
          const rejected = yield* Deferred.make<never, TextGenerationError>();
          const reject = (detail: string) =>
            Deferred.fail(rejected, new TextGenerationError({ operation, detail })).pipe(
              Effect.asVoid,
            );
          const rejectToolRequest = () =>
            reject("GLM text generation requested a tool or user input.").pipe(
              Effect.andThen(
                Effect.fail(
                  new AcpRequestError({
                    code: -32601,
                    errorMessage: "Tools and user input are disabled for text generation.",
                  }),
                ),
              ),
            );

          yield* runtime.handleRequestPermission(() =>
            reject("GLM text generation requested a tool permission or user input.").pipe(
              Effect.as({ outcome: { outcome: "cancelled" as const } }),
            ),
          );
          yield* runtime.handleElicitation(() =>
            reject("GLM text generation requested user input.").pipe(
              Effect.as({ action: "decline" as const }),
            ),
          );
          yield* runtime.handleReadTextFile(rejectToolRequest);
          yield* runtime.handleWriteTextFile(rejectToolRequest);
          yield* runtime.handleCreateTerminal(rejectToolRequest);
          yield* runtime.handleTerminalOutput(rejectToolRequest);
          yield* runtime.handleTerminalWaitForExit(rejectToolRequest);
          yield* runtime.handleTerminalKill(rejectToolRequest);
          yield* runtime.handleTerminalRelease(rejectToolRequest);
          yield* runtime.handleUnknownExtRequest(rejectToolRequest);
          let sessionId: string | undefined;
          yield* runtime.handleSessionUpdate((notification) =>
            Effect.gen(function* () {
              const update = notification.update;
              if (
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update"
              ) {
                return yield* reject("GLM attempted tool work during text generation.");
              }
              if (
                notification.sessionId !== sessionId ||
                update.sessionUpdate !== "agent_message_chunk" ||
                update.content.type !== "text"
              ) {
                return;
              }
              const text = update.content.text;
              const exceeded = yield* Ref.modify(output, (current) =>
                current.length + text.length > MAX_OUTPUT_CHARS
                  ? [true, current]
                  : [false, current + text],
              );
              if (exceeded) {
                return yield* reject("GLM text generation exceeded the output limit.");
              }
            }),
          );

          return yield* Effect.gen(function* () {
            const started = yield* runtime.start();
            sessionId = started.sessionId;
            // Close the ACP session before the runtime scope (the process) closes.
            yield* Effect.addFinalizer(() =>
              runtime.closeSession(sessionId).pipe(Effect.timeoutOption(2_000), Effect.ignore),
            );
            yield* runtime.setMode("default");

            const model = input.modelSelection.model;
            if (model.length > 0 && model !== "default") {
              const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
              const selectable =
                modelOption !== undefined &&
                (customModelSlugs.includes(model) ||
                  flattenSelectChoices(modelOption.options).some(
                    (choice) => choice.value === model,
                  ));
              if (!selectable) {
                return yield* new TextGenerationError({
                  operation,
                  detail: "Could not select the GLM model for text generation.",
                });
              }
              yield* runtime
                .setConfigOption(modelOption.id, model, { allowUnlistedValue: true })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new TextGenerationError({
                        operation,
                        detail: "Could not select the GLM model for text generation.",
                        cause,
                      }),
                  ),
                );
            }
            for (const selection of input.modelSelection.options ?? []) {
              const option = (yield* runtime.getConfigOptions).find(
                (candidate) => candidate.id === selection.id,
              );
              // Only thought_level is safe to replay: saved selections can carry mode bypass.
              if (option?.category !== "thought_level" || option.type !== "select") continue;
              if (typeof selection.value !== "string") continue;
              if (
                !flattenSelectChoices(option.options).some(
                  (choice) => choice.value === selection.value,
                )
              ) {
                continue;
              }
              yield* runtime.setConfigOption(option.id, selection.value).pipe(
                Effect.catchTags({
                  AcpRequestError: (error) =>
                    Effect.logWarning("GLM session rejected a configuration option value", {
                      optionId: option.id,
                      value: selection.value,
                      code: error.code,
                    }),
                }),
              );
            }

            const result = yield* runtime.prompt({
              prompt: [
                {
                  type: "text",
                  text: [
                    "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
                    "Return only the requested JSON object.",
                    "",
                    input.prompt,
                  ].join("\n"),
                },
              ],
            });
            if (yield* Deferred.isDone(rejected)) {
              return yield* Deferred.await(rejected);
            }
            if (result.stopReason === "cancelled") {
              return yield* new TextGenerationError({
                operation,
                detail: "GLM text generation was cancelled.",
              });
            }
            return (yield* Ref.get(output)).trim();
          }).pipe(
            Effect.onInterrupt(() =>
              runtime.cancel.pipe(Effect.timeoutOption(2_000), Effect.ignore),
            ),
            Effect.raceFirst(Deferred.await(rejected)),
          );
        }).pipe(Effect.scoped);

        if ((yield* fs.readDirectory(cwd)).length > 0) {
          return yield* new TextGenerationError({
            operation,
            detail: "GLM wrote files during text generation.",
          });
        }
        if (!rawResult) {
          return yield* new TextGenerationError({
            operation,
            detail: "GLM returned empty text generation output.",
          });
        }
        return yield* TextGenerationOperations.decodeJsonReply(input, "GLM", rawResult);
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(GLM_TEXT_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "GLM text generation timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      return yield* helper;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "GLM text generation failed.",
                cause,
              }),
        ),
      ),
  );

  return TextGenerationOperations.fromRunner(
    "GlmTextGeneration",
    TextGenerationOperations.withoutInvestigation("GLM", runGlmJson),
  );
});
