import {
  AuthAdministrativeScopes,
  CommandId,
  EnvironmentHttpApi,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
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
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  type CliAuthLocationFlags,
  DurationFromString,
  projectLocationFlags,
  resolveCliAuthConfig,
} from "./config.ts";

type ThreadCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.snooze" | "thread.unsnooze" }
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

const makeClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

const requestTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(Duration.seconds(2)));

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

const runThreadCli = Effect.fn("runThreadCli")(function* <A>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationShellSnapshot;
    readonly dispatch: (
      command: ThreadCliDispatchCommand,
    ) => Effect.Effect<void, Error, HttpClient.HttpClient>;
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
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* withThreadCliSession(environmentAuth, (token) =>
      Effect.gen(function* () {
        const snapshot = yield* fetchShellSnapshot(runtimeState.value.origin, token);
        return yield* run({
          snapshot,
          dispatch: (command) => dispatchThreadCommand(runtimeState.value.origin, token, command),
        });
      }),
    ).pipe(
      Effect.catchTag(
        "ThreadCliRequestError",
        (cause) => new ThreadCliServerUnavailableError({ cause }),
      ),
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

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([threadSnoozeCommand, threadWakeCommand, threadStatusCommand]),
);
