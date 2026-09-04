import {
  type ModelSelection,
  type ProviderSetupError,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type AcpError, AcpRequestError } from "effect-acp/errors";

import { applyAntigravityAcpModelSelection } from "../provider/acp/AntigravityAcpSupport.ts";
import { removeAntigravitySessionFiles } from "../provider/acp/AntigravitySessionFiles.ts";
import type { AcpSessionRuntime } from "../provider/acp/AcpSessionRuntime.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const ANTIGRAVITY_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
const isTextGenerationError = Schema.is(TextGenerationError);
const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const Configuration = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Configuration));
const decodeConfigurationObject = Schema.decodeUnknownEffect(Configuration);

type AntigravityTextRuntime = Pick<
  AcpSessionRuntime["Service"],
  | "start"
  | "setMode"
  | "getConfigOptions"
  | "getEvents"
  | "setModel"
  | "prompt"
  | "cancel"
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

export interface AntigravityTextGenerationOptions {
  readonly profileDirectory: string;
  /** Model the provider default alias selects, when the account offers it. */
  readonly defaultModel?: Effect.Effect<string | undefined>;
  /** Uses the instance's personal Google login, with no injected MCP servers or client tools. */
  readonly makeRuntime: (
    cwd: string,
  ) => Effect.Effect<AntigravityTextRuntime, AcpError | ProviderSetupError, Scope.Scope>;
  /** Registers the whole helper so sign-out can stop it before clearing credentials. */
  readonly withProcess: <A, E, R>(
    stop: Effect.Effect<void>,
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
}

/** Global hooks and MCP servers can run before a helper can deny a tool request. */
export const isAntigravityTextGenerationAvailable = Effect.fn(
  "isAntigravityTextGenerationAvailable",
)(function* (profileDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of ["hooks.json", "mcp_config.json"]) {
    const configurationPath = path.join(profileDirectory, "config", name);
    if (!(yield* fs.exists(configurationPath))) {
      continue;
    }
    const info = yield* fs.stat(configurationPath);
    if (info.type !== "File" || info.size > 64_000n) {
      return false;
    }
    const empty = yield* fs.readFileString(configurationPath).pipe(
      Effect.flatMap(decodeConfiguration),
      Effect.flatMap((configuration) =>
        decodeConfigurationObject(
          configuration[name === "hooks.json" ? "hooks" : "mcpServers"] ?? configuration,
        ),
      ),
      Effect.map((configuration) => Object.keys(configuration).length === 0),
      Effect.orElseSucceed(() => false),
    );
    if (!empty) return false;
  }
  return true;
});

/** Runs short-lived subscription helpers without giving them the user's workspace. */
export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  options: AntigravityTextGenerationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const available = isAntigravityTextGenerationAvailable(options.profileDirectory).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const runAntigravityJson = Effect.fn("AntigravityTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: {
      readonly operation: keyof TextGeneration.TextGeneration["Service"];
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: ModelSelection;
    }) {
      const { operation } = input;
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const helper = Effect.gen(function* () {
        if (!(yield* available)) {
          return yield* new TextGenerationError({
            operation,
            detail:
              "Antigravity text generation is unavailable for profiles with global hooks or MCP configuration. Select another system model.",
          });
        }

        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-text-" });
        let sessionId: string | undefined;
        yield* Effect.addFinalizer(() =>
          removeAntigravitySessionFiles({
            profileDirectory: options.profileDirectory,
            sessionId,
            cwd,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
        );

        const rawResult = yield* Effect.gen(function* () {
          const runtime = yield* options.makeRuntime(cwd);
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
            reject("Antigravity text generation requested a tool or user input.").pipe(
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
            reject("Antigravity text generation requested a tool permission or user input.").pipe(
              Effect.as({ outcome: { outcome: "cancelled" as const } }),
            ),
          );
          yield* runtime.handleElicitation(() =>
            reject("Antigravity text generation requested user input.").pipe(
              Effect.as({ action: { action: "decline" as const } }),
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
          yield* runtime.handleSessionUpdate((notification) =>
            Effect.gen(function* () {
              const update = notification.update;
              if (
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update"
              ) {
                return yield* reject("Antigravity attempted tool work during text generation.");
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
                return yield* reject("Antigravity text generation exceeded the output limit.");
              }
            }),
          );

          return yield* Effect.gen(function* () {
            const started = yield* runtime.start();
            sessionId = started.sessionId;
            if (!isNativeSessionId(sessionId)) {
              return yield* new TextGenerationError({
                operation,
                detail: "Antigravity returned an invalid text helper session ID.",
              });
            }
            yield* runtime.setMode("default");
            yield* applyAntigravityAcpModelSelection({
              runtime,
              model: input.modelSelection.model,
              defaultModel: yield* options.defaultModel ?? Effect.succeed(undefined),
              mapError: (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Could not select the Antigravity model for text generation.",
                  cause,
                }),
            });

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
                detail: "Antigravity text generation was cancelled.",
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
            detail: "Antigravity wrote files during text generation.",
          });
        }
        if (!rawResult) {
          return yield* new TextGenerationError({
            operation,
            detail: "Antigravity returned empty text generation output.",
          });
        }
        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
        return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Antigravity returned invalid structured output.",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(ANTIGRAVITY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Antigravity text generation timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

      return yield* options
        .withProcess(Scope.close(scope, Exit.void), helper)
        .pipe(Effect.provideService(Scope.Scope, scope));
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Antigravity text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      const generated = yield* runAntigravityJson({
        operation: "generateCommitMessage",
        ...buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AntigravityTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* runAntigravityJson({
        operation: "generatePrContent",
        ...buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        }),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* runAntigravityJson({
        operation: "generateBranchName",
        ...buildBranchNamePrompt({ message: input.message, attachments: input.attachments }),
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* runAntigravityJson({
        operation: "generateThreadTitle",
        ...buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          attachments: input.attachments,
        }),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
