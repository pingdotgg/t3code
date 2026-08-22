// @effect-diagnostics nodeBuiltinImport:off
/**
 * Runtime for OpenCode 2.x ("OpenCode 2"), which is a different server than
 * the 1.x one `opencodeRuntime.ts` drives, not a newer build of it.
 *
 * Three differences make a separate runtime necessary rather than a flag:
 *
 *   1. **Startup banner.** 1.x prints `opencode server listening on <url>`;
 *      2.x prints `server listening on <url>`. The 1.x prefix match never fires
 *      and the spawn times out.
 *   2. **Mandatory auth.** 1.x serves unauthenticated and warns about it. 2.x
 *      mints a password and 401s without it. Next-line builds print it on
 *      stdout beside the URL; beta `lildax` writes it only to
 *      `$XDG_STATE_HOME/opencode/password` (no banner line). Startup still has
 *      to resolve both facts.
 *   3. **Route surface.** 2.x serves only `/api/*`. The HTTP client is
 *      `@opencode-ai/client` (`0.0.0-beta-17823`). Its `session.*` / `event.*`
 *      groups are the `/api/*` surface. Do not use `@opencode-ai/sdk` here;
 *      that package is the OpenCode 1.x client. The packaged T3 OpenCode 2 CLI
 *      pin is tracked separately and may lag this client stamp.
 *
 * `live-scenarios/tests/opencode2-drive-probe.mjs` in the parent workspace
 * exercises this contract against a real binary and fails first if 2.x moves.
 * `connectToOpenCode2Server` reuses one spawned process per binary and managed
 * data/state home for the runtime layer lifetime. Direct
 * `startOpenCode2ServerProcess` calls stay bound to the caller scope. Process
 * teardown still uses the scope finalizer's process-group kill plus the
 * stdin-EOF watchdog sidecar.
 */
import { ClientError, OpenCode, type OpenCodeClient } from "@opencode-ai/client";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { openCodeRuntimeErrorDetail } from "./opencodeRuntime.ts";
import * as SpawnedProcessReaper from "./SpawnedProcessReaper.ts";

const DEFAULT_OPENCODE2_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const MAX_OPENCODE2_STARTUP_OUTPUT_CHARS = 16_384;
const OPENCODE2_STARTUP_DRAIN_TIMEOUT = "100 millis";
/** After the listen URL, poll this many times (20ms each) for a banner password
 * or the beta state-dir password file before settling. */
const OPENCODE2_PASSWORD_POLL_ATTEMPTS = 5;
const OPENCODE2_PASSWORD_POLL_INTERVAL = "20 millis";
const wallClock = Clock.Clock.defaultValue();

const withOpenCode2WallClock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Clock.Clock, wallClock);

export const OpenCode2RuntimeOperation = Schema.Literals([
  "agent.list",
  "connectToOpenCode2Server",
  "event.subscribe",
  "generate.text",
  "health.get",
  "integration.list",
  "mcp.add",
  "mcp.list",
  "message.list",
  "model.list",
  "session.compact",
  "session.context",
  "session.create",
  "session.fork",
  "session.form.reply",
  "session.generate",
  "session.get",
  "session.inbox.list",
  "session.instructions.entry.put",
  "session.interrupt",
  "session.pending.list",
  "session.permission.reply",
  "session.prompt",
  "session.question.reply",
  "session.remove",
  "session.revert.commit",
  "session.revert.stage",
  "session.switchAgent",
  "session.switchModel",
  "session.wait",
  "shell.create",
  "shell.list",
  "shell.output",
  "shell.remove",
  "skill.list",
  "startOpenCode2ServerProcess",
]);
export type OpenCode2RuntimeOperation = typeof OpenCode2RuntimeOperation.Type;

export const OpenCode2RuntimeErrorCategory = Schema.Literals([
  "authentication-failed",
  "binary-not-found",
  "event-subscription-failed",
  "external-server-password-required",
  "mcp-connect-failed",
  "mcp-connect-timeout",
  "missing-response-payload",
  "model-unavailable",
  "network-failed",
  "placeholder-binary",
  "port-allocation-failed",
  "quarantined-binary",
  "replay-boundary",
  "sdk-request-failed",
  "server-spawn-failed",
  "session-remove-failed",
  "startup-exited",
  "startup-failed",
  "startup-timeout",
]);
export type OpenCode2RuntimeErrorCategory = typeof OpenCode2RuntimeErrorCategory.Type;

export class OpenCode2RuntimeError extends Schema.TaggedErrorClass<OpenCode2RuntimeError>()(
  "OpenCode2RuntimeError",
  {
    category: OpenCode2RuntimeErrorCategory,
    cause: Schema.optional(Schema.Defect()),
    exitCode: Schema.optionalKey(Schema.Number),
    operation: OpenCode2RuntimeOperation,
    timeoutMs: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    const exitContext = this.exitCode === undefined ? "" : `, exit code ${this.exitCode}`;
    const timeoutContext = this.timeoutMs === undefined ? "" : `, timeout ${this.timeoutMs}ms`;
    return `OpenCode 2 ${this.operation} failed (${this.category}${exitContext}${timeoutContext}).`;
  }
}

export const isOpenCode2RuntimeError = Schema.is(OpenCode2RuntimeError);

function openCode2SdkErrorCause(cause: unknown): unknown {
  return cause instanceof ClientError && cause.cause !== undefined ? cause.cause : cause;
}

function openCode2SdkErrorCategoryFromText(
  cause: unknown,
): Extract<
  OpenCode2RuntimeErrorCategory,
  "authentication-failed" | "model-unavailable" | "network-failed" | "sdk-request-failed"
> {
  if (cause instanceof ClientError && cause.reason === "Transport") return "network-failed";
  const detail = openCodeRuntimeErrorDetail(openCode2SdkErrorCause(cause)).toLowerCase();
  if (detail.startsWith("model unavailable:")) return "model-unavailable";
  if (
    detail.includes("401") ||
    detail.includes("403") ||
    detail.includes("unauthorized") ||
    detail.includes("forbidden")
  ) {
    return "authentication-failed";
  }
  if (
    detail.includes("econnrefused") ||
    detail.includes("enotfound") ||
    detail.includes("fetch failed") ||
    detail.includes("networkerror") ||
    detail.includes("socket hang up") ||
    detail.includes("timed out") ||
    detail.includes("timeout")
  ) {
    return "network-failed";
  }
  return "sdk-request-failed";
}

function openCode2ExecutableErrorCategoryFromText(
  cause: unknown,
): Extract<
  OpenCode2RuntimeErrorCategory,
  "binary-not-found" | "placeholder-binary" | "quarantined-binary" | "server-spawn-failed"
> {
  const detail = openCodeRuntimeErrorDetail(cause).toLowerCase();
  if (detail.includes("postinstall")) return "placeholder-binary";
  if (detail.includes("quarantine")) return "quarantined-binary";
  if (detail.includes("enoent") || detail.includes("notfound")) return "binary-not-found";
  return "server-spawn-failed";
}

export const runOpenCode2Sdk = <A>(
  operation: OpenCode2RuntimeOperation,
  fn: () => Promise<A>,
): Effect.Effect<A, OpenCode2RuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCode2RuntimeError({
        operation,
        category: openCode2SdkErrorCategoryFromText(cause),
        cause,
      }),
  }).pipe(Effect.withSpan(`opencode2.${operation}`));

/** Startup facts from the 2.x banner. */
export interface OpenCode2ServerCredentials {
  readonly url: string;
  readonly password: string;
}

export interface OpenCode2ServerProcess extends OpenCode2ServerCredentials {
  readonly exitCode: Effect.Effect<number, never>;
  readonly isRunning: Effect.Effect<boolean, never>;
}

export interface OpenCode2ServerConnection extends OpenCode2ServerCredentials {
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

export class OpenCode2Runtime extends Context.Service<
  OpenCode2Runtime,
  {
    /**
     * Spawn a local 2.x server. Lifetime is bound to the caller's scope, so the
     * child dies when that scope closes.
     */
    readonly startOpenCode2ServerProcess: (input: {
      readonly binaryPath: string;
      readonly environment?: NodeJS.ProcessEnv;
      readonly port?: number;
      readonly hostname?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<OpenCode2ServerProcess, OpenCode2RuntimeError, Scope.Scope>;
    /**
     * Connect to an externally-managed server, or reuse the spawned server for
     * this binary and managed data home. An external server must carry its own
     * password: 2.x has no unauthenticated mode, so there is nothing to fall
     * back to.
     */
    readonly connectToOpenCode2Server: (input: {
      readonly binaryPath: string;
      readonly serverUrl?: string | null;
      readonly serverPassword?: string | null;
      readonly environment?: NodeJS.ProcessEnv;
      readonly port?: number;
      readonly hostname?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<OpenCode2ServerConnection, OpenCode2RuntimeError, Scope.Scope>;
    readonly createOpenCode2SdkClient: (input: {
      readonly baseUrl: string;
      readonly directory: string;
      readonly serverPassword: string;
    }) => OpenCodeClient;
  }
>()("t3/provider/opencode2Runtime") {}

/**
 * Read the URL and password out of accumulated server output.
 *
 * Ready once both banner facts are present. Beta `lildax` only prints the URL
 * and stores the password under the state dir, so spawned-server startup uses
 * {@link readOpenCode2StatePassword} as its fallback.
 * Deliberately not anchored to line start — surrounding banner text has
 * changed before.
 *
 * @internal exported for tests
 */
export function parseOpenCode2Startup(output: string): OpenCode2ServerCredentials | null {
  const facts = parseOpenCode2StartupFacts(output);
  if (facts.url === null || facts.password === null) return null;
  return { url: facts.url, password: facts.password };
}

function parseOpenCode2StartupFacts(output: string): {
  readonly url: string | null;
  readonly password: string | null;
} {
  // Require a line starting with `server listening` so 1.x's
  // `opencode server listening on ...` does not match.
  const url = output.match(/(?:^|\n)server listening on\s+(https?:\/\/\S+)/)?.[1] ?? null;
  const password = output.match(/(?:^|\n)server password\s+(\S+)/)?.[1] ?? null;
  return { url, password };
}

/**
 * Beta `lildax` mints a server password into
 * `$XDG_STATE_HOME/opencode/password` (default
 * `~/.local/state/opencode/password`) and does not print it. Prefer the
 * banner password when present; fall back to this file after the grace window.
 *
 * @internal exported for tests
 */
export function readOpenCode2StatePassword(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const stateHome =
    environment.XDG_STATE_HOME?.trim() ||
    NodePath.join(environment.HOME?.trim() || NodeOS.homedir(), ".local", "state");
  try {
    const password = NodeFS.readFileSync(
      NodePath.join(stateHome, "opencode", "password"),
      "utf8",
    ).trim();
    return password.length > 0 ? password : null;
  } catch {
    return null;
  }
}

/** The header the 2.x server checks when auth is enabled. Username is fixed. */
export function openCode2AuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;
}

/**
 * The 2.x server resolves a session with no variant to a synthetic variant
 * literally named "default" and stamps that id on the session and its
 * messages, so this id means "let the server decide" and must never be sent
 * as an explicit variant: it is not in any model's `variants` list, and 2.x
 * silently drops the next prompt (user message recorded, no assistant reply)
 * when the bound variant is unknown.
 */
export const OPENCODE2_DEFAULT_VARIANT = "default";

export function normalizeOpenCode2Variant(variant: string | undefined): string | undefined {
  return variant === OPENCODE2_DEFAULT_VARIANT ? undefined : variant;
}

/**
 * Synthetic agent-option id meaning "defer to the Build/Plan toggle". The
 * Agent descriptor only appears when custom primary agents exist, listing
 * this sentinel plus the customs; the native `build`/`plan` pair is owned by
 * the interaction-mode toggle. A real agent named "auto" would collide and is
 * excluded from the descriptor.
 */
export const OPENCODE2_AUTO_AGENT = "auto";

export function escalateOpenCode2ServerTermination(
  kill: (signal: NodeJS.Signals) => Effect.Effect<void>,
  awaitExit: Effect.Effect<unknown, never>,
  isProcessGroupAlive: Effect.Effect<boolean, never>,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* kill("SIGTERM");
    const exited = yield* awaitExit.pipe(Effect.as(true), Effect.timeoutOption("500 millis"));
    if (Option.isSome(exited)) {
      if (!(yield* isProcessGroupAlive)) return;
      yield* Effect.sleep("500 millis");
      if (!(yield* isProcessGroupAlive)) return;
      yield* kill("SIGKILL");
      return;
    }
    if (!(yield* isProcessGroupAlive)) return;
    yield* kill("SIGKILL");
  });
}

/**
 * Identity for the one T3-owned OpenCode 2 process. Session-varying inline
 * config is excluded so inventory and every thread share the same server.
 *
 * @internal exported for tests
 */
export function openCode2SharedServerKey(input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostname?: string;
}): string {
  const environment = input.environment ?? {};
  return [
    input.binaryPath.trim(),
    environment.XDG_DATA_HOME?.trim() ?? "",
    environment.XDG_STATE_HOME?.trim() ?? "",
    input.hostname?.trim() || DEFAULT_HOSTNAME,
  ].join("\0");
}

/**
 * Drop per-session inline config before spawning the shared process.
 *
 * @internal exported for tests
 */
export function environmentForSharedOpenCode2Server(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (environment === undefined) return undefined;
  const next = { ...environment };
  delete next.OPENCODE_CONFIG_CONTENT;
  return next;
}

export const make = Effect.gen(function* () {
  const layerScope = yield* Effect.scope;
  const sharedServerLock = yield* Semaphore.make(1);
  const sharedServers = yield* Ref.make(
    new Map<
      string,
      {
        readonly connection: OpenCode2ServerConnection;
        readonly isRunning: Effect.Effect<boolean>;
      }
    >(),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const reaper = yield* SpawnedProcessReaper.SpawnedProcessReaper;

  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const startOpenCode2ServerProcess: OpenCode2Runtime["Service"]["startOpenCode2ServerProcess"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Effect.scope;
      const processScope = yield* Scope.make();
      yield* Scope.addFinalizer(
        runtimeScope,
        Scope.close(processScope, Exit.void).pipe(Effect.ignore),
      );
      const closeProcessScopeOnFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Scope.close(processScope, Exit.void).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
      const environment = input.environment ?? process.env;
      const bunTempDirectory = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const roots = [
              environment.BUN_TMPDIR?.trim(),
              environment.TMPDIR?.trim(),
              NodeOS.tmpdir(),
            ].filter(
              (root, index, all): root is string => Boolean(root) && all.indexOf(root) === index,
            );
            let lastCause: unknown;
            for (const root of roots) {
              try {
                return NodeFS.mkdtempSync(NodePath.join(root, "t3-opencode2-bun-"));
              } catch (cause) {
                lastCause = cause;
              }
            }
            throw lastCause;
          },
          catch: (cause) =>
            new OpenCode2RuntimeError({
              operation: "startOpenCode2ServerProcess",
              category: "server-spawn-failed",
              cause,
            }),
        }),
        (directory) =>
          Effect.tryPromise({
            try: () =>
              NodeFS.promises.rm(directory, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 50,
              }),
            catch: (cause) =>
              new OpenCode2RuntimeError({
                operation: "startOpenCode2ServerProcess",
                category: "server-spawn-failed",
                cause,
              }),
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("opencode2.bun-temp-cleanup-failed", {
                detail: openCodeRuntimeErrorDetail(cause),
                directory,
              }),
            ),
          ),
      ).pipe(Effect.provideService(Scope.Scope, processScope));
      const spawnEnvironment = {
        ...environment,
        BUN_TMPDIR: bunTempDirectory,
      };
      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCode2RuntimeError({
                operation: "startOpenCode2ServerProcess",
                category: "port-allocation-failed",
                cause,
              }),
          ),
          closeProcessScopeOnFailure,
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE2_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const passwordBeforeSpawn = readOpenCode2StatePassword(environment);
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, spawnEnvironment).pipe(
        closeProcessScopeOnFailure,
      );

      const spawnOpenCode2Server = spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            env: spawnEnvironment,
            extendEnv: false,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, processScope),
          Effect.mapError((cause) => {
            return new OpenCode2RuntimeError({
              operation: "startOpenCode2ServerProcess",
              category: openCode2ExecutableErrorCategoryFromText(cause),
              cause,
            });
          }),
        );

      const { child, processId, isProcessTreeRunning } = yield* Effect.uninterruptible(
        spawnOpenCode2Server.pipe(
          Effect.flatMap((child) => {
            const processId = Number(child.pid);
            const isOpenCode2ProcessGroupAlive = Effect.sync(() => {
              try {
                process.kill(-processId, 0);
                return true;
              } catch (cause) {
                return !(
                  typeof cause === "object" &&
                  cause !== null &&
                  "code" in cause &&
                  cause.code === "ESRCH"
                );
              }
            });
            const isProcessTreeRunning =
              hostPlatform === "win32"
                ? child.isRunning.pipe(Effect.orElseSucceed(() => false))
                : isOpenCode2ProcessGroupAlive;
            const killOpenCode2ProcessGroup = (signal: NodeJS.Signals) =>
              hostPlatform === "win32"
                ? child
                    .kill({ killSignal: signal, forceKillAfter: "500 millis" })
                    .pipe(Effect.asVoid, Effect.ignore)
                : Effect.sync(() => {
                    try {
                      process.kill(-processId, signal);
                    } catch {
                      // The direct child may already have exited after starting
                      // the server. The group kill still owns its descendants.
                    }
                  });
            const terminateOpenCode2Server =
              hostPlatform === "win32"
                ? child
                    .kill({ killSignal: "SIGTERM", forceKillAfter: "500 millis" })
                    .pipe(Effect.asVoid, Effect.ignore)
                : escalateOpenCode2ServerTermination(
                    killOpenCode2ProcessGroup,
                    child.exitCode.pipe(Effect.asVoid, Effect.ignore),
                    isOpenCode2ProcessGroupAlive,
                  );
            return Scope.addFinalizer(
              processScope,
              terminateOpenCode2Server.pipe(Effect.andThen(reaper.untrack(processId))),
            ).pipe(Effect.as({ child, processId, isProcessTreeRunning }));
          }),
        ),
      ).pipe(closeProcessScopeOnFailure);
      yield* reaper
        .track({
          pid: processId,
          pgid: hostPlatform === "win32" ? null : processId,
          platform: hostPlatform === "win32" ? "win32" : "posix",
        })
        .pipe(closeProcessScopeOnFailure);
      const startupOutputRef = yield* Ref.make<{
        readonly lastStream: "stdout" | "stderr" | null;
        readonly output: string | null;
        readonly password: string | null;
        readonly url: string | null;
        readonly failureCategory: OpenCode2RuntimeErrorCategory | null;
      }>({
        failureCategory: null,
        lastStream: null,
        output: "",
        password: null,
        url: null,
      });
      const readyDeferred = yield* Deferred.make<
        OpenCode2ServerCredentials,
        OpenCode2RuntimeError
      >();

      // Keep a bounded parser buffer until ready. URL and password arrive on
      // separate lines and can land in separate chunks, so retain each fact on
      // the ref so a rolling buffer cannot drop them. Ready when both facts are
      // known. Beta lildax may store the password in its state directory
      // instead of printing it. stdout and stderr share the buffer, so a stream
      // switch inserts a newline boundary when the prior
      // chunk did not end one; otherwise `(?:^|\n)` misses a mid-chunk banner.
      const absorb = (stream: "stdout" | "stderr") => (chunk: string) =>
        Ref.modify(startupOutputRef, (previous) => {
          if (previous.output === null) return [null, previous] as const;
          const needsBoundary =
            previous.output.length > 0 &&
            !previous.output.endsWith("\n") &&
            previous.lastStream !== null &&
            previous.lastStream !== stream;
          const combined = `${previous.output}${needsBoundary ? "\n" : ""}${chunk}`;
          const parsed = parseOpenCode2StartupFacts(combined);
          const url = previous.url ?? parsed.url;
          const password = previous.password ?? parsed.password;
          const ready = url !== null && password !== null ? { url, password } : null;
          const output = combined.slice(-MAX_OPENCODE2_STARTUP_OUTPUT_CHARS);
          const category = openCode2ExecutableErrorCategoryFromText(combined);
          return [
            ready,
            {
              failureCategory:
                category === "server-spawn-failed" ? previous.failureCategory : category,
              lastStream: stream,
              output: ready === null ? output : null,
              password,
              url,
            },
          ] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed === null
              ? Effect.void
              : Deferred.succeed(readyDeferred, parsed).pipe(Effect.asVoid),
          ),
        );

      // When the listen URL is present but no password line arrives, fall back
      // to the beta state-dir password file (lildax). Poll during the grace
      // window so a slightly-late file write still wins. Uses the
      // ambient Clock (wall in production, TestClock in unit tests).
      yield* Effect.gen(function* () {
        while (true) {
          const state = yield* Ref.get(startupOutputRef);
          if (state.output === null) return;
          if (state.url !== null) break;
          yield* Effect.sleep("20 millis");
        }
        let filePassword: string | null = null;
        for (let attempt = 0; attempt < OPENCODE2_PASSWORD_POLL_ATTEMPTS; attempt++) {
          const state = yield* Ref.get(startupOutputRef);
          if (state.output === null || state.password !== null) return;
          const candidate = readOpenCode2StatePassword(environment);
          filePassword = candidate === passwordBeforeSpawn ? null : candidate;
          if (filePassword !== null) break;
          yield* Effect.sleep(OPENCODE2_PASSWORD_POLL_INTERVAL);
        }
        yield* Ref.modify(startupOutputRef, (state) => {
          if (state.output === null || state.url === null || state.password !== null) {
            return [null, state] as const;
          }
          const latestPassword = readOpenCode2StatePassword(environment);
          const password =
            filePassword ?? (latestPassword === passwordBeforeSpawn ? null : latestPassword);
          // Keep listening for a late banner password. An empty fallback here
          // would finalize readiness without Authorization and ignore later output.
          if (password === null || password.length === 0) {
            return [null, state] as const;
          }
          const credentials = { url: state.url, password };
          return [
            credentials,
            {
              ...state,
              output: null,
              password,
            },
          ] as const;
        }).pipe(
          Effect.flatMap((credentials) =>
            credentials === null
              ? Effect.void
              : Deferred.succeed(readyDeferred, credentials).pipe(Effect.asVoid, Effect.ignore),
          ),
        );
      }).pipe(Effect.ignore, Effect.forkIn(processScope));

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(absorb("stdout")),
        Effect.ignore,
        Effect.forkIn(processScope),
      );
      // 2.x has printed the banner to stderr across builds, so watch both.
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach(absorb("stderr")),
        Effect.ignore,
        Effect.forkIn(processScope),
      );

      yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const exitCode = Number(code);
            yield* Effect.all([Fiber.await(stdoutFiber), Fiber.await(stderrFiber)], {
              discard: true,
            }).pipe(
              Effect.timeoutOption(OPENCODE2_STARTUP_DRAIN_TIMEOUT),
              Effect.asVoid,
              withOpenCode2WallClock,
            );
            const startupFailureCategory = (yield* Ref.get(startupOutputRef)).failureCategory;
            yield* Deferred.fail(
              readyDeferred,
              new OpenCode2RuntimeError({
                operation: "startOpenCode2ServerProcess",
                category: startupFailureCategory ?? "startup-exited",
                exitCode,
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(processScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit)) {
        yield* Scope.close(processScope, readyExit);
        const squashed = Cause.squash(readyExit.cause);
        if (isOpenCode2RuntimeError(squashed)) return yield* squashed;
        return yield* new OpenCode2RuntimeError({
          operation: "startOpenCode2ServerProcess",
          category: "startup-failed",
          cause: squashed,
        });
      }

      const ready = readyExit.value;
      if (Option.isNone(ready)) {
        yield* Scope.close(processScope, Exit.void);
        return yield* new OpenCode2RuntimeError({
          operation: "startOpenCode2ServerProcess",
          category: "startup-timeout",
          timeoutMs,
        });
      }

      const isRunning = yield* isProcessTreeRunning;
      if (!isRunning) {
        yield* Scope.close(processScope, Exit.void);
        return yield* new OpenCode2RuntimeError({
          operation: "startOpenCode2ServerProcess",
          category: "startup-exited",
        });
      }

      return {
        url: ready.value.url,
        password: ready.value.password,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
        isRunning: isProcessTreeRunning,
      } satisfies OpenCode2ServerProcess;
    });

  const connectToOpenCode2Server: OpenCode2Runtime["Service"]["connectToOpenCode2Server"] = (
    input,
  ) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = input.serverPassword?.trim();
      if (!serverPassword) {
        return new OpenCode2RuntimeError({
          operation: "connectToOpenCode2Server",
          category: "external-server-password-required",
        });
      }
      // Not ours, so no lifetime is attached to the caller's scope.
      return Effect.succeed({
        url: serverUrl,
        password: serverPassword,
        exitCode: null,
        external: true,
      });
    }

    const key = openCode2SharedServerKey({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
    });
    const spawnEnvironment = environmentForSharedOpenCode2Server(input.environment);
    return sharedServerLock.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* Ref.get(sharedServers)).get(key);
        if (current !== undefined && (yield* current.isRunning)) {
          return current.connection;
        }
        const server = yield* startOpenCode2ServerProcess({
          binaryPath: input.binaryPath,
          ...(spawnEnvironment !== undefined ? { environment: spawnEnvironment } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        }).pipe(Effect.provideService(Scope.Scope, layerScope));
        const connection: OpenCode2ServerConnection = {
          url: server.url,
          password: server.password,
          exitCode: server.exitCode,
          external: false,
        };
        yield* Ref.update(sharedServers, (servers) => {
          const next = new Map(servers);
          next.set(key, { connection, isRunning: server.isRunning });
          return next;
        });
        return connection;
      }),
    );
  };

  const createOpenCode2SdkClient: OpenCode2Runtime["Service"]["createOpenCode2SdkClient"] = (
    input,
  ) =>
    OpenCode.make({
      baseUrl: input.baseUrl,
      headers: {
        "x-opencode-directory": encodeURIComponent(input.directory),
        ...(input.serverPassword.trim().length === 0
          ? {}
          : { Authorization: openCode2AuthorizationHeader(input.serverPassword) }),
      },
    });

  return {
    startOpenCode2ServerProcess,
    connectToOpenCode2Server,
    createOpenCode2SdkClient,
  } satisfies OpenCode2Runtime["Service"];
});

export const layer = Layer.effect(OpenCode2Runtime, make).pipe(Layer.provide(NetService.layer));
