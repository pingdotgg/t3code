// @effect-diagnostics globalTimers:off
// The SDK owns process shutdown; native deadlines cover initialize before an Effect resource exists.
import {
  spawnMspConnection,
  type Connection,
  type ProcessExit,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type { RuntimeMode } from "@t3tools/contracts";

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
  readonly initializeResult: SpawnedMspConnection["initializeResult"];
  readonly exited: Promise<ProcessExit>;
  readonly close: () => Promise<void>;
}

export interface MuseSdkHostOptions {
  readonly binaryPath: string;
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
        .filter((key) => key !== "META_API_KEY")
        .map((key) => [key, environment[key]]),
    ),
    MUSE_NO_AUTO_UPDATE: "1",
  };
}

export function museApprovalMode(runtimeMode: RuntimeMode) {
  return runtimeMode === "full-access" ? "allowAll" : "promptUnmatched";
}

/** One SDK-owned process. The pre-handshake handle owns cleanup even when initialize never replies. */
export async function createMuseSdkHost(
  options: MuseSdkHostOptions,
  spawn: typeof spawnMspConnection = spawnMspConnection,
): Promise<MuseSdkHost> {
  options.signal?.throwIfAborted();
  const args = ["serve"];
  if (options.readOnly) {
    args.push("--disable-shell", "--disable-write");
    if (options.sessionLogging !== true) args.push("--no-session-log");
  } else {
    args.push("--trust-workspace");
    if (options.runtimeMode === "full-access") args.push("--disable-sandbox");
  }
  const handshake = spawn({
    command: options.binaryPath,
    args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: makeMuseEnvironment(options.environment),
    shutdownTimeoutMs: 30_000,
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
      handshake.initialize({ clientInfo: { name: "t3_code", title: "T3 Code", version: "1" } }),
      interrupted,
    ]);
    // The SDK's fingerprint warning permits additive optional schema changes.
    // Successful initialization, not fingerprint identity, determines readiness.
    return {
      connection: host.connection,
      initializeResult: host.initializeResult,
      exited: host.exited,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
