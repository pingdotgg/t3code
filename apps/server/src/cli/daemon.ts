import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type Daemon,
  DaemonId,
  type DaemonUpsertInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { type DaemonRpcClient, daemonRpcSession } from "./daemonRpc.ts";

export class DaemonCliError extends Schema.TaggedError<DaemonCliError>()("DaemonCliError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const isDaemonCliError = Schema.is(DaemonCliError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

const failureDetail = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

/** Signs in as a short-lived client of the running server and revokes it when the command ends. */
const withDaemonClient = Effect.fn("cli.daemon.withClient")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  run: (client: DaemonRpcClient) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
  const minimumLogLevel = flags.json ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new DaemonCliError({
        detail: `No running T3 Code server uses ${config.baseDir}. Start T3 Code, then retry.`,
      });
    }
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueSession({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        label: "t3 daemon cli",
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const client = yield* daemonRpcSession({
      origin: runtimeState.value.origin,
      token: issued.token,
    });
    return yield* run(client).pipe(
      Effect.mapError((error) =>
        isDaemonCliError(error) ? error : new DaemonCliError({ detail: failureDetail(error) }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

/** These are expected outcomes for a script, so they print as one line instead of a stack trace. */
const reportDaemonErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isDaemonCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const listDaemons = (client: DaemonRpcClient) =>
  client["daemons.subscribe"]({}).pipe(
    Stream.runHead,
    Effect.map(Option.match({ onNone: () => [], onSome: (result) => result.daemons })),
  );

const formatDaemon = (daemon: Daemon) =>
  `${daemon.id}  ${(daemon.enabled ? daemon.status.state : "disabled").padEnd(10)}  ${daemon.name}  (${daemon.cwd})  ${daemon.command}`;

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const decodeDaemonId = Schema.decodeUnknownEffect(DaemonId);
const parseDaemonId = (value: string) =>
  decodeDaemonId(value.trim()).pipe(
    Effect.mapError(() => new DaemonCliError({ detail: `'${value}' is not a daemon id.` })),
  );

const daemonListCommand = Command.make("list", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List the server's daemons and whether each is running."),
  Command.withHandler((flags) =>
    withDaemonClient(
      flags,
      Effect.fn("cli.daemon.list")(function* (client) {
        const daemons = yield* listDaemons(client);
        if (flags.json) return yield* printJson(daemons);
        if (daemons.length === 0) return yield* Console.log("No daemons.");
        for (const daemon of daemons) yield* Console.log(formatDaemon(daemon));
      }),
    ).pipe(reportDaemonErrors),
  ),
);

/** The RPC payload `t3 daemon add` sends. */
const daemonUpsertInput = Effect.fn("cli.daemon.upsertInput")(function* (flags: {
  readonly id: Option.Option<string>;
  readonly name: string;
  readonly command: string;
  readonly cwd: Option.Option<string>;
  readonly disabled: boolean;
}) {
  const path = yield* Path.Path;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const cwd = Option.isSome(flags.cwd)
    ? path.resolve(workingDirectory, yield* expandHomePath(flags.cwd.value))
    : workingDirectory;
  const id = Option.isSome(flags.id) ? yield* parseDaemonId(flags.id.value) : undefined;
  const name = flags.name.trim();
  const command = flags.command.trim();
  if (name.length === 0 || command.length === 0) {
    return yield* new DaemonCliError({ detail: "--name and --command must not be empty." });
  }
  return {
    ...(id === undefined ? {} : { id }),
    name,
    command,
    cwd,
    enabled: !flags.disabled,
  } satisfies DaemonUpsertInput;
});

const daemonAddCommand = Command.make("add", {
  ...projectLocationFlags,
  name: Flag.String("name").pipe(Flag.withDescription("Name shown in Settings.")),
  command: Flag.String("command").pipe(
    Flag.withDescription("Shell command the daemon runs; it restarts when it exits."),
  ),
  cwd: Flag.String("cwd").pipe(
    Flag.withDescription("Directory the command runs in. Defaults to this directory."),
    Flag.optional,
  ),
  id: Flag.String("id").pipe(
    Flag.withDescription("Replace the daemon with this id instead of adding one."),
    Flag.optional,
  ),
  disabled: Flag.Boolean("disabled").pipe(
    Flag.withDescription("Save the daemon without starting it."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Add a daemon, or replace one with --id, and print its id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* daemonUpsertInput(flags);
      yield* withDaemonClient(
        flags,
        Effect.fn("cli.daemon.add")(function* (client) {
          const { daemon } = yield* client["daemons.upsert"](input);
          yield* flags.json ? printJson(daemon) : Console.log(daemon.id);
        }),
      );
    }).pipe(reportDaemonErrors),
  ),
);

const daemonRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Daemon id, from `t3 daemon list`.")),
}).pipe(
  Command.withDescription("Stop a daemon and remove it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const id = yield* parseDaemonId(flags.id);
      yield* withDaemonClient(
        { ...flags, json: false },
        Effect.fn("cli.daemon.remove")(function* (client) {
          yield* client["daemons.delete"]({ id });
          yield* Console.log(`Removed daemon ${id}.`);
        }),
      );
    }).pipe(reportDaemonErrors),
  ),
);

export const daemonCommand = Command.make("daemon").pipe(
  Command.withDescription("List, add, and remove the running server's daemons."),
  Command.withSubcommands([daemonListCommand, daemonAddCommand, daemonRemoveCommand]),
);
