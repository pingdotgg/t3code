import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { EmbeddedDriverConnection, EmbeddedDriverExit } from "@trycua/cua-driver/embedded";

export const T3CODE_CUA_DRIVER_PATH_ENV = "T3CODE_CUA_DRIVER_PATH";
export const T3CODE_CUA_DRIVER_HOST_BUNDLE_ID_ENV = "T3CODE_CUA_DRIVER_HOST_BUNDLE_ID";
export const T3CODE_CUA_DRIVER_MODULE_URL_ENV = "T3CODE_CUA_DRIVER_MODULE_URL";
export const T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV = "T3CODE_CODEX_APPEND_LAUNCH_ARGS";

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

export const installCodexLaunchArgs = Effect.fn("server.installCodexLaunchArgs")(function* (
  launchArgs: string,
) {
  const previous = process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV];
  let active = true;
  const deactivate = Effect.sync(() => {
    if (!active) return false;
    active = false;
    if (previous === undefined) delete process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV];
    else process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV] = previous;
    return true;
  });
  yield* Effect.addFinalizer(() => deactivate.pipe(Effect.asVoid));
  process.env[T3CODE_CODEX_APPEND_LAUNCH_ARGS_ENV] = [previous?.trim() ?? "", launchArgs]
    .filter((value) => value.length > 0)
    .join(" ");
  return () => deactivate;
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

  const disableCua = yield* installCodexLaunchArgs(buildCodexLaunchArgs(connection));
  yield* monitorEmbeddedCuaDriverExit(
    () => driver.waitForExit(connection.generation),
    (exit) =>
      disableCua().pipe(
        Effect.flatMap((disabled) =>
          disabled
            ? Effect.logWarning("embedded cua-driver exited; computer use is unavailable", {
                component: "embedded-cua-driver",
                generation: exit.generation,
                code: exit.code,
                success: exit.success,
              })
            : Effect.void,
        ),
      ),
  ).pipe(Effect.forkScoped);

  yield* Effect.logInfo("embedded cua-driver ready", {
    component: "embedded-cua-driver",
    pid: connection.pid,
    socketPath: connection.socketPath,
  });
});
