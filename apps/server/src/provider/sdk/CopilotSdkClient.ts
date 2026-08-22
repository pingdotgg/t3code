/**
 * CopilotSdkClient — scoped Effect wrapper around `@github/copilot-sdk`'s
 * `CopilotClient`.
 *
 * The client spawns and drives the installed `copilot` runtime binary over the
 * SDK's typed JSON-RPC protocol (`RuntimeConnection.forStdio`), replacing the
 * generic ACP transport the Copilot provider used previously. It is acquired as
 * a scoped resource: `start()` on acquire, `stop()` on release.
 *
 * @module provider/sdk/CopilotSdkClient
 */
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type GetAuthStatusResponse,
  type GetStatusResponse,
  type ModelInfo,
  type ResumeSessionConfig,
  type SessionConfig,
} from "@github/copilot-sdk";
// Raw fs/path are needed to resolve the runtime binary to an absolute path at
// the SDK spawn boundary — a plain async callback outside any Effect context.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class CopilotSdkError extends Schema.TaggedErrorClass<CopilotSdkError>()("CopilotSdkError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitHub Copilot SDK operation '${this.operation}' failed.`;
  }
}

function toSdkError(operation: string) {
  return (cause: unknown): CopilotSdkError => new CopilotSdkError({ operation, cause });
}

/** Filters a `ProcessEnv` down to the `Record<string, string>` the SDK expects. */
function toStringEnv(
  environment: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!environment) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    // Must be a regular file, not a directory: a directory named `copilot`
    // earlier in PATH would otherwise shadow a real CLI later in PATH.
    const stat = await NodeFS.promises.stat(candidate);
    if (!stat.isFile()) return false;
    await NodeFS.promises.access(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the `copilot` runtime binary to an absolute path.
 *
 * The SDK spawns the path we give it and does NOT resolve a bare command name
 * against the connection env's PATH — and a GUI-launched app inherits a minimal
 * PATH that omits Homebrew/npm dirs. So an unresolved `"copilot"` fails with
 * "Copilot CLI not found at copilot". We resolve it ourselves against the
 * spawn env's PATH plus the usual install locations, and hand the SDK an
 * absolute path. An already-absolute/relative path (contains a separator) is
 * used verbatim; if nothing resolves we fall back to the bare name so the SDK
 * still surfaces its own diagnostic.
 */
export async function resolveCopilotBinaryPath(
  binary: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<string> {
  if (binary.includes(NodePath.sep) || binary.includes("/")) return binary;

  const home = env?.HOME ?? process.env.HOME ?? "";
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  // A POSIX empty `PATH` component (leading/trailing/`::`) means the current
  // working directory. We resolve `PATH` ourselves (the SDK does no lookup), so
  // honor that — dropping empties would make a `copilot` in the CWD unfindable.
  // `NodePath.resolve(".")` runs only when an empty component is actually present
  // (a normal PATH never resolves the CWD, so it can't fail on one that's gone).
  const pathDirs = pathValue
    .split(NodePath.delimiter)
    .map((d) => (d === "" ? NodePath.resolve(".") : d.trim()))
    .filter(Boolean);

  // On Windows an npm-installed `copilot` is a `copilot.cmd` shim: the bare
  // name never resolves to a file, so probe each PATHEXT suffix (`.CMD`, …) in
  // addition to the exact name. `NodePath.sep` is the lint-safe platform probe.
  const isWindows = NodePath.sep === "\\";
  const pathext = isWindows
    ? (env?.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
    : [];
  const candidateNames = [
    binary,
    ...pathext
      .filter((ext) => !binary.toLowerCase().endsWith(ext.toLowerCase()))
      .map((ext) => `${binary}${ext}`),
  ];
  const commonDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(home
      ? [
          NodePath.join(home, ".local/bin"),
          NodePath.join(home, ".bun/bin"),
          NodePath.join(home, ".volta/bin"),
          NodePath.join(home, ".npm-global/bin"),
        ]
      : []),
  ];

  const seen = new Set<string>();
  for (const dir of [...pathDirs, ...commonDirs]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of candidateNames) {
      const candidate = NodePath.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return binary;
}

// `client.start()` spawns the runtime child and awaits the stdio JSON-RPC
// handshake. It runs inside `acquireRelease`'s *uninterruptible* acquire, so an
// outer `Effect.timeout` can't cut a stalled start (a slow spawn, a first-run
// device-auth handshake, or a binary that never completes the handshake). That
// matters most for discovery, which now runs inside the status check under the
// provider's single refresh permit — a hung start would otherwise freeze every
// refresh. Bound it here, at the JS level, where it can actually be enforced.
// Callers on the refresh path pass a shorter `startTimeoutMs`, and the failure
// path uses a bounded stop (below), so a stalled start holds the permit only for
// `startTimeoutMs + CLIENT_STOP_TIMEOUT_MS` — not the SDK's internal shutdown
// budgets, which `stop()` can otherwise burn (it resolves-with-errors on a hang).
const CLIENT_START_TIMEOUT_MS = 15_000;
// Max wait for a graceful `stop()` before hard-killing. `stop()` is bounded so a
// failed acquire (below) and scope release don't inherit the SDK's own multi-
// second internal shutdown budgets while holding the provider's refresh permit.
const CLIENT_STOP_TIMEOUT_MS = 2_000;

const TIMED_OUT = Symbol("timed-out");

/** Rejects if `client.start()` doesn't resolve within `timeoutMs`. */
async function startClientWithTimeout(client: CopilotClient, timeoutMs: number): Promise<void> {
  // Raw JS timers (not Effect.sleep): this races plain promises at the JS level
  // precisely because the uninterruptible acquire is beyond Effect's reach.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // @effect-diagnostics-next-line globalTimers:off
    timer = setTimeout(
      () => reject(new Error(`Copilot runtime did not start within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([client.start(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Gracefully stops the client, hard-killing if it doesn't settle in time. The
 * SDK's `stop()` RESOLVES (with an internal `errors[]`) rather than rejecting
 * when its own shutdown timeouts fire, so a `.catch(() => forceStop())` never
 * triggers on a hang — only racing it against our own timer catches that.
 */
async function stopClientBounded(client: CopilotClient, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    // @effect-diagnostics-next-line globalTimers:off
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      // Normalize both fulfil and reject to "done" so only the timer can win a hang.
      client.stop().then(
        () => "done" as const,
        () => "done" as const,
      ),
      timeout,
    ]);
    if (outcome === TIMED_OUT) {
      await client.forceStop().catch(() => {});
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CopilotSdkClient {
  /** Underlying SDK client, for the rare call not wrapped below. */
  readonly raw: CopilotClient;
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, CopilotSdkError>;
  readonly getAuthStatus: Effect.Effect<GetAuthStatusResponse, CopilotSdkError>;
  readonly getStatus: Effect.Effect<GetStatusResponse, CopilotSdkError>;
  readonly createSession: (config: SessionConfig) => Effect.Effect<CopilotSession, CopilotSdkError>;
  readonly resumeSession: (
    sessionId: string,
    config: ResumeSessionConfig,
  ) => Effect.Effect<CopilotSession, CopilotSdkError>;
}

export interface CopilotSdkClientInput {
  readonly binaryPath?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
  /**
   * Max wait for the runtime's `start()` handshake (default
   * {@link CLIENT_START_TIMEOUT_MS}). The discovery path passes a value below
   * its own budget so a stalled start can't hold the provider's refresh permit.
   */
  readonly startTimeoutMs?: number;
}

/**
 * Acquires a started `CopilotClient` as a scoped resource. The client is
 * stopped when the enclosing scope closes.
 */
export const makeCopilotSdkClient = (
  input: CopilotSdkClientInput,
): Effect.Effect<CopilotSdkClient, CopilotSdkError, Scope.Scope> => {
  const env = toStringEnv(input.environment);
  const binary = input.binaryPath?.trim() || "copilot";

  const acquire = Effect.tryPromise({
    try: async () => {
      const path = await resolveCopilotBinaryPath(binary, env);
      const client = new CopilotClient({
        // Env goes ONLY on the stdio connection — the SDK rejects setting it at
        // both the client level and the connection level, and prefers the
        // connection-level env for child-process transports.
        connection: RuntimeConnection.forStdio({ path, ...(env ? { env } : {}) }),
        ...(input.logLevel ? { logLevel: input.logLevel } : {}),
      });
      // `start()` spawns the runtime child process before it resolves; if it
      // rejects (or times out), `acquireRelease` never gets `client` to register
      // its release, so stop it here to avoid leaking the process/handshake.
      try {
        await startClientWithTimeout(client, input.startTimeoutMs ?? CLIENT_START_TIMEOUT_MS);
      } catch (error) {
        await stopClientBounded(client, CLIENT_STOP_TIMEOUT_MS);
        throw error;
      }
      return client;
    },
    catch: toSdkError("start"),
  });

  const release = (client: CopilotClient) =>
    // Bounded graceful stop with a hard-kill fallback, so a hung `stop()` never
    // leaves the runtime child alive — or stalls scope teardown — after close.
    Effect.promise(() => stopClientBounded(client, CLIENT_STOP_TIMEOUT_MS)).pipe(Effect.asVoid);

  return Effect.acquireRelease(acquire, release).pipe(
    Effect.map(
      (client): CopilotSdkClient => ({
        raw: client,
        listModels: Effect.tryPromise({
          try: () => client.listModels(),
          catch: toSdkError("listModels"),
        }),
        getAuthStatus: Effect.tryPromise({
          try: () => client.getAuthStatus(),
          catch: toSdkError("getAuthStatus"),
        }),
        getStatus: Effect.tryPromise({
          try: () => client.getStatus(),
          catch: toSdkError("getStatus"),
        }),
        createSession: (config) =>
          Effect.tryPromise({
            try: () => client.createSession(config),
            catch: toSdkError("createSession"),
          }),
        resumeSession: (sessionId, config) =>
          Effect.tryPromise({
            try: () => client.resumeSession(sessionId, config),
            catch: toSdkError("resumeSession"),
          }),
      }),
    ),
  );
};
