import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { EmbeddedDriverConnection, EmbeddedDriverExit } from "@trycua/cua-driver/embedded";

export const T3CODE_CUA_DRIVER_PATH_ENV = "T3CODE_CUA_DRIVER_PATH";
export const T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV = "T3CODE_CUA_DRIVER_HOST_BUNDLE_ID";
export const T3CODE_CUA_DRIVER_MODULE_URL_ENV = "T3CODE_CUA_DRIVER_MODULE_URL";
export const T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV = "T3CODE_CODEX_APPEND_LAUNCH_ARGS";
export const T3CODE_CODEX_APPEND_THREAD_CONFIG_ENV = "T3CODE_CODEX_APPEND_THREAD_CONFIG";

export class CuaDriverStartError extends Schema.TaggedErrorClass<CuaDriverStartError>()(
  "CuaDriverStartError",
  {
    binaryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start embedded cua-driver at '${this.binaryPath}'.`;
  }
}

const tomlString = (value: string): string => JSON.stringify(value);

const recordOrEmpty = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

export const buildCodexThreadConfig = (
  connection: Pick<EmbeddedDriverConnection, "mcp">,
  previousConfig?: string,
): string => {
  let existing: Readonly<Record<string, unknown>> = {};
  if (previousConfig?.trim()) {
    try {
      existing = recordOrEmpty(JSON.parse(previousConfig));
    } catch {
      existing = {};
    }
  }
  const existingMcpServers = recordOrEmpty(existing.mcp_servers);
  return JSON.stringify({
    ...existing,
    mcp_servers: {
      ...existingMcpServers,
      "cua-driver": {
        command: connection.mcp.command,
        args: connection.mcp.args,
        env: Object.fromEntries(
          connection.mcp.environment.map(({ name, value }) => [name, value] as const),
        ),
      },
    },
  });
};

export const buildCodexLaunchArgs = (connection: Pick<EmbeddedDriverConnection, "mcp">): string => {
  const proxyArgs = connection.mcp.args.map(tomlString).join(",");
  const proxyEnv = connection.mcp.environment
    .map(({ name, value }) => `${name}=${tomlString(value)}`)
    .join(",");
  return [
    "-c",
    tomlString(`mcp_servers.cua-driver.command=${tomlString(connection.mcp.command)}`),
    "-c",
    tomlString(`mcp_servers.cua-driver.args=[${proxyArgs}]`),
    "-c",
    tomlString(`mcp_servers.cua-driver.env={${proxyEnv}}`),
  ].join(" ");
};

const importEmbeddedCuaDriver = (
  moduleUrl?: string,
): Promise<typeof import("@trycua/cua-driver/embedded")> =>
  moduleUrl === undefined ? import("@trycua/cua-driver/embedded") : import(moduleUrl);

export const monitorEmbeddedCuaDriverExit = Effect.fn("server.monitorEmbeddedCuaDriverExit")(
  function* (
    waitForExit: () => Promise<EmbeddedDriverExit>,
    onUnexpectedExit: (exit: EmbeddedDriverExit) => Effect.Effect<void>,
  ) {
    const exit = yield* Effect.tryPromise(waitForExit);
    yield* onUnexpectedExit(exit);
  },
  Effect.catch((cause) => Effect.logWarning("embedded cua-driver exit monitor failed", { cause })),
);

const restartServerAfterCuaDriverExit = Effect.fn("server.restartAfterCuaDriverExit")(function* (
  exit: EmbeddedDriverExit,
) {
  yield* Effect.logError("embedded cua-driver exited unexpectedly; restarting server", {
    component: "embedded-cua-driver",
    generation: exit.generation,
    code: exit.code,
    success: exit.success,
  });
  yield* Effect.sync(() => {
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
});

/**
 * Starts a server-private driver when T3CODE_CUA_DRIVER_PATH is configured.
 * The scoped finalizer owns both the native host and its child process.
 */
export const startEmbeddedCuaDriver = Effect.fn("server.startEmbeddedCuaDriver")(function* () {
  const binaryPath = process.env[T3CODE_CUA_DRIVER_PATH_ENV]?.trim();
  if (!binaryPath) return;

  const hostBundleId = process.env[T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV]?.trim() || "t3-server";
  const moduleUrl = process.env[T3CODE_CUA_DRIVER_MODULE_URL_ENV]?.trim() || undefined;
  const { EmbeddedCuaDriverHost } = yield* Effect.tryPromise({
    try: () => importEmbeddedCuaDriver(moduleUrl),
    catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
  });
  const driver = yield* Effect.try({
    try: () => new EmbeddedCuaDriverHost(binaryPath, hostBundleId),
    catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
  });
  yield* Effect.addFinalizer(() =>
    Effect.tryPromise(() => driver.stop()).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => driver.uniffiDestroy()).pipe(Effect.catchCause(() => Effect.void)),
      ),
    ),
  );

  const connection = yield* Effect.tryPromise({
    try: () => driver.start(),
    catch: (cause) => new CuaDriverStartError({ binaryPath, cause }),
  });

  const previousAppendArgs = process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV];
  const previousThreadConfig = process.env[T3CODE_CODEX_APPEND_THREAD_CONFIG_ENV];
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (previousAppendArgs === undefined) delete process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV];
      else process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV] = previousAppendArgs;
      if (previousThreadConfig === undefined)
        delete process.env[T3CODE_CODEX_APPEND_THREAD_CONFIG_ENV];
      else process.env[T3CODE_CODEX_APPEND_THREAD_CONFIG_ENV] = previousThreadConfig;
    }),
  );
  process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV] = [
    previousAppendArgs?.trim() ?? "",
    buildCodexLaunchArgs(connection),
  ]
    .filter((value) => value.length > 0)
    .join(" ");
  process.env[T3CODE_CODEX_APPEND_THREAD_CONFIG_ENV] = buildCodexThreadConfig(
    connection,
    previousThreadConfig,
  );

  yield* monitorEmbeddedCuaDriverExit(
    () => driver.waitForExit(connection.generation),
    restartServerAfterCuaDriverExit,
  ).pipe(Effect.forkScoped);

  yield* Effect.logInfo("embedded cua-driver ready", {
    component: "embedded-cua-driver",
    pid: connection.pid,
    socketPath: connection.socketPath,
  });
});
