// `zcode serve` is a user-level daemon: it owns CLI credentials, runs the agent runtime and
// exposes the channel WebSocket T3 attaches to. T3 never spawns a per-session agent and never
// reads the credential store; it only makes sure the daemon is up and asks for a host grant.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ZcodeProtocolError } from "./zcodeProtocol.ts";
import { resolveZcodeLaunchCommand, zcodeDataRoot, zcodeServeArgs } from "./zcodeRuntime.ts";

const STATUS_FILE = "status.json";
const TOKEN_FILE = "ingress-token";
const STATUS_READY = "ready";
const STARTUP_TIMEOUT = Duration.seconds(30);
const STARTUP_POLL = Duration.millis(250);

const ZcodeServerStatus = Schema.Struct({
  state: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  version: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Int),
});
export type ZcodeServerStatus = typeof ZcodeServerStatus.Type;
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(ZcodeServerStatus));

const ZcodeHostCapability = Schema.Struct({
  capability: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
});

function zcodeServerRoot(environment: NodeJS.ProcessEnv): string | undefined {
  const root = zcodeDataRoot(environment);
  return root === undefined ? undefined : `${root}/.zcode/server`;
}

const readZcodeServerStatus = Effect.fn("ZcodeServe.readStatus")(function* (
  fileSystem: FileSystem.FileSystem,
  serverRoot: string,
) {
  const raw = yield* fileSystem
    .readFileString(`${serverRoot}/run/${STATUS_FILE}`)
    .pipe(Effect.option);
  if (Option.isNone(raw)) return Option.none<ZcodeServerStatus>();
  const status = decodeStatus(raw.value);
  if (Option.isNone(status)) return Option.none<ZcodeServerStatus>();
  return status.value.state === STATUS_READY ? Option.some(status.value) : Option.none();
});

const readIngressToken = Effect.fn("ZcodeServe.readIngressToken")(function* (
  fileSystem: FileSystem.FileSystem,
  serverRoot: string,
) {
  const raw = yield* fileSystem
    .readFileString(`${serverRoot}/run/${TOKEN_FILE}`)
    .pipe(Effect.option);
  if (Option.isNone(raw)) return undefined;
  const token = raw.value.trim();
  return token.length === 0 ? undefined : token;
});

export const zcodeChannelUrl = (status: ZcodeServerStatus, token: string): string =>
  `ws://${status.host}:${status.port}/ws/host?token=${encodeURIComponent(token)}`;

const issueZcodeHostCapability = Effect.fn("ZcodeServe.issueHostCapability")(function* (
  httpClient: HttpClient.HttpClient,
  status: ZcodeServerStatus,
  token: string,
) {
  const request = HttpClientRequest.post(
    `http://${status.host}:${status.port}/api/rpc-host-capability`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const response = yield* httpClient
    .execute(request)
    .pipe(
      Effect.mapError((cause) => new ZcodeProtocolError({ operation: "hostCapability", cause })),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new ZcodeProtocolError({
      operation: "hostCapability",
      detail: `zcode server refused the host grant (HTTP ${response.status})`,
    });
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ZcodeHostCapability)(response).pipe(
    Effect.mapError((cause) => new ZcodeProtocolError({ operation: "hostCapability", cause })),
  );
  return body.capability;
});

const spawnZcodeServer = Effect.fn("ZcodeServe.spawn")(function* (input: {
  readonly launchCommand: string;
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const command = yield* resolveSpawnCommand(
    input.launchCommand,
    zcodeServeArgs(input.launchArgs),
    {
      env: input.environment,
    },
  ).pipe(Effect.mapError((cause) => new ZcodeProtocolError({ operation: "serve", cause })));
  // `serve` forks the supervisor and exits, so the handle belongs to a detached fiber: the
  // daemon outlives this agent scope and must never be reaped by it.
  yield* Effect.forkDetach(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command.command, command.args, {
              env: input.environment,
              extendEnv: false,
              shell: command.shell,
              detached: platform !== "win32",
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(Effect.mapError((cause) => new ZcodeProtocolError({ operation: "serve", cause })));
        yield* child.exitCode.pipe(Effect.ignore);
      }),
    ),
  );
});

/** Attaches to the running daemon, starting it when this machine has none. */
const ensureZcodeServer = Effect.fn("ZcodeServe.ensure")(function* (input: {
  readonly settings: { readonly binaryPath: string; readonly launchArgs: string };
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const serverRoot = zcodeServerRoot(input.environment);
  if (serverRoot === undefined) {
    return yield* new ZcodeProtocolError({
      operation: "serve",
      detail: "ZCode has no data directory to host a server.",
    });
  }
  const running = yield* readZcodeServerStatus(input.fileSystem, serverRoot);
  if (Option.isSome(running)) return { serverRoot, status: running.value };

  const launchCommand = yield* resolveZcodeLaunchCommand(
    input.settings,
    input.environment,
    input.fileSystem,
  ).pipe(Effect.mapError((cause) => new ZcodeProtocolError({ operation: "serve", cause })));
  yield* spawnZcodeServer({
    launchCommand,
    launchArgs: input.settings.launchArgs,
    environment: input.environment,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("ZCode server did not start.", { operation: error.operation }),
    ),
  );

  const started = yield* Effect.gen(function* () {
    for (;;) {
      const status = yield* readZcodeServerStatus(input.fileSystem, serverRoot);
      if (Option.isSome(status)) return status.value;
      yield* Effect.sleep(STARTUP_POLL);
    }
  }).pipe(Effect.timeoutOption(STARTUP_TIMEOUT));

  if (Option.isNone(started)) {
    return yield* new ZcodeProtocolError({
      operation: "serve",
      detail: "zcode serve did not report a ready daemon.",
    });
  }
  return { serverRoot, status: started.value };
});

export interface ZcodeServerConnectionInfo {
  readonly serverRoot: string;
  readonly status: ZcodeServerStatus;
  readonly token: string;
  readonly capability: string;
}

export const connectZcodeServer = Effect.fn("ZcodeServe.connect")(function* (input: {
  readonly settings: { readonly binaryPath: string; readonly launchArgs: string };
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly httpClient: HttpClient.HttpClient;
}) {
  const { serverRoot, status } = yield* ensureZcodeServer(input);
  const token = yield* readIngressToken(input.fileSystem, serverRoot);
  if (token === undefined) {
    return yield* new ZcodeProtocolError({
      operation: "serve",
      detail: "zcode server has no ingress token.",
    });
  }
  const capability = yield* issueZcodeHostCapability(input.httpClient, status, token);
  return { serverRoot, status, token, capability } satisfies ZcodeServerConnectionInfo;
});
