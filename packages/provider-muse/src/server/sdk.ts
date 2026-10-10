// @effect-diagnostics globalTimers:off
// The SDK owns process shutdown; native deadlines cover initialize before an Effect resource exists.
import {
  spawnMspConnection,
  type Connection,
  type ProcessExit,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type { RuntimeMode } from "@t3tools/contracts";
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
  readonly initializeResult: Pick<SpawnedMspConnection["initializeResult"], "grantedCapabilities">;
  readonly exited: Promise<ProcessExit>;
  /** The last lines Muse wrote to stderr, for explaining an unexpected exit. */
  readonly stderrTail?: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface MuseSdkHostOptions {
  readonly binaryPath: string;
  /** Arguments before the serve arguments, for a launcher in front of the binary. */
  readonly launchArgs?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Disables shell and filesystem writes and workspace trust. */
  readonly readOnly?: boolean;
  /** Read-only generation needs durable logging for turn/item notifications (verified through 1.1.1). */
  readonly sessionLogging?: boolean;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
}

/** Preserve the host's CLI login while excluding the API-key override before copying values. */
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

export function museApprovalMode(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
}

/** The `muse serve` arguments for a host: read-only hosts get no shell, writes, or workspace trust. */
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

/** What T3 sends in MSP `initialize`; only full hosts ask for session MCP servers. */
export function museInitializeParams(readOnly = false) {
  return {
    clientInfo: { name: "t3_code", title: "T3 Code", version: "1" },
    capabilities: { requestedCapabilities: readOnly ? [] : ["sessionMcp"] },
  };
}

/** One SDK-owned process. The pre-handshake handle owns cleanup even when initialize never replies. */
export async function createMuseSdkHost(
  options: MuseSdkHostOptions,
  spawn: typeof spawnMspConnection = spawnMspConnection,
): Promise<MuseSdkHost> {
  options.signal?.throwIfAborted();
  const handshake = spawn({
    command: options.binaryPath,
    args: [...(options.launchArgs ?? []), ...museServeArgs(options)],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    // Callers pass an environment already built with makeMuseEnvironment.
    env: options.environment ?? makeMuseEnvironment(),
    // A healthy host exits at once; this only bounds a hung one on close.
    shutdownTimeoutMs: 10_000,
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
    // The SDK's fingerprint warning permits additive optional schema changes.
    // Successful initialization, not fingerprint identity, determines readiness.
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
  let startup: Promise<MuseSdkHost> | undefined;
  return yield* Effect.tryPromise((signal) => {
    startup = createHost({ ...options, signal });
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
