/**
 * `t3 thread new` - start a new thread (and its first turn) on an
 * already-running server.
 *
 * A thread's first turn executes inside the live server process, so unlike
 * `t3 project` there is no offline fallback: without a reachable server the
 * command fails and points at `npx t3 serve`. WebSocket clients start threads
 * with a single bootstrap turn-start, but the HTTP dispatch route has no
 * bootstrap handling, so this command sequences `thread.create` and
 * `thread.turn.start` itself and deletes the thread again when the first turn
 * is rejected.
 */
import {
  AuthStandardClientScopes,
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  type ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { DEFAULT_THREAD_TITLE } from "../orchestration/Layers/ProviderCommandReactor.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  dispatchLiveOrchestrationCommand,
  fetchLiveOrchestrationSnapshot,
  findActiveProjectTarget,
  tryResolveLiveProjectExecutionMode,
} from "./project.ts";

// Dispatch only appends the command to the event log ({sequence} comes back
// before the turn runs), but a busy engine can hold the append longer than the
// project CLI's 1s probe timeout.
const THREAD_CLI_DISPATCH_TIMEOUT = Duration.seconds(10);

export class ThreadCommandIdGenerationError extends Schema.TaggedErrorClass<ThreadCommandIdGenerationError>()(
  "ThreadCommandIdGenerationError",
  {
    operation: Schema.Literal("generateThreadCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a thread command identifier.";
  }
}

export class ThreadPromptEmptyError extends Schema.TaggedErrorClass<ThreadPromptEmptyError>()(
  "ThreadPromptEmptyError",
  {
    operation: Schema.Literal("validateThreadPrompt"),
  },
) {
  override get message(): string {
    return "Thread prompt cannot be empty.";
  }
}

export class ThreadTitleEmptyError extends Schema.TaggedErrorClass<ThreadTitleEmptyError>()(
  "ThreadTitleEmptyError",
  {
    operation: Schema.Literal("validateThreadTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Thread title cannot be empty.";
  }
}

export class ThreadNoRunningServerError extends Schema.TaggedErrorClass<ThreadNoRunningServerError>()(
  "ThreadNoRunningServerError",
  {
    checkedStatePath: Schema.String,
  },
) {
  override get message(): string {
    return [
      "No running T3 Code server found.",
      `  checked ${this.checkedStatePath}`,
      "A thread's first turn runs on the live server; start one with `npx t3 serve` and retry.",
    ].join("\n");
  }
}

const threadCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    (cause) =>
      new ThreadCommandIdGenerationError({
        operation: "generateThreadCommandId",
        cause,
      }),
  ),
);

const withThreadCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthStandardClientScopes,
      label: "t3 thread cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

/**
 * The title the created thread starts with. Without an explicit title the
 * server default is used on purpose: the ProviderCommandReactor only replaces
 * `DEFAULT_THREAD_TITLE` (or an exact titleSeed match) with a generated title,
 * so an explicit `--title` stays fixed.
 */
export const resolveThreadNewTitle = Effect.fn("resolveThreadNewTitle")(function* (
  explicitTitle?: string,
) {
  if (explicitTitle === undefined) {
    return DEFAULT_THREAD_TITLE;
  }
  const trimmed = explicitTitle.trim();
  if (trimmed.length === 0) {
    return yield* new ThreadTitleEmptyError({
      operation: "validateThreadTitle",
      title: explicitTitle,
    });
  }
  return trimmed;
});

export interface ThreadLaunchCommandInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly createCommandId: CommandId;
  readonly turnStartCommandId: CommandId;
  readonly createdAt: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

/**
 * The command pair that replaces the WebSocket bootstrap: create the thread
 * first (no branch, no worktree - the thread runs in the project checkout),
 * then start its first turn.
 */
export const buildThreadLaunchCommands = (
  input: ThreadLaunchCommandInput,
): {
  readonly create: Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
  readonly turnStart: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
} => ({
  create: {
    type: "thread.create",
    commandId: input.createCommandId,
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt,
  },
  turnStart: {
    type: "thread.turn.start",
    commandId: input.turnStartCommandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: input.createdAt,
  },
});

const threadNewCommand = Command.make("new", {
  ...projectLocationFlags,
  prompt: Argument.string("prompt").pipe(
    Argument.withDescription("First user message of the new thread."),
  ),
  project: Flag.string("project").pipe(
    Flag.withDescription(
      "Project id or workspace root. Defaults to the current working directory's project.",
    ),
    Flag.optional,
  ),
  title: Flag.string("title").pipe(
    Flag.withDescription("Fixed thread title. Defaults to a server-generated title."),
    Flag.optional,
  ),
  runtimeMode: Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDescription(`Permission mode for the thread. Defaults to ${DEFAULT_RUNTIME_MODE}.`),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Start a new thread on a running T3 Code server."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const prompt = flags.prompt.trim();
      if (prompt.length === 0) {
        return yield* new ThreadPromptEmptyError({ operation: "validateThreadPrompt" });
      }
      const title = yield* resolveThreadNewTitle(Option.getOrUndefined(flags.title));
      const runtimeMode = Option.getOrElse(flags.runtimeMode, () => DEFAULT_RUNTIME_MODE);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);

      yield* Effect.gen(function* () {
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const liveMode = yield* tryResolveLiveProjectExecutionMode(environmentAuth, config);
        if (Option.isNone(liveMode)) {
          return yield* new ThreadNoRunningServerError({
            checkedStatePath: config.serverRuntimeStatePath,
          });
        }
        const origin = liveMode.value.origin;

        yield* withThreadCliSessionToken(environmentAuth, (token) =>
          Effect.gen(function* () {
            const snapshot = yield* fetchLiveOrchestrationSnapshot(origin, token);
            const target = yield* findActiveProjectTarget({
              snapshot,
              identifier: Option.getOrElse(flags.project, () => process.cwd()),
            });
            const modelSelection =
              snapshot.projects.find((project) => project.id === target.id)
                ?.defaultModelSelection ??
              ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection();

            const commands = buildThreadLaunchCommands({
              threadId: ThreadId.make(yield* threadCommandUuid),
              messageId: MessageId.make(yield* threadCommandUuid),
              createCommandId: CommandId.make(yield* threadCommandUuid),
              turnStartCommandId: CommandId.make(yield* threadCommandUuid),
              createdAt: DateTime.formatIso(yield* DateTime.now),
              projectId: target.id,
              title,
              prompt,
              modelSelection,
              runtimeMode,
            });

            yield* dispatchLiveOrchestrationCommand(origin, token, commands.create, {
              timeout: THREAD_CLI_DISPATCH_TIMEOUT,
            });
            // The thread now exists; a rejected first turn would leave an
            // empty thread behind, so delete it again before failing.
            yield* dispatchLiveOrchestrationCommand(origin, token, commands.turnStart, {
              timeout: THREAD_CLI_DISPATCH_TIMEOUT,
            }).pipe(
              Effect.tapError(() =>
                threadCommandUuid.pipe(
                  Effect.flatMap((cleanupUuid) =>
                    dispatchLiveOrchestrationCommand(
                      origin,
                      token,
                      {
                        type: "thread.delete",
                        commandId: CommandId.make(cleanupUuid),
                        threadId: commands.create.threadId,
                      },
                      { timeout: THREAD_CLI_DISPATCH_TIMEOUT },
                    ),
                  ),
                  Effect.ignore({ log: true }),
                ),
              ),
            );

            yield* Console.log(
              [
                `Started thread ${commands.create.threadId} in project ${target.title} (${runtimeMode}).`,
                `Follow it in T3 Code at ${origin}.`,
              ].join("\n"),
            );
          }),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
          ),
        ),
      );
    }),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([threadNewCommand]),
);
