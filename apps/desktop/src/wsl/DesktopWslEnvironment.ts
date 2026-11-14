import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildRemoteNodeEnvScript } from "@t3tools/ssh/tunnel";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import { parseWslDistroList, type WslDistro } from "./wslPathParsing.ts";
import {
  buildDistroArgs,
  getDistroIpImpl,
  getUserHomeImpl,
  preWarmImpl,
  windowsToWslPathImpl,
  buildWslNodeEnvPreamble,
  concatChunks,
  decodeUtf8,
  formatWslShellTransportFailureReason,
  runWslShell,
  shellQuote,
  TIMEOUT_RESULT,
  type ShellResult,
} from "./wslShell.ts";
import {
  buildWslRuntimeInstallScript,
  buildWslRuntimeInvalidateScript,
  buildWslRuntimeProbeScript,
  buildWslRuntimePruneScript,
  formatMissingToolsReason,
  formatNodePtyProbeFailureReason,
  NODE_PTY_BINARY_MISSING_EXIT_CODE,
  NODE_PTY_BUILD_SCRIPT,
  NODE_PTY_PROBE_SCRIPT,
  ORPHANED_RUNTIME_SCRATCH_MAX_AGE_MINUTES,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  parseToolchainReport,
  parseWslRuntimeRoot,
  RESOLVED_PATH_LINE,
  sanitizeWslRuntimeId,
  TOOLCHAIN_CHECK_SCRIPT,
  WSL_RUNTIME_SELECTED_MARKER,
  WSL_RUNTIME_SELECTION_GRACE_MINUTES,
  type ToolchainReport,
} from "./wslRuntimeScripts.ts";

export {
  buildWslRuntimeInstallScript,
  buildWslRuntimeInvalidateScript,
  buildWslRuntimeProbeScript,
  buildWslRuntimePruneScript,
  parseResolvedPath,
  parseWslRuntimeRoot,
} from "./wslRuntimeScripts.ts";

const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const LIST_TIMEOUT = Duration.seconds(8);
// Booting a stopped distro needs more time than converting paths in a running one.
const PRE_WARM_TIMEOUT = Duration.seconds(30);
const WSLPATH_TIMEOUT = Duration.seconds(10);
const PROBE_TIMEOUT = Duration.seconds(10);
const TOOLCHAIN_TIMEOUT = Duration.seconds(10);
const BUILD_TIMEOUT = Duration.minutes(5);
const RUNTIME_INSTALL_TIMEOUT = Duration.minutes(2);
const RUNTIME_PRUNE_TIMEOUT = Duration.seconds(30);
const RUNTIME_INVALIDATE_TIMEOUT = Duration.seconds(15);
const USER_HOME_TIMEOUT = Duration.seconds(5);
const TOOLCHAIN_TRANSPORT_RETRY_LIMIT = 12;
const BUILD_TRANSPORT_RETRY_LIMIT = 2;

export interface EnsureWslNodePtyOptions {
  readonly allowBuild?: boolean;
  readonly nodeEngineRange?: string | null;
}

export interface WslRuntimeArchive {
  readonly windowsPath: string;
  readonly runtimeId: string;
  readonly sha256: string;
}

export type PrepareWslRuntimeResult =
  | {
      readonly ok: true;
      readonly linuxAppRoot: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type EnsureWslNodePtyResult =
  | {
      readonly ok: true;
      readonly nodePath: string;
      readonly resolvedPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly fatal: boolean;
      readonly retryLimit?: number;
    };

export type ProbeWslRuntimeResult =
  | {
      readonly ok: true;
      readonly resolvedPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export class DesktopWslDistroListError extends Schema.TaggedError<DesktopWslDistroListError>()(
  "DesktopWslDistroListError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isDesktopWslDistroListError = Schema.is(DesktopWslDistroListError);

export class DesktopWslEnvironment extends Context.Service<
  DesktopWslEnvironment,
  {
    readonly isAvailable: Effect.Effect<boolean>;
    // UX-only best effort; health checks need probeDistros to distinguish failures from an empty installation.
    readonly listDistros: Effect.Effect<readonly WslDistro[]>;
    readonly probeDistros: Effect.Effect<readonly WslDistro[], DesktopWslDistroListError>;
    readonly preWarm: (distro: string | null) => Effect.Effect<void>;
    readonly windowsToWslPath: (
      distro: string | null,
      windowsPath: string,
    ) => Effect.Effect<Option.Option<string>>;
    readonly getUserHome: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    // Use the distro IP to avoid unreliable wslhost localhost forwarding.
    readonly getDistroIp: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    readonly prepareRuntime: (
      distro: string | null,
      archive: WslRuntimeArchive,
    ) => Effect.Effect<PrepareWslRuntimeResult>;
    readonly pruneRuntimes: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
    readonly invalidateRuntime: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
    readonly probeRuntime: (
      distro: string | null,
      linuxAppRoot: string,
    ) => Effect.Effect<ProbeWslRuntimeResult>;
    readonly ensureNodePty: (
      distro: string | null,
      linuxAppRoot: string,
      options?: EnsureWslNodePtyOptions,
    ) => Effect.Effect<EnsureWslNodePtyResult>;
  }
>()("@t3tools/desktop/wsl/DesktopWslEnvironment") {}

const probeWslRuntimeImpl = Effect.fn("DesktopWslEnvironment.probeWslRuntimeImpl")(function* (
  distro: string | null,
  linuxAppRoot: string,
): Effect.fn.Return<ProbeWslRuntimeResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const probe = yield* runWslShell(
    distro,
    buildWslRuntimeProbeScript(linuxAppRoot),
    PROBE_TIMEOUT,
    {
      resolveNode: false,
    },
  );
  const transportFailureReason = formatWslShellTransportFailureReason(
    probe.transportFailure,
    "the staged runtime",
  );
  if (transportFailureReason !== null) {
    return { ok: false, reason: transportFailureReason } as const;
  }
  if (probe.exitCode !== 0) {
    const trimmedTail = probe.stderr.trim().slice(-500);
    return {
      ok: false,
      reason: `${linuxAppRoot}/t3 --version failed (exit ${probe.exitCode})${trimmedTail ? `: ${trimmedTail}` : ""}`,
    } as const;
  }
  const resolvedPath = parseResolvedPath(probe.stdout);
  if (resolvedPath === null) {
    return {
      ok: false,
      reason: "WSL login-shell PATH could not be resolved during backend preflight.",
    } as const;
  }
  return { ok: true, resolvedPath } as const;
});

const ensureNodePtyImpl = Effect.fn("DesktopWslEnvironment.ensureNodePtyImpl")(function* (
  distro: string | null,
  linuxRepoRoot: string,
  options: EnsureWslNodePtyOptions = {},
): Effect.fn.Return<EnsureWslNodePtyResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  // node-pty lives in the apps/server workspace's node_modules; resolve from
  // there rather than the monorepo root, where Bun's hoist layout omits it.
  const linuxServerDir = `${linuxRepoRoot}/apps/server`;

  const probe = yield* runWslShell(
    distro,
    NODE_PTY_PROBE_SCRIPT(linuxServerDir),
    PROBE_TIMEOUT,
    options,
  );
  const nodePath = parseNodePath(probe.stdout);
  const resolvedPath = parseResolvedPath(probe.stdout);

  const transportFailureReason = formatWslShellTransportFailureReason(probe.transportFailure);
  if (transportFailureReason !== null) {
    return {
      ok: false,
      reason: transportFailureReason,
      fatal: false,
    } as const;
  }

  if (nodePath === null) {
    const toolchainCheck = yield* runWslShell(
      distro,
      TOOLCHAIN_CHECK_SCRIPT,
      TOOLCHAIN_TIMEOUT,
      options,
    );
    const toolchainTransportFailure = formatWslShellTransportFailureReason(
      toolchainCheck.transportFailure,
    );
    if (toolchainTransportFailure !== null) {
      return {
        ok: false,
        reason: toolchainTransportFailure,
        fatal: false,
        retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
      } as const;
    }
    const report = parseToolchainReport(toolchainCheck.stdout);
    const reason =
      formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null) ??
      "Node.js was not found in the WSL distro. Install it (e.g. via nvm) and restart the desktop app.";
    return { ok: false, reason, fatal: true } as const;
  }

  if (resolvedPath === null) {
    return {
      ok: false,
      reason: "WSL login-shell PATH could not be resolved during backend preflight.",
      fatal: true,
    } as const;
  }

  if (probe.exitCode === 3) {
    return {
      ok: false,
      reason:
        'WSL server dependencies could not be loaded (for example "node-pty"). The native packages the server needs are not unpacked where the WSL distro\'s Node can read them. This is a packaging problem with this build. Please report it.',
      fatal: true,
    } as const;
  }

  if (probe.exitCode === 0) {
    const rawVersion = parseNodeVersion(probe.stdout);
    if (
      rawVersion !== null &&
      options.nodeEngineRange &&
      !satisfiesSemverRange(rawVersion, options.nodeEngineRange.trim())
    ) {
      const range = options.nodeEngineRange.trim();
      return {
        ok: false,
        reason: `WSL Node.js ${rawVersion} does not satisfy the server's required engine range (${range}). Install a compatible version, and restart the desktop app.`,
        fatal: true,
      } as const;
    }
    return { ok: true, nodePath, resolvedPath } as const;
  }

  if (options.allowBuild !== true) {
    const packagedProbeFailure = formatNodePtyProbeFailureReason(probe.exitCode);
    if (packagedProbeFailure !== null) {
      return {
        ok: false,
        reason: packagedProbeFailure,
        fatal: true,
      } as const;
    }
  }

  const toolchainCheck = yield* runWslShell(
    distro,
    TOOLCHAIN_CHECK_SCRIPT,
    TOOLCHAIN_TIMEOUT,
    options,
  );
  const toolchainTransportFailure = formatWslShellTransportFailureReason(
    toolchainCheck.transportFailure,
  );
  if (toolchainTransportFailure !== null) {
    return {
      ok: false,
      reason: toolchainTransportFailure,
      fatal: false,
      retryLimit: TOOLCHAIN_TRANSPORT_RETRY_LIMIT,
    } as const;
  }
  const report = parseToolchainReport(toolchainCheck.stdout);

  if (options.allowBuild !== true) {
    // Packaged builds ship a prebuilt Linux node-pty, so no compiler, node-gyp,
    // or network is needed — and we must not nag the user to install build
    // tools they don't need.
    const nodeOnlyReason = formatMissingToolsReason(
      {
        missingTools: report.missingTools.filter((tool) => tool === "node"),
        nodeVersion: report.nodeVersion,
      },
      options.nodeEngineRange?.trim() || null,
    );
    return {
      ok: false,
      reason:
        nodeOnlyReason ??
        "The bundled WSL backend binary (node-pty) could not be loaded in this distro. This usually means an unsupported CPU architecture or incompatible system libraries (glibc). Use a glibc-based x64/arm64 WSL distro such as Ubuntu; if you already are, please report this with your distro and the output of `uname -m`.",
      fatal: true,
    } as const;
  }

  const missingReason = formatMissingToolsReason(report, options.nodeEngineRange?.trim() || null);
  if (missingReason !== null) {
    return { ok: false, reason: missingReason, fatal: true } as const;
  }

  const build = yield* runWslShell(
    distro,
    NODE_PTY_BUILD_SCRIPT(linuxServerDir),
    BUILD_TIMEOUT,
    options,
  );
  const buildTransportFailure = formatWslShellTransportFailureReason(build.transportFailure);
  if (buildTransportFailure !== null) {
    return {
      ok: false,
      reason: buildTransportFailure,
      fatal: false,
      retryLimit: BUILD_TRANSPORT_RETRY_LIMIT,
    } as const;
  }
  if (build.exitCode === 0) return { ok: true, nodePath, resolvedPath } as const;
  const trimmedTail = `${build.stdout}${build.stderr}`.trim().slice(-500);
  return {
    ok: false,
    reason: `node-pty Linux build failed (exit ${build.exitCode}): ${trimmedTail || "no stderr captured"}`,
    fatal: true,
  } as const;
});

const prepareWslRuntimeImpl = Effect.fn("desktop.wsl.prepareRuntimeImpl")(function* (
  distro: string | null,
  archive: WslRuntimeArchive,
  windowsToWslPath: (
    distro: string | null,
    windowsPath: string,
  ) => Effect.Effect<Option.Option<string>>,
): Effect.fn.Return<PrepareWslRuntimeResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const linuxArchivePath = yield* windowsToWslPath(distro, archive.windowsPath);
  if (Option.isNone(linuxArchivePath)) {
    return {
      ok: false,
      reason: `wslpath conversion failed for ${archive.windowsPath}`,
    } as const;
  }

  const install = yield* runWslShell(
    distro,
    buildWslRuntimeInstallScript(linuxArchivePath.value, archive.runtimeId, archive.sha256),
    RUNTIME_INSTALL_TIMEOUT,
    { resolveNode: false },
  );
  if (install.transportFailure !== null) {
    return {
      ok: false,
      reason:
        install.transportFailure === "timeout"
          ? "WSL runtime installation timed out. Check that the distro has free disk space, then retry."
          : "WSL runtime installation lost communication with wsl.exe. Retry, or check that the distro is healthy.",
    } as const;
  }
  if (install.exitCode !== 0) {
    const trimmedTail = `${install.stdout}${install.stderr}`.trim().slice(-500);
    return {
      ok: false,
      reason: `WSL runtime installation failed (exit ${install.exitCode}): ${trimmedTail || "no stderr captured"}`,
    } as const;
  }

  const linuxAppRoot = parseWslRuntimeRoot(install.stdout);
  return linuxAppRoot === null
    ? {
        ok: false,
        reason: "WSL runtime installation completed without reporting its cache path.",
      }
    : { ok: true, linuxAppRoot };
});

const pruneWslRuntimesImpl = Effect.fn("desktop.wsl.pruneRuntimesImpl")(function* (
  distro: string | null,
  runtimeId: string,
): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runWslShell(
    distro,
    buildWslRuntimePruneScript(runtimeId),
    RUNTIME_PRUNE_TIMEOUT,
    { resolveNode: false },
  );
  if (result.transportFailure === null && result.exitCode === 0) return;

  const detail = `${result.stdout}${result.stderr}`.trim().slice(-500);
  yield* Effect.logWarning("Could not prune old WSL runtime caches.", {
    distro,
    runtimeId,
    detail: detail || `exit ${result.exitCode}`,
  });
});

const invalidateWslRuntimeImpl = Effect.fn("desktop.wsl.invalidateRuntimeImpl")(function* (
  distro: string | null,
  runtimeId: string,
): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runWslShell(
    distro,
    buildWslRuntimeInvalidateScript(runtimeId),
    RUNTIME_INVALIDATE_TIMEOUT,
    { resolveNode: false },
  );
  if (result.transportFailure === null && result.exitCode === 0) return;

  const detail = `${result.stdout}${result.stderr}`.trim().slice(-500);
  yield* Effect.logWarning("Could not invalidate the staged WSL runtime cache.", {
    distro,
    runtimeId,
    detail: detail || `exit ${result.exitCode}`,
  });
});

const probeWslDistros: Effect.Effect<
  readonly WslDistro[],
  DesktopWslDistroListError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("wsl.exe", ["--list", "--verbose"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    });
    const handle = yield* spawner.spawn(command);
    const stdoutBytes = yield* Stream.runCollect(handle.stdout);
    const exitCode = yield* handle.exitCode;
    if ((exitCode as unknown as number) !== 0) {
      return yield* new DesktopWslDistroListError({
        reason: `wsl.exe --list --verbose exited with code ${String(exitCode)}`,
      });
    }
    return parseWslDistroList(Buffer.from(concatChunks(stdoutBytes)));
  }),
).pipe(
  Effect.mapError((error) =>
    isDesktopWslDistroListError(error)
      ? error
      : new DesktopWslDistroListError({
          reason: `Failed to run wsl.exe --list --verbose: ${error.message}`,
        }),
  ),
  Effect.timeoutOption(LIST_TIMEOUT),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new DesktopWslDistroListError({
          reason: "wsl.exe --list --verbose timed out",
        }),
      onSome: Effect.succeed,
    }),
  ),
);

export const makeIsAvailable = Effect.fn("DesktopWslEnvironment.makeIsAvailable")(function* (
  platform: NodeJS.Platform,
  windir: string,
): Effect.fn.Return<
  boolean,
  never,
  FileSystem.FileSystem | Path.Path | DesktopManagedPolicy.DesktopManagedPolicy
> {
  if (platform !== "win32") return false;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const wslExePath = path.join(windir, "System32", "wsl.exe");
  if (!(yield* fileSystem.exists(wslExePath).pipe(Effect.orElseSucceed(() => false)))) {
    return false;
  }
  // A server in WSL reads Linux's policy, never this machine's, so a managed machine runs none.
  return yield* (yield* DesktopManagedPolicy.DesktopManagedPolicy).read.pipe(
    Effect.map((found) => found === undefined),
    Effect.orElseSucceed(() => false),
  );
});

export interface DesktopWslEnvironmentTestStub {
  readonly isAvailable?: boolean;
  readonly distros?: ReadonlyArray<WslDistro>;
  readonly distroListError?: DesktopWslDistroListError;
  readonly windowsToWslPath?: (distro: string | null, windowsPath: string) => Option.Option<string>;
  readonly getUserHome?: (distro: string | null) => Option.Option<string>;
  readonly getDistroIp?: (distro: string | null) => Option.Option<string>;
  readonly prepareRuntime?: (
    distro: string | null,
    archive: WslRuntimeArchive,
  ) => PrepareWslRuntimeResult;
  readonly pruneRuntimes?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
  readonly invalidateRuntime?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
  readonly probeRuntime?: (distro: string | null, linuxAppRoot: string) => ProbeWslRuntimeResult;
  readonly ensureNodePty?: (
    distro: string | null,
    linuxAppRoot: string,
    options?: EnsureWslNodePtyOptions,
  ) => EnsureWslNodePtyResult;
}

export const layerTest = (stub: DesktopWslEnvironmentTestStub = {}) => {
  const probeDistros: Effect.Effect<readonly WslDistro[], DesktopWslDistroListError> =
    stub.distroListError ? Effect.fail(stub.distroListError) : Effect.succeed(stub.distros ?? []);
  return Layer.succeed(
    DesktopWslEnvironment,
    DesktopWslEnvironment.of({
      isAvailable: Effect.succeed(stub.isAvailable ?? false),
      listDistros: probeDistros.pipe(Effect.orElseSucceed(() => [])),
      probeDistros,
      preWarm: Effect.fn("DesktopWslEnvironment.preWarm")(function () {
        return Effect.void;
      }),
      windowsToWslPath: Effect.fn("DesktopWslEnvironment.windowsToWslPath")(
        function (distro, windowsPath) {
          return Effect.succeed(stub.windowsToWslPath?.(distro, windowsPath) ?? Option.none());
        },
      ),
      getUserHome: Effect.fn("DesktopWslEnvironment.getUserHome")(function (distro) {
        return Effect.succeed(stub.getUserHome?.(distro) ?? Option.none<string>());
      }),
      getDistroIp: Effect.fn("DesktopWslEnvironment.getDistroIp")(function (distro) {
        return Effect.succeed(stub.getDistroIp?.(distro) ?? Option.none<string>());
      }),
      prepareRuntime: Effect.fn("DesktopWslEnvironment.prepareRuntime")(function (distro, archive) {
        return Effect.succeed(
          stub.prepareRuntime?.(distro, archive) ?? {
            ok: false,
            reason: "prepareRuntime stub not configured",
          },
        );
      }),
      pruneRuntimes: Effect.fn("DesktopWslEnvironment.pruneRuntimes")(function (distro, runtimeId) {
        return stub.pruneRuntimes?.(distro, runtimeId) ?? Effect.void;
      }),
      invalidateRuntime: Effect.fn("DesktopWslEnvironment.invalidateRuntime")(
        function (distro, runtimeId) {
          return stub.invalidateRuntime?.(distro, runtimeId) ?? Effect.void;
        },
      ),
      probeRuntime: Effect.fn("DesktopWslEnvironment.probeRuntime")(
        function (distro, linuxAppRoot) {
          return Effect.succeed(
            stub.probeRuntime?.(distro, linuxAppRoot) ?? {
              ok: true,
              resolvedPath: "/usr/bin:/bin",
            },
          );
        },
      ),
      ensureNodePty: Effect.fn("DesktopWslEnvironment.ensureNodePty")(
        function (distro, linuxAppRoot, options) {
          return Effect.succeed(
            stub.ensureNodePty?.(distro, linuxAppRoot, options) ?? {
              ok: false,
              reason: "ensureNodePty stub not configured",
              fatal: true,
            },
          );
        },
      ),
    }),
  );
};

export const layer = Layer.effect(
  DesktopWslEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const windir = process.env.WINDIR ?? "C:\\Windows";

    const provideSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    // Cache availability so synchronous IPC bootstrap can read it without yielding to filesystem I/O.
    const wslAvailable = yield* makeIsAvailable(environment.platform, windir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, environment.path),
      Effect.provideService(
        DesktopManagedPolicy.DesktopManagedPolicy,
        yield* DesktopManagedPolicy.DesktopManagedPolicy,
      ),
      Effect.withSpan("desktop.wsl.isAvailable"),
    );
    const isAvailable = Effect.succeed(wslAvailable);

    const windowsToWslPath = (distro: string | null, windowsPath: string) =>
      provideSpawner(windowsToWslPathImpl(distro, windowsPath)).pipe(
        Effect.withSpan("desktop.wsl.windowsToWslPath"),
      );

    const userHomeCache = new Map<string, string>();
    const getUserHome = Effect.fn("desktop.wsl.getUserHome")(function* (distro: string | null) {
      const key = distro ?? "__default__";
      const cached = userHomeCache.get(key);
      if (cached !== undefined) return Option.some(cached);
      const resolved = yield* provideSpawner(getUserHomeImpl(distro));
      if (Option.isSome(resolved)) userHomeCache.set(key, resolved.value);
      return resolved;
    });

    const getDistroIp = (distro: string | null) =>
      provideSpawner(getDistroIpImpl(distro)).pipe(Effect.withSpan("desktop.wsl.getDistroIp"));

    const probeDistros = provideSpawner(probeWslDistros).pipe(
      Effect.withSpan("desktop.wsl.probeDistros"),
    );

    return DesktopWslEnvironment.of({
      isAvailable,
      listDistros: probeDistros.pipe(
        Effect.orElseSucceed(() => []),
        Effect.withSpan("desktop.wsl.listDistros"),
      ),
      probeDistros,
      preWarm: Effect.fn("desktop.wsl.preWarm")(function (distro) {
        return provideSpawner(preWarmImpl(distro));
      }),
      windowsToWslPath,
      getUserHome,
      getDistroIp,
      prepareRuntime: Effect.fn("desktop.wsl.prepareRuntime")(function (distro, archive) {
        return provideSpawner(prepareWslRuntimeImpl(distro, archive, windowsToWslPath));
      }),
      pruneRuntimes: Effect.fn("desktop.wsl.pruneRuntimes")(function (distro, runtimeId) {
        return provideSpawner(pruneWslRuntimesImpl(distro, runtimeId));
      }),
      invalidateRuntime: Effect.fn("desktop.wsl.invalidateRuntime")(function (distro, runtimeId) {
        return provideSpawner(invalidateWslRuntimeImpl(distro, runtimeId));
      }),
      probeRuntime: Effect.fn("desktop.wsl.probeRuntime")(function (distro, linuxAppRoot) {
        return provideSpawner(probeWslRuntimeImpl(distro, linuxAppRoot));
      }),
      ensureNodePty: Effect.fn("desktop.wsl.ensureNodePty")(
        function (distro, linuxAppRoot, options) {
          return provideSpawner(ensureNodePtyImpl(distro, linuxAppRoot, options));
        },
      ),
    });
  }),
);
