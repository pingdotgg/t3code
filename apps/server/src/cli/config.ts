import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Flag } from "effect/unstable/cli";

import { deriveServerPaths, ensureServerDirectories, type ServerConfigShape } from "../config.ts";

const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to T3CODE_HOME)."),
  Flag.optional,
);

export const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const cwd = process.cwd();
    const baseDir = path.resolve(Option.getOrElse(flags.baseDir, () => ".t3code"));
    const devUrl = flags.devUrl ? Option.getOrUndefined(flags.devUrl) : undefined;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const serverTracePath = derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });

    return {
      logLevel: Option.getOrElse(cliLogLevel, () => "Info"),
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host: undefined,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      startupPresentation: "headless",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
    } satisfies ServerConfigShape;
  });
