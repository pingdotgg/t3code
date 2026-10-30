// @effect-diagnostics globalTimers:off
// The SDK owns process shutdown; native deadlines cover initialize before an Effect resource exists.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.realPath is Node's JS realpath; museWorkspaceRoot needs the native one.
import * as NodeFSP from "node:fs/promises";

import {
  spawnMspConnection,
  type Connection,
  type ProcessExit,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type { RuntimeMode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

export interface MuseSdkHost {
  readonly connection: Pick<
    Connection,
    | "command"
    | "request"
    | "mintCommandId"
    | "onNotification"
    | "onServerRequest"
    | "onProtocolError"
    | "closed"
  >;
  readonly initializeResult: Pick<SpawnedMspConnection["initializeResult"], "grantedCapabilities"> &
    Partial<Pick<SpawnedMspConnection["initializeResult"], "museHome">>;
  readonly exited: Promise<ProcessExit>;
  readonly stderrTail?: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface MuseLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface MuseSdkHostOptions {
  readonly binaryPath: string;
  readonly launchArgs?: ReadonlyArray<string>;
  readonly launch?: MuseLaunch;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly readOnly?: boolean;
  /** Read-only generation needs session logging for turn/item notifications. */
  readonly sessionLogging?: boolean;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly onProcessExit?: (exit: ProcessExit) => void;
}

export function makeMuseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.keys(environment)
        .filter((key) => key.toUpperCase() !== "META_API_KEY")
        .map((key) => [key, environment[key]]),
    ),
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

export function museVerbatimPath(path: string): string {
  if (path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\") ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}

/** Windows roots need native realpath for true case/long names, then verbatim form; launch cmd.exe in plain form. */
export const museWorkspaceRoot = Effect.fn("museWorkspaceRoot")(function* (path: string) {
  if ((yield* HostProcess.Platform) !== "win32") return path;
  const canonical = yield* Effect.tryPromise(() => NodeFSP.realpath(path)).pipe(
    // A verbatim path takes `/` literally, so an unresolved root needs Windows separators.
    Effect.orElseSucceed(() => path.replaceAll("/", "\\")),
  );
  return museVerbatimPath(canonical);
});

function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string) {
  const key = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : environment[key];
}

/** Resolve Windows launchers with PATHEXT and run .cmd/.bat under cmd.exe; SDK spawn has no shell. */
export const museLaunch = Effect.fn("museLaunch")(function* (
  binaryPath: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<MuseLaunch> {
  if ((yield* HostProcess.Platform) !== "win32") return { command: binaryPath, args: [] };
  const env = environment ?? (yield* HostProcess.Environment);
  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolved = resolveExecutable(binaryPath, "win32", env) ?? binaryPath;
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { command: resolved, args: [] };
  const systemRoot = windowsEnvironmentValue(env, "SystemRoot");
  return {
    command:
      windowsEnvironmentValue(env, "ComSpec") ??
      (systemRoot ? `${systemRoot}\\System32\\cmd.exe` : "cmd.exe"),
    // /d prevents AutoRun stdout; bare @ preserves quoted paths that cmd /c would unquote.
    args: [
      "/d",
      "/c",
      ...(/\s/.test(resolved) ? ["@", resolved] : [resolved.replace(/[()&<>@^|]/g, "^$&")]),
    ],
  };
});

export function museApprovalMode(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
}

// Select explicitly; Muse defaults may let an AI reviewer decide approvals.
export function musePermissionProfile(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? ":unrestricted" : ":ask-me";
}

export function museServeArgs(
  options: Pick<MuseSdkHostOptions, "readOnly" | "sessionLogging" | "runtimeMode">,
) {
  const args = ["serve"];
  if (options.readOnly) {
    args.push("--disable-shell", "--disable-write");
    if (options.sessionLogging !== true) args.push("--no-session-log");
  } else {
    args.push("--trust-workspace");
    if (options.runtimeMode === "full-access") args.push("--disable-sandbox");
  }
  return args;
}

export function museInitializeParams(readOnly = false) {
  return {
    clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },
    capabilities: { requestedCapabilities: readOnly ? [] : ["sessionMcp"] },
  };
}

/** Owns cleanup before the handshake, even if initialize never replies. */
export async function createMuseSdkHost(
  options: MuseSdkHostOptions,
  spawn: typeof spawnMspConnection = spawnMspConnection,
): Promise<MuseSdkHost> {
  options.signal?.throwIfAborted();
  const launch = options.launch ?? { command: options.binaryPath, args: [] };
  const handshake = spawn({
    command: launch.command,
    args: [...launch.args, ...(options.launchArgs ?? []), ...museServeArgs(options)],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.environment ?? makeMuseEnvironment(),
    shutdownTimeoutMs: 10_000,
    ...(options.onProcessExit ? { onProcessExit: options.onProcessExit } : {}),
  });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    options.signal?.removeEventListener("abort", onAbort);
    return (closePromise ??= handshake.close().then(() => undefined));
  };
  let rejectStartup: (reason: unknown) => void = () => {};
  const onAbort = () => {
    rejectStartup(options.signal?.reason ?? new Error("Muse SDK startup aborted."));
    void close().catch(() => {});
  };
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(
    () => rejectStartup(new Error("Muse SDK initialization timed out.")),
    options.startupTimeoutMs ?? 20_000,
  );
  timer.unref();
  try {
    const host = await Promise.race([
      handshake.initialize(museInitializeParams(options.readOnly)),
      interrupted,
    ]);
    if (host.initializeResult.schema?.version !== 1) {
      throw new Error("Muse SDK returned an unsupported protocol envelope version.");
    }
    // Fingerprint warnings permit additive schema changes; successful initialization proves readiness.
    return {
      connection: host.connection,
      initializeResult: host.initializeResult,
      exited: host.exited,
      stderrTail: () => handshake.child.stderrTail,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Cancellation waits for native shutdown before callers release startup resources. */
export const createMuseSdkHostEffect = Effect.fn("createMuseSdkHostEffect")(function* (
  options: Omit<MuseSdkHostOptions, "signal">,
  createHost: typeof createMuseSdkHost = createMuseSdkHost,
) {
  const launch = options.launch ?? (yield* museLaunch(options.binaryPath, options.environment));
  let startup: Promise<MuseSdkHost> | undefined;
  return yield* Effect.tryPromise((signal) => {
    startup = createHost({ ...options, launch, signal });
    return startup;
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        await startup?.then(
          (host) => host.close(),
          () => {},
        );
      }),
    ),
  );
});
