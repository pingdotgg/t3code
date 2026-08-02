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
 *      always mints a password, prints it on stdout beside the URL, and 401s
 *      without it. So startup has to resolve *two* facts, not one.
 *   3. **Route surface.** 2.x serves only `/api/*`. The SDK is versioned to
 *      match and is pinned here under the `@opencode-ai/sdk-next` alias, since
 *      two majors of one package name cannot coexist. Its `client.v2.*`
 *      namespace is the `/api/*` one; `client.session.*` is the legacy surface
 *      and 404s against a 2.x server.
 *
 * `live-scenarios/tests/opencode2-drive-probe.mjs` in the parent workspace
 * exercises this contract against a real binary and fails first if 2.x moves.
 * Spawned-server lifetime is guaranteed by the scope finalizer's process-group
 * kill, which returns immediately when the group is gone and escalates after
 * 500ms when descendants remain, plus the stdin-EOF watchdog sidecar that
 * reaps on confirmed parent death. If many sessions tear down sequentially and
 * overrun the desktop's 2-second grace, the sidecar still reaps the remainder
 * via pipe EOF.
 */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk-next/v2";
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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { openCodeRuntimeErrorDetail } from "./opencodeRuntime.ts";
import * as SpawnedProcessReaper from "./SpawnedProcessReaper.ts";

const DEFAULT_OPENCODE2_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const MAX_OPENCODE2_STARTUP_OUTPUT_CHARS = 16_384;
const OPENCODE2_STARTUP_DRAIN_TIMEOUT = "100 millis";
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
  "mcp.list",
  "message.list",
  "model.list",
  "session.compact",
  "session.create",
  "session.form.reply",
  "session.fork",
  "session.generate",
  "session.get",
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

function openCode2SdkErrorCategoryFromText(
  cause: unknown,
): Extract<
  OpenCode2RuntimeErrorCategory,
  "authentication-failed" | "model-unavailable" | "network-failed" | "sdk-request-failed"
> {
  const detail = openCodeRuntimeErrorDetail(cause).toLowerCase();
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

/** Both facts the 2.x startup banner carries. Neither is optional. */
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
     * Connect to an externally-managed server, or spawn one. An external server
     * must carry its own password: 2.x has no unauthenticated mode, so there is
     * nothing to fall back to.
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
    }) => OpencodeClient;
  }
>()("t3/provider/opencode2Runtime") {}

/**
 * Read the URL and password out of accumulated server output.
 *
 * Returns `null` until *both* are present: they arrive on separate lines and a
 * chunked read can see one without the other, and a client built without the
 * password gets 401 on every call. Deliberately not anchored to line start —
 * 2.x has changed the surrounding banner text before.
 *
 * @internal exported for tests
 */
export function parseOpenCode2Startup(output: string): OpenCode2ServerCredentials | null {
  const url = output.match(/server listening on\s+(https?:\/\/\S+)/)?.[1];
  const password = output.match(/server password\s+(\S+)/)?.[1];
  return url && password ? { url, password } : null;
}

/** The header the 2.x server checks. Username is fixed; only the password varies. */
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

export const make = Effect.gen(function* () {
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
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE2_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);

      const spawnOpenCode2Server = spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            ...(input.environment === undefined ? {} : { env: input.environment }),
            extendEnv: input.environment === undefined,
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
      );
      yield* reaper.track({
        pid: processId,
        pgid: hostPlatform === "win32" ? null : processId,
        platform: hostPlatform === "win32" ? "win32" : "posix",
      });
      const startupOutputRef = yield* Ref.make<{
        readonly output: string | null;
        readonly password: string | null;
        readonly url: string | null;
        readonly failureCategory: OpenCode2RuntimeErrorCategory | null;
      }>({ output: "", password: null, url: null, failureCategory: null });
      const readyDeferred = yield* Deferred.make<
        OpenCode2ServerCredentials,
        OpenCode2RuntimeError
      >();

      // The banner is two lines and the split between them lands wherever the
      // pipe happens to break. Keep a bounded parser buffer only until both
      // startup facts are found, then continue draining without retaining logs.
      const absorb = (chunk: string) =>
        Ref.modify(startupOutputRef, (previous) => {
          if (previous.output === null) return [null, previous] as const;
          const combined = `${previous.output}${chunk}`;
          const url =
            previous.url ?? combined.match(/server listening on\s+(https?:\/\/\S+)/)?.[1] ?? null;
          const password =
            previous.password ?? combined.match(/server password\s+(\S+)/)?.[1] ?? null;
          const parsed = url !== null && password !== null ? { url, password } : null;
          const output = combined.slice(-MAX_OPENCODE2_STARTUP_OUTPUT_CHARS);
          const category = openCode2ExecutableErrorCategoryFromText(combined);
          return [
            parsed,
            {
              output: parsed === null ? output : null,
              password,
              url,
              failureCategory:
                category === "server-spawn-failed" ? previous.failureCategory : category,
            },
          ] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed === null
              ? Effect.void
              : Deferred.succeed(readyDeferred, parsed).pipe(Effect.asVoid),
          ),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(absorb),
        Effect.ignore,
        Effect.forkIn(processScope),
      );
      // 2.x has printed the banner to stderr across builds, so watch both.
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach(absorb),
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

    return startOpenCode2ServerProcess({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        password: server.password,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const createOpenCode2SdkClient: OpenCode2Runtime["Service"]["createOpenCode2SdkClient"] = (
    input,
  ) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      headers: { Authorization: openCode2AuthorizationHeader(input.serverPassword) },
      throwOnError: true,
    });

  return {
    startOpenCode2ServerProcess,
    connectToOpenCode2Server,
    createOpenCode2SdkClient,
  } satisfies OpenCode2Runtime["Service"];
});

export const layer = Layer.effect(OpenCode2Runtime, make).pipe(Layer.provide(NetService.layer));
