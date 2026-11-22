import { ProviderSetupError, TextGenerationError } from "@t3tools/contracts";
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

import {
  antigravityThinkingConfig,
  applyAntigravityAcpModelSelection,
} from "../provider/acp/AntigravityAcpSupport.ts";
import { removeAntigravitySessionFiles } from "../provider/acp/AntigravitySessionFiles.ts";
import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  isAntigravitySignInRequiredError,
} from "../provider/antigravityAuthSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { collectSessionConfigOptionValues } from "@t3tools/provider-acp/server/runtimeModel";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

const ANTIGRAVITY_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
/** Everything else, subagents included, reaches the client as another kind such as "other". */
const INVESTIGATION_TOOL_KINDS = new Set(["read", "search", "think", "execute"]);
// agy runs hooks from its working directory outside the sandbox, so that is never the checkout.
const investigationPreamble = (checkout: string) => [
  `The checkout is at ${checkout}, not in your shell's directory. Where the task says the current directory, it means that checkout: run git as \`git -C "${checkout}" ...\` and read files by their absolute path under it.`,
  "Your commands run in a read-only sandbox with no network. Do not write files, leave the sandbox, start subagents, or ask questions: each of those ends this task.",
];
const isTextGenerationError = Schema.is(TextGenerationError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const Configuration = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Configuration));
const decodeConfigurationObject = Schema.decodeUnknownEffect(Configuration);

type AntigravityTextRuntime = Pick<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  | "start"
  | "setMode"
  | "getConfigOptions"
  | "getEvents"
  | "setModel"
  | "setConfigOption"
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
  readonly defaultModel?: Effect.Effect<string | undefined>;
  readonly makeRuntime: (
    cwd: string,
    /** Launch from a throwaway profile that may only read these directories. */
    readOnlyRoots?: ReadonlyArray<string>,
  ) => Effect.Effect<AntigravityTextRuntime, AcpError | ProviderSetupError, Scope.Scope>;
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
    // CLI 1.5.8 writes a 0-byte mcp_config.json before any server exists.
    const empty = yield* fs.readFileString(configurationPath).pipe(
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(true)
          : decodeConfiguration(text).pipe(
              Effect.flatMap((configuration) =>
                decodeConfigurationObject(
                  configuration[name === "hooks.json" ? "hooks" : "mcpServers"] ?? configuration,
                ),
              ),
              Effect.map((configuration) => Object.keys(configuration).length === 0),
            ),
      ),
      Effect.orElseSucceed(() => false),
    );
    if (!empty) return false;
  }
  return true;
});

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  options: AntigravityTextGenerationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hasOnlyRuntimeDirectories = Effect.fn(
    "AntigravityTextGeneration.hasOnlyRuntimeDirectories",
  )(function* (cwd: string) {
    const root = yield* fs.realPath(cwd);
    // ACP creates these empty skill directories before the first prompt.
    const allowed = new Set([
      path.join(root, ".agents"),
      path.join(root, ".agents", "skills"),
      path.join(root, ".gemini"),
      path.join(root, ".gemini", "skills"),
    ]);
    const directories = [root];
    for (const directory of directories) {
      for (const name of yield* fs.readDirectory(directory)) {
        const entry = path.join(directory, name);
        if (
          !allowed.has(entry) ||
          (yield* fs.realPath(entry)) !== entry ||
          (yield* fs.stat(entry)).type !== "Directory"
        ) {
          return false;
        }
        directories.push(entry);
      }
    }
    return true;
  });

  /** The checkout and, for a linked worktree, the main repository's git directory git reads. */
  const investigationRoots = Effect.fn("AntigravityTextGeneration.investigationRoots")(function* (
    cwd: string,
  ) {
    const checkout = yield* fs.realPath(cwd);
    const linked = yield* fs.readFileString(path.join(checkout, ".git")).pipe(
      Effect.map((text) => /^gitdir: (.+)$/m.exec(text)?.[1]?.trim()),
      Effect.orElseSucceed(() => undefined),
    );
    if (linked === undefined) return { checkout, roots: [checkout] };
    const gitDirectory = path.resolve(checkout, linked);
    const common = yield* fs.readFileString(path.join(gitDirectory, "commondir")).pipe(
      Effect.map((text) => path.resolve(gitDirectory, text.trim())),
      Effect.orElseSucceed(() => gitDirectory),
    );
    return {
      checkout,
      roots: [checkout, yield* fs.realPath(common).pipe(Effect.orElseSucceed(() => common))],
    };
  });

  const available = isAntigravityTextGenerationAvailable(options.profileDirectory).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
  );

  const runAntigravityJson = Effect.fn("AntigravityTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: TextGenerationOperations.Request<S>) {
      const { operation, investigate } = input;
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
      const helper = Effect.gen(function* () {
        // An investigation's throwaway profile has no hooks, yet it is refused with the rest:
        // one capability flag says what the model pickers offer for all text generation.
        if (!(yield* available)) {
          return yield* new TextGenerationError({
            operation,
            detail:
              "Antigravity text generation is unavailable for profiles with global hooks or MCP configuration. Select another system model.",
          });
        }

        const investigation = investigate ? yield* investigationRoots(input.cwd) : undefined;
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
          const runtime = yield* options.makeRuntime(cwd, investigation?.roots);
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

          const toolKinds = new Map<string, string>();
          yield* runtime.handleRequestPermission((request) =>
            (investigation === undefined
              ? reject("Antigravity text generation requested a tool permission or user input.")
              : Effect.logInfo("Antigravity asked for an approval while investigating read-only", {
                  title: request.toolCall.title,
                }).pipe(
                  Effect.andThen(
                    reject(
                      "Antigravity asked for an approval, and a read-only investigation grants none. It tried to leave the checkout, or its terminal sandbox is unavailable on this machine.",
                    ),
                  ),
                )
            ).pipe(Effect.as({ outcome: { outcome: "cancelled" as const } })),
          );
          yield* runtime.handleElicitation(() =>
            reject("Antigravity text generation requested user input.").pipe(
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
          yield* runtime.handleSessionUpdate((notification) =>
            Effect.gen(function* () {
              const update = notification.update;
              if (
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update"
              ) {
                if (investigation === undefined) {
                  return yield* reject("Antigravity attempted tool work during text generation.");
                }
                const kind = update.kind ?? toolKinds.get(update.toolCallId) ?? "other";
                toolKinds.set(update.toolCallId, kind);
                // Only the text after the last tool call is the answer.
                yield* Ref.set(output, "");
                // A rule-denied call fails and the turn goes on; completed work is what breaks read-only.
                if (update.status === "completed" && !INVESTIGATION_TOOL_KINDS.has(kind)) {
                  return yield* reject(
                    "Antigravity used a tool that a read-only investigation does not allow.",
                  );
                }
                return;
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
              defaultModel: yield* options.defaultModel ?? Effect.undefined,
              mapError: (cause) =>
                new TextGenerationError({
                  operation,
                  detail: "Could not select the Antigravity model for text generation.",
                  cause,
                }),
            });
            const savedOptions = input.modelSelection.options;
            if (savedOptions?.length) {
              const thinking = antigravityThinkingConfig(yield* runtime.getConfigOptions);
              const selected = savedOptions.find((option) => option.id === thinking?.id)?.value;
              if (
                thinking !== undefined &&
                typeof selected === "string" &&
                selected !== thinking.currentValue &&
                collectSessionConfigOptionValues(thinking).includes(selected)
              ) {
                yield* runtime.setConfigOption(thinking.id, selected).pipe(
                  Effect.catchTags({
                    AcpRequestError: (error) =>
                      error.code === -32602
                        ? Effect.logDebug("Antigravity rejected the saved thinking level", {
                            optionId: thinking.id,
                            value: selected,
                          })
                        : Effect.fail(error),
                  }),
                );
              }
            }

            const result = yield* runtime.prompt({
              prompt: [
                {
                  type: "text",
                  text: [
                    ...(investigation === undefined
                      ? [
                          "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
                        ]
                      : investigationPreamble(investigation.checkout)),
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

        if (!(yield* hasOnlyRuntimeDirectories(cwd))) {
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
        return yield* TextGenerationOperations.decodeJsonReply(input, "Antigravity", rawResult);
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(investigate?.timeoutMs ?? ANTIGRAVITY_TIMEOUT_MS),
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
                detail: isProviderSetupError(cause)
                  ? cause.detail
                  : isAntigravitySignInRequiredError(cause)
                    ? ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE
                    : "Antigravity text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );

  return TextGenerationOperations.fromRunner("AntigravityTextGeneration", runAntigravityJson);
});
