// @effect-diagnostics nodeBuiltinImport:off - `thread send` reads piped message text from stdin.
import {
  AuthAdministrativeScopes,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EnvironmentHttpApi,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  ThreadFollowRenderer,
  threadEventStream,
  type ThreadFollowOutput,
} from "./threadFollow.ts";
import {
  type CliAuthLocationFlags,
  DurationFromString,
  projectLocationFlags,
  resolveCliAuthConfig,
} from "./config.ts";

type ThreadCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.snooze" | "thread.unsnooze" | "thread.create" | "thread.turn.start" }
>;

export class ThreadCliUsageError extends Schema.TaggedError<ThreadCliUsageError>()(
  "ThreadCliUsageError",
  { message: Schema.String },
) {}

export class ThreadCliServerUnavailableError extends Schema.TaggedError<ThreadCliServerUnavailableError>()(
  "ThreadCliServerUnavailableError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "No running T3 Code server is available.";
  }
}

export class ThreadCliRequestError extends Schema.TaggedError<ThreadCliRequestError>()(
  "ThreadCliRequestError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The T3 Code server rejected the thread command.";
  }
}

const threadArgument = Argument.string("thread").pipe(
  Argument.withDescription("Thread id. Defaults to T3_THREAD_ID inside a T3 agent session."),
  Argument.optional,
);

const forFlag = Flag.string("for").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Snooze duration, for example 1h, 10d, or 2 weeks."),
  Flag.optional,
);

const untilFlag = Flag.string("until").pipe(
  Flag.withDescription("Absolute ISO-8601 wake time."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription(
    "Emit JSON instead of human-readable output. With --follow, emits one JSON object per line.",
  ),
  Flag.withDefault(false),
);

const followFlag = Flag.boolean("follow").pipe(
  Flag.withAlias("f"),
  Flag.withDescription(
    "Stream assistant text live as it is written; activity lines go to stderr. Implies --wait for send/new.",
  ),
  Flag.withDefault(false),
);

const makeClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

const requestTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(Duration.seconds(2)));

// Thread detail snapshots carry message bodies, so they get more headroom than
// the shell snapshot and dispatch calls.
const detailRequestTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(Duration.seconds(15)));

const commandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError((cause) => new ThreadCliRequestError({ cause })),
);

const withThreadCliSession = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 thread cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const fetchShellSnapshot = (origin: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* makeClient(origin);
    return yield* client.orchestration.shellSnapshot({
      headers: { authorization: `Bearer ${token}` },
    });
  }).pipe(
    requestTimeout,
    Effect.mapError((cause) => new ThreadCliRequestError({ cause })),
  );

const fetchThreadDetail = (origin: string, token: string, threadId: string, turnLimit: number) =>
  Effect.gen(function* () {
    const client = yield* makeClient(origin);
    return yield* client.orchestration.threadSnapshot({
      headers: { authorization: `Bearer ${token}` },
      params: { threadId: ThreadId.make(threadId) },
      payload: { turnLimit },
    } as Parameters<typeof client.orchestration.threadSnapshot>[0]);
  }).pipe(
    detailRequestTimeout,
    Effect.mapError((cause) => new ThreadCliRequestError({ cause })),
  );

const dispatchThreadCommand = (origin: string, token: string, command: ThreadCliDispatchCommand) =>
  Effect.gen(function* () {
    const client = yield* makeClient(origin);
    yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${token}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(
    requestTimeout,
    Effect.mapError((cause) => new ThreadCliRequestError({ cause })),
  );

export function resolveThreadCliTarget(
  snapshot: OrchestrationShellSnapshot,
  explicitThreadId: string | undefined,
  environment: NodeJS.ProcessEnv,
): OrchestrationThreadShell {
  const threadId = explicitThreadId?.trim() || environment.T3_THREAD_ID?.trim();
  if (!threadId) {
    throw new ThreadCliUsageError({
      message: "Pass a thread id or run inside a T3 agent session with T3_THREAD_ID set.",
    });
  }
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new ThreadCliUsageError({ message: `Thread '${threadId}' was not found.` });
  }
  return thread;
}

export function resolveThreadCliWakeTime(input: {
  readonly duration: Duration.Duration | undefined;
  readonly until: string | undefined;
  readonly now: DateTime.Utc;
}): string {
  if ((input.duration === undefined) === (input.until === undefined)) {
    throw new ThreadCliUsageError({ message: "Pass exactly one of --for or --until." });
  }
  const wake =
    input.duration !== undefined
      ? DateTime.add(input.now, { milliseconds: Duration.toMillis(input.duration) })
      : Option.getOrThrowWith(
          DateTime.make(input.until!),
          () =>
            new ThreadCliUsageError({ message: `Invalid ISO-8601 wake time '${input.until}'.` }),
        );
  if (DateTime.toEpochMillis(wake) <= DateTime.toEpochMillis(input.now)) {
    throw new ThreadCliUsageError({ message: "The wake time must be in the future." });
  }
  return DateTime.formatIso(wake);
}

/** Pretty-printed JSON for `--json` output; these are plain CLI views, not wire payloads. */
export function formatThreadCliJson(value: unknown): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(value, null, 2);
}

/** Single-line JSON for NDJSON streaming output. */
export function formatThreadCliJsonLine(value: unknown): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(value);
}

export type ThreadCliStatus = "running" | "approval" | "input" | "error" | "snoozed" | "idle";

export function threadCliStatus(thread: OrchestrationThreadShell): ThreadCliStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (isThreadCliTurnActive(thread)) return "running";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "error";
  if (thread.snoozedUntil != null) return "snoozed";
  return "idle";
}

export function isThreadCliTurnActive(thread: OrchestrationThreadShell): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.activeTurnId != null ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running"
  );
}

export interface ThreadCliSummary {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ThreadCliStatus;
  readonly provider: string;
  readonly model: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

export function summarizeThread(thread: OrchestrationThreadShell): ThreadCliSummary {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: threadCliStatus(thread),
    provider: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
    archived: thread.archivedAt != null,
  };
}

export function listThreadCliThreads(
  snapshot: OrchestrationShellSnapshot,
  options: { readonly includeArchived: boolean },
): ReadonlyArray<ThreadCliSummary> {
  return snapshot.threads
    .filter((thread) => options.includeArchived || thread.archivedAt == null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summarizeThread);
}

export function resolveThreadCliMessageText(
  argument: string | undefined,
  readStdin: () => string | undefined,
): string {
  const raw = argument === undefined || argument === "-" ? readStdin() : argument;
  const text = raw?.trim();
  if (text === undefined || text.length === 0) {
    throw new ThreadCliUsageError({
      message: "Provide a message argument or pipe the message on stdin.",
    });
  }
  return text;
}

export function conversationMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  return messages.filter((message) => message.role === "user" || message.role === "assistant");
}

export function toCliMessage(message: OrchestrationMessage) {
  return {
    id: message.id,
    role: message.role,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    text: message.text,
  };
}

/** Joins every assistant message in a turn, since agents often reply in several parts. */
export function selectTurnReply(
  messages: ReadonlyArray<OrchestrationMessage>,
  turnId: string,
): string {
  return messages
    .filter((message) => message.role === "assistant" && message.turnId === turnId)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

type ThreadCliProject = OrchestrationShellSnapshot["projects"][number];

/**
 * Matches a project by id, exact title, or workspace root. With no selector,
 * picks the project whose workspace root contains `cwd`, preferring the
 * deepest root so nested projects win over their parents.
 */
export function resolveThreadCliProject(
  snapshot: OrchestrationShellSnapshot,
  selector: string | undefined,
  cwd: string,
): ThreadCliProject {
  const projects = snapshot.projects;
  if (selector !== undefined) {
    const root = selector.replace(/\/+$/, "");
    const match = projects.find(
      (project) =>
        project.id === selector || project.title === selector || project.workspaceRoot === root,
    );
    if (match === undefined) {
      throw new ThreadCliUsageError({ message: `Unknown project '${selector}'.` });
    }
    return match;
  }
  const containing = projects
    .filter(
      (project) => cwd === project.workspaceRoot || cwd.startsWith(`${project.workspaceRoot}/`),
    )
    .toSorted((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
  const [match] = containing;
  if (match === undefined) {
    throw new ThreadCliUsageError({
      message: "No T3 project contains the current directory. Pass --project.",
    });
  }
  return match;
}

/**
 * Uses the project's default model, falling back to its most recent thread's
 * model. Explicit --provider/--model flags override either; switching provider
 * requires a model because model ids are provider-specific.
 */
export function resolveThreadCliModelSelection(
  snapshot: OrchestrationShellSnapshot,
  project: ThreadCliProject,
  overrides: { readonly provider: string | undefined; readonly model: string | undefined } = {
    provider: undefined,
    model: undefined,
  },
): OrchestrationThreadShell["modelSelection"] {
  const [recent] = snapshot.threads
    .filter((thread) => thread.projectId === project.id)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const base = project.defaultModelSelection ?? recent?.modelSelection;
  const provider = overrides.provider?.trim();
  const model = overrides.model?.trim();
  if (provider && provider !== base?.instanceId) {
    if (!model) {
      throw new ThreadCliUsageError({ message: "--provider requires --model." });
    }
    return { instanceId: ProviderInstanceId.make(provider), model };
  }
  if (base === undefined) {
    if (provider && model) return { instanceId: ProviderInstanceId.make(provider), model };
    throw new ThreadCliUsageError({
      message: `Project '${project.title}' has no default model. Pass --provider and --model.`,
    });
  }
  // Model options (reasoning effort etc.) belong to the base model; drop them when it changes.
  return model && model !== base.model ? { instanceId: base.instanceId, model } : base;
}

export function deriveThreadCliTitle(text: string): string {
  const firstLine = text.split("\n", 1)[0]!.trim();
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57).trimEnd()}...`;
}

export interface SettledTurn {
  readonly turnId: string;
  readonly state: "completed" | "interrupted" | "error";
}

/**
 * Returns the thread's new turn once it has settled. A turn counts as new only
 * when its id differs from the one seen before dispatch, so a stale completed
 * turn can never be mistaken for the reply.
 */
export function findSettledTurn(
  snapshot: OrchestrationShellSnapshot,
  threadId: string,
  previousTurnId: string | null,
): SettledTurn | undefined {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  const turn = thread?.latestTurn;
  if (thread === undefined || turn == null || turn.turnId === previousTurnId) return undefined;
  if (turn.state === "running" || isThreadCliTurnActive(thread)) return undefined;
  return { turnId: turn.turnId, state: turn.state };
}

const waitForSettledTurn = (input: {
  readonly threadId: string;
  readonly previousTurnId: string | null;
  readonly refresh: Effect.Effect<OrchestrationShellSnapshot, Error, HttpClient.HttpClient>;
}): Effect.Effect<SettledTurn, Error, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.seconds(2));
      const settled = findSettledTurn(yield* input.refresh, input.threadId, input.previousTurnId);
      if (settled !== undefined) return settled;
    }
  });

const runThreadCli = Effect.fn("runThreadCli")(function* <A>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationShellSnapshot;
    readonly dispatch: (
      command: ThreadCliDispatchCommand,
    ) => Effect.Effect<void, Error, HttpClient.HttpClient>;
    readonly fetchDetail: (
      threadId: string,
      turnLimit: number,
    ) => Effect.Effect<OrchestrationThreadDetailSnapshot, Error, HttpClient.HttpClient>;
    readonly refreshSnapshot: Effect.Effect<
      OrchestrationShellSnapshot,
      Error,
      HttpClient.HttpClient
    >;
    readonly follow: (threadId: string) => ReturnType<typeof threadEventStream>;
  }) => Effect.Effect<A, Error, Crypto.Crypto | HttpClient.HttpClient>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;
  const runtimeLayer = Layer.mergeAll(EnvironmentAuth.runtimeLayer, WorkspacePaths.layer).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );

  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadCliServerUnavailableError({});
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* withThreadCliSession(environmentAuth, (token) =>
      Effect.gen(function* () {
        // Only the first request proves the server is reachable. Later
        // failures are real rejections and keep their own error.
        const snapshot = yield* fetchShellSnapshot(origin, token).pipe(
          Effect.catchTag(
            "ThreadCliRequestError",
            (cause) => new ThreadCliServerUnavailableError({ cause }),
          ),
        );
        return yield* run({
          snapshot,
          dispatch: (command) => dispatchThreadCommand(origin, token, command),
          fetchDetail: (threadId, turnLimit) =>
            fetchThreadDetail(origin, token, threadId, turnLimit),
          refreshSnapshot: fetchShellSnapshot(origin, token),
          follow: (threadId) => threadEventStream({ origin, token, threadId }),
        });
      }),
    );
  }).pipe(Effect.provide(runtimeLayer));
});

const threadSnoozeCommand = Command.make("snooze", {
  ...projectLocationFlags,
  thread: threadArgument,
  duration: forFlag,
  until: untilFlag,
}).pipe(
  Command.withDescription(
    "Snooze a thread. A running turn is allowed to finish without waking the thread again.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadSnoozeCli")(function* ({ snapshot, dispatch }) {
        const thread = resolveThreadCliTarget(
          snapshot,
          Option.getOrUndefined(flags.thread),
          process.env,
        );
        const snoozedUntil = resolveThreadCliWakeTime({
          duration: Option.getOrUndefined(flags.duration),
          until: Option.getOrUndefined(flags.until),
          now: yield* DateTime.now,
        });
        const activeTurnId =
          thread.session?.status === "running" || thread.session?.status === "starting"
            ? (thread.session.activeTurnId ?? undefined)
            : undefined;
        yield* dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(yield* commandUuid),
          threadId: thread.id,
          snoozedUntil,
          ...(activeTurnId === undefined ? {} : { snoozedThroughTurnId: activeTurnId }),
        });
        yield* Console.log(
          `Snoozed ${thread.id} (${thread.title}) until ${snoozedUntil}${
            activeTurnId === undefined ? "." : ` through turn ${activeTurnId}.`
          }`,
        );
      }),
    ),
  ),
);

const threadWakeCommand = Command.make("wake", {
  ...projectLocationFlags,
  thread: threadArgument,
}).pipe(
  Command.withDescription("Wake a snoozed thread."),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadWakeCli")(function* ({ snapshot, dispatch }) {
        const thread = resolveThreadCliTarget(
          snapshot,
          Option.getOrUndefined(flags.thread),
          process.env,
        );
        yield* dispatch({
          type: "thread.unsnooze",
          commandId: CommandId.make(yield* commandUuid),
          threadId: ThreadId.make(thread.id),
          reason: "user",
        });
        yield* Console.log(`Woke ${thread.id} (${thread.title}).`);
      }),
    ),
  ),
);

const threadStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  thread: threadArgument,
}).pipe(
  Command.withDescription("Show a thread's snooze status."),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadStatusCli")(function* ({ snapshot }) {
        const thread = resolveThreadCliTarget(
          snapshot,
          Option.getOrUndefined(flags.thread),
          process.env,
        );
        const state =
          thread.snoozedUntil == null
            ? "awake"
            : `snoozed until ${thread.snoozedUntil}${
                thread.snoozedThroughTurnId == null
                  ? ""
                  : ` through turn ${thread.snoozedThroughTurnId}`
              }`;
        yield* Console.log(`${thread.id} (${thread.title}): ${state}.`);
      }),
    ),
  ),
);

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
  all: Flag.boolean("all").pipe(
    Flag.withDescription("Include archived threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("List threads, most recently updated first."),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadListCli")(function* ({ snapshot }) {
        const threads = listThreadCliThreads(snapshot, { includeArchived: flags.all });
        if (flags.json) {
          yield* Console.log(formatThreadCliJson(threads));
          return;
        }
        for (const thread of threads) {
          yield* Console.log(
            `${thread.id}  ${thread.status.padEnd(11)}  ${thread.updatedAt}  ${thread.title}`,
          );
        }
      }),
    ),
  ),
);

const threadShowCommand = Command.make("show", {
  ...projectLocationFlags,
  thread: threadArgument,
  turns: Flag.integer("turns").pipe(
    Flag.withDescription("Number of recent turns to include. Default: 5."),
    Flag.withDefault(5),
  ),
  follow: followFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Print a thread's recent user and assistant messages. With --follow, keep streaming new output until interrupted.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadShowCli")(function* (cli) {
        const { snapshot, fetchDetail } = cli;
        const thread = resolveThreadCliTarget(
          snapshot,
          Option.getOrUndefined(flags.thread),
          process.env,
        );
        const detail = yield* fetchDetail(thread.id, Math.max(1, flags.turns));
        const messages = conversationMessages(detail.thread.messages);
        if (flags.json) {
          yield* Console.log(
            formatThreadCliJson({
              thread: summarizeThread(thread),
              messages: messages.map(toCliMessage),
            }),
          );
          return;
        }
        yield* Console.log(`${thread.id} (${thread.title}) — ${threadCliStatus(thread)}\n`);
        for (const message of messages) {
          yield* Console.log(`[${message.role}] ${message.createdAt}\n${message.text}\n`);
        }
        if (flags.follow) {
          const renderer = new ThreadFollowRenderer();
          // Anything already printed above is seeded so it is not repeated;
          // an in-progress message continues from where the snapshot left off.
          renderer.seed(detail.thread.messages);
          yield* cli
            .follow(thread.id)
            .pipe(
              Stream.runForEach((item) =>
                writeFollowOutput(item.kind === "snapshot" ? [] : renderer.handleItem(item), false),
              ),
            );
        }
      }),
    ),
  ),
);

/**
 * Writes followed output. Plain mode sends reply text to stdout and activity to
 * stderr, so stdout stays the pure reply. JSON mode emits one NDJSON object per
 * chunk on stdout.
 */
const writeFollowOutput = (outputs: ReadonlyArray<ThreadFollowOutput>, json: boolean) =>
  Effect.sync(() => {
    for (const output of outputs) {
      if (json) {
        process.stdout.write(`${formatThreadCliJsonLine(output)}\n`);
      } else if (output.type === "text") {
        process.stdout.write(output.text);
      } else {
        process.stderr.write(`\n· ${output.summary}\n`);
      }
    }
  });

/**
 * Starts consuming the live stream in the background and resolves once the
 * initial snapshot has seeded the renderer, so nothing sent afterwards is
 * missed or duplicated.
 */
const startFollowing = Effect.fn("startFollowing")(function* (input: {
  readonly cli: ThreadCliRunInput;
  readonly threadId: string;
  readonly renderer: ThreadFollowRenderer;
  readonly json: boolean;
}) {
  const ready = yield* Deferred.make<void>();
  const fiber = yield* input.cli.follow(input.threadId).pipe(
    Stream.runForEach((item) =>
      Effect.gen(function* () {
        if (item.kind === "snapshot" || item.kind === "synchronized") {
          yield* Deferred.succeed(ready, undefined);
        }
        yield* writeFollowOutput(input.renderer.handleItem(item), input.json);
      }),
    ),
    Effect.ensuring(Deferred.succeed(ready, undefined)),
    Effect.forkScoped,
  );
  yield* Deferred.await(ready);
  return fiber;
});

const readThreadCliStdin = () => (process.stdin.isTTY ? undefined : NodeFS.readFileSync(0, "utf8"));

const waitFlag = Flag.boolean("wait").pipe(
  Flag.withDescription("Wait for the turn to finish and print the assistant reply."),
  Flag.withDefault(false),
);

const timeoutFlag = Flag.string("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Maximum time to wait with --wait or --follow. Default: 30m."),
  Flag.optional,
);

const messageArgument = Argument.string("message").pipe(
  Argument.withDescription("Message text. Omit or pass `-` to read it from stdin."),
  Argument.optional,
);

type ThreadCliRunInput = Parameters<Parameters<typeof runThreadCli>[1]>[0];

/**
 * Dispatches a turn, then either reports that it started or waits for the new
 * turn to settle and prints its reply. Shared by `send` and `new`.
 */
const startThreadCliTurn = Effect.fn("startThreadCliTurn")(function* (input: {
  readonly cli: ThreadCliRunInput;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly previousTurnId: string | null;
  /** Commands dispatched before the turn, such as creating the thread. */
  readonly prepare?: ReadonlyArray<ThreadCliDispatchCommand>;
  readonly command: (ids: {
    readonly commandId: CommandId;
    readonly messageId: MessageId;
    readonly createdAt: string;
  }) => Extract<ThreadCliDispatchCommand, { type: "thread.turn.start" }>;
  readonly wait: boolean;
  readonly follow: boolean;
  readonly timeout: Option.Option<Duration.Duration>;
  readonly json: boolean;
}) {
  for (const command of input.prepare ?? []) {
    yield* input.cli.dispatch(command);
  }
  // Subscribe before dispatching so the start of the reply is never missed.
  const renderer = new ThreadFollowRenderer();
  const follower = input.follow
    ? yield* startFollowing({
        cli: input.cli,
        threadId: input.threadId,
        renderer,
        json: input.json,
      })
    : undefined;

  const messageId = MessageId.make(yield* commandUuid);
  yield* input.cli.dispatch(
    input.command({
      commandId: CommandId.make(yield* commandUuid),
      messageId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    }),
  );
  if (!input.wait && !input.follow) {
    yield* Console.log(
      input.json
        ? formatThreadCliJson({ threadId: input.threadId, messageId, status: "started" })
        : `Sent to ${input.threadId} (${input.label}).`,
    );
    return;
  }

  const timeout = Option.getOrElse(input.timeout, () => Duration.minutes(30));
  const settled = yield* waitForSettledTurn({
    threadId: input.threadId,
    previousTurnId: input.previousTurnId,
    refresh: input.cli.refreshSnapshot,
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new ThreadCliUsageError({
            message: `Timed out after ${Duration.format(timeout)} waiting for ${input.threadId}.`,
          }),
        ),
    }),
  );
  const detail = yield* input.cli.fetchDetail(input.threadId, 1);
  const reply = selectTurnReply(detail.thread.messages, settled.turnId);

  if (follower !== undefined) {
    yield* Fiber.interrupt(follower);
    // The stored messages are authoritative; print anything the stream missed.
    yield* writeFollowOutput(
      renderer.reconcile(detail.thread.messages, settled.turnId),
      input.json,
    );
    yield* Effect.sync(() =>
      process.stdout.write(
        input.json
          ? `${formatThreadCliJsonLine({
              type: "result",
              threadId: input.threadId,
              messageId,
              turnId: settled.turnId,
              state: settled.state,
              reply,
            })}\n`
          : "\n",
      ),
    );
  } else {
    yield* Console.log(
      input.json
        ? formatThreadCliJson({
            threadId: input.threadId,
            messageId,
            turnId: settled.turnId,
            state: settled.state,
            reply,
          })
        : reply,
    );
  }
  if (settled.state !== "completed") {
    return yield* new ThreadCliUsageError({
      message: `Turn ${settled.turnId} ended with state '${settled.state}'.`,
    });
  }
}, Effect.scoped);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: Argument.string("thread").pipe(
    Argument.withDescription("Thread id. Use `-` for T3_THREAD_ID inside a T3 agent session."),
  ),
  message: messageArgument,
  wait: waitFlag,
  follow: followFlag,
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread, starting a new turn with the thread's current provider and model.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadSendCli")(function* (cli) {
        const thread = resolveThreadCliTarget(
          cli.snapshot,
          flags.thread === "-" ? undefined : flags.thread,
          process.env,
        );
        const text = resolveThreadCliMessageText(
          Option.getOrUndefined(flags.message),
          readThreadCliStdin,
        );
        if (isThreadCliTurnActive(thread)) {
          return yield* new ThreadCliUsageError({
            message: `Thread ${thread.id} already has a turn in progress.`,
          });
        }
        yield* startThreadCliTurn({
          cli,
          threadId: thread.id,
          label: thread.title,
          previousTurnId: thread.latestTurn?.turnId ?? null,
          command: ({ commandId, messageId, createdAt }) => ({
            type: "thread.turn.start",
            commandId,
            threadId: thread.id,
            message: { messageId, role: "user", text, attachments: [] },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt,
          }),
          wait: flags.wait,
          follow: flags.follow,
          timeout: flags.timeout,
          json: flags.json,
        });
      }),
    ),
  ),
);

const threadNewCommand = Command.make("new", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription(
      "Project id, title, or workspace path. Defaults to the project containing the current directory.",
    ),
    Flag.optional,
  ),
  title: Flag.string("title").pipe(
    Flag.withDescription("Thread title. Defaults to the first line of the message."),
    Flag.optional,
  ),
  provider: Flag.string("provider").pipe(
    Flag.withDescription("Provider instance id, for example `codex` or `claudeAgent`."),
    Flag.optional,
  ),
  model: Flag.string("model").pipe(
    Flag.withDescription("Model id. Required when --provider differs from the project default."),
    Flag.optional,
  ),
  message: messageArgument,
  wait: waitFlag,
  follow: followFlag,
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create a thread and send its first message, using the project's default provider and model.",
  ),
  Command.withHandler((flags) =>
    runThreadCli(
      flags,
      Effect.fn("threadNewCli")(function* (cli) {
        const project = resolveThreadCliProject(
          cli.snapshot,
          Option.getOrUndefined(flags.project),
          process.cwd(),
        );
        const modelSelection = resolveThreadCliModelSelection(cli.snapshot, project, {
          provider: Option.getOrUndefined(flags.provider),
          model: Option.getOrUndefined(flags.model),
        });
        const text = resolveThreadCliMessageText(
          Option.getOrUndefined(flags.message),
          readThreadCliStdin,
        );
        const title = Option.getOrElse(flags.title, () => deriveThreadCliTitle(text));
        const threadId = ThreadId.make(yield* commandUuid);
        // The HTTP dispatch endpoint does not expand `thread.turn.start`
        // bootstraps (only the WebSocket path does), so create the thread
        // explicitly before starting its first turn.
        const createCommand: ThreadCliDispatchCommand = {
          type: "thread.create",
          commandId: CommandId.make(yield* commandUuid),
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* startThreadCliTurn({
          cli,
          threadId,
          label: title,
          previousTurnId: null,
          prepare: [createCommand],
          command: ({ commandId, messageId, createdAt }) => ({
            type: "thread.turn.start",
            commandId,
            threadId,
            message: { messageId, role: "user", text, attachments: [] },
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
          wait: flags.wait,
          follow: flags.follow,
          timeout: flags.timeout,
          json: flags.json,
        });
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("List, read, create, message, and snooze threads."),
  Command.withSubcommands([
    threadListCommand,
    threadShowCommand,
    threadSendCommand,
    threadNewCommand,
    threadSnoozeCommand,
    threadWakeCommand,
    threadStatusCommand,
  ]),
);
