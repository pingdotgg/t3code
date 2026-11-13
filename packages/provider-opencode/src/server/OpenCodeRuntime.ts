import {
  createOpencodeClient,
  type Agent,
  type Command,
  type OpencodeClient,
  type ProviderListResponse,
} from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { isWindowsCommandNotFound } from "@t3tools/provider-core/server/snapshotProbe";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import * as NetService from "@t3tools/shared/Net";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { DEFAULT_HOSTNAME, DEFAULT_OPENCODE_SERVER_TIMEOUT_MS, OPENCODE_SERVER_EXIT_DRAIN_TIMEOUT, OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS, OpenCodeRuntimeError, classifyStartupExit, isOpenCodeRuntimeError, loadOpenCodeCommands, openCodeRuntimeErrorDetail, parseServerUrlFromOutput, resolveOpenCodeConfigContent, resolveOpenCodeServerPassword, runOpenCodeSdk, verifyOpenCodeServerVersion } from "./OpenCodeRuntimePart2.ts";
export type {
  OpenCodeStartupFailureReason,
  ParsedOpenCodeModelSlug,
} from "./OpenCodeRuntimePart2.ts";
export {
  MINIMUM_OPENCODE_VERSION,
  OpenCodeRuntimeError,
  isOpenCodeRuntimeError,
  loadOpenCodeCommands,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  resolveOpenCodeServerPassword,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  verifyOpenCodeServerVersion,
} from "./OpenCodeRuntimePart2.ts";

export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
  readonly commands?: ReadonlyArray<OpenCodeSlashCommand>;
}

export type OpenCodeSlashCommand = Pick<Command, "name" | "description" | "source" | "hints">;

export interface OpenCodeSkill {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
}

export class OpenCodeRuntime extends Context.Service<
  OpenCodeRuntime,
  {
    /** Closing the caller's scope kills the child. */
    readonly startOpenCodeServerProcess: (input: {
      readonly binaryPath: string;
      readonly directory: string;
      readonly serverPassword?: string;
      readonly environment?: NodeJS.ProcessEnv;
      readonly port?: number;
      readonly hostname?: string;
      readonly timeoutMs?: number;
      readonly verify?: (url: string) => Effect.Effect<string, OpenCodeRuntimeError>;
    }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
    readonly connectToOpenCodeServer: (input: {
      readonly binaryPath: string;
      readonly directory: string;
      readonly serverUrl?: string | null;
      readonly serverPassword?: string;
      readonly environment?: NodeJS.ProcessEnv;
      readonly port?: number;
      readonly hostname?: string;
      readonly timeoutMs?: number;
    }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
    readonly runOpenCodeCommand: (input: {
      readonly binaryPath: string;
      readonly args: ReadonlyArray<string>;
      readonly environment?: NodeJS.ProcessEnv;
      readonly cwd?: string;
    }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
    readonly createOpenCodeSdkClient: (input: {
      readonly baseUrl: string;
      readonly directory: string;
      readonly serverPassword?: string;
    }) => OpencodeClient;
    readonly loadOpenCodeInventory: (
      client: OpencodeClient,
    ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
    readonly loadOpenCodeSkills: (
      client: OpencodeClient,
    ) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
  }
>()("@t3tools/provider-opencode/server/OpenCodeRuntime") {}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return isOpenCodeRuntimeError(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcess.Platform;
  const serverLedger = yield* OpenCodeServerLedger.OpenCodeServerLedger;
  const agentScope = yield* AgentScope;
  // npm's Windows shim lets the child escape libuv kill-on-close; run its executable directly.
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, { ...(env ? { env } : {}), bypassNpmShim: true });

  const runOpenCodeCommand: OpenCodeRuntime["Service"]["runOpenCodeCommand"] = Effect.fn(
    "OpenCodeRuntime.runOpenCodeCommand",
  )(
    function* (input) {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                signalProcessGroup(Number(child.pid), "SIGKILL");
              } catch {}
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "runOpenCodeCommand",
            `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
            cause,
          ),
        ),
      ),
  );

  const createOpenCodeSdkClient: OpenCodeRuntime["Service"]["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const startServerAttempt: OpenCodeRuntime["Service"]["startOpenCodeServerProcess"] = Effect.fn(
    "OpenCodeRuntime.startServerAttempt",
  )(function* (input) {
    const runtimeScope = yield* Scope.Scope;

    const hostname = input.hostname ?? DEFAULT_HOSTNAME;
    const port =
      input.port ??
      (yield* netService.findAvailablePort(0).pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      ));
    const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
    const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
    const launch = yield* agentScope.wrap({
      command: input.binaryPath,
      args,
      name: "opencode",
      env: input.environment,
      shared: true,
    });
    const spawnCommand = yield* resolveCommand(launch.command, launch.args, input.environment);
    const serverPassword = resolveOpenCodeServerPassword({
      external: false,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });

    // Scopes close in reverse order. Forking this before the group kill is
    // registered forgets the ledger entry only once the group is stopped.
    const ledgerScope = yield* Scope.fork(runtimeScope);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          env: {
            ...input.environment,
            ...(serverPassword !== undefined ? { OPENCODE_SERVER_PASSWORD: serverPassword } : {}),
            // The value is set explicitly (rather than relying on inheritance) because
            // `extendEnv` is false whenever `input.environment` is provided.
            OPENCODE_CONFIG_CONTENT: resolveOpenCodeConfigContent(input.environment),
          },
          extendEnv: input.environment === undefined,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );

    const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
      hostPlatform === "win32"
        ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
        : Effect.sync(() => {
            try {
              signalProcessGroup(Number(child.pid), signal);
            } catch {}
          });
    const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
      Effect.ignore,
    );
    // Registered before recording, so an interrupt while the ledger writes
    // still stops the group.
    yield* Scope.addFinalizer(runtimeScope, terminateChild);
    const forgetServer = yield* serverLedger.track({ pid: Number(child.pid), port, args });
    yield* Scope.addFinalizer(ledgerScope, forgetServer);

    const stdoutRef = yield* Ref.make<string | null>("");
    const stderrRef = yield* Ref.make<string | null>("");
    const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

    const setReadyFromStdoutChunk = (chunk: string) =>
      Ref.modify(stdoutRef, (stdout) => {
        if (stdout === null) {
          return [null, null] as const;
        }
        const nextStdout = `${stdout}${chunk}`;
        return [
          parseServerUrlFromOutput(nextStdout),
          nextStdout.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
        ] as const;
      }).pipe(
        Effect.flatMap((parsed) =>
          parsed ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore) : Effect.void,
        ),
      );

    const stdoutFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach(setReadyFromStdoutChunk),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );
    const stderrFiber = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderrRef, (stderr) =>
          stderr === null
            ? null
            : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );

    const exitFiber = yield* child.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.gen(function* () {
          // Allow trailing diagnostics to drain, but descendants can keep pipes open.
          const drained = yield* Fiber.joinAll([stdoutFiber, stderrFiber]).pipe(
            Effect.timeoutOption(OPENCODE_SERVER_EXIT_DRAIN_TIMEOUT),
          );
          if (Option.isNone(drained)) {
            yield* Fiber.interruptAll([stdoutFiber, stderrFiber]);
          }
          const stdout = (yield* Ref.get(stdoutRef)) ?? "";
          const stderr = (yield* Ref.get(stderrRef)) ?? "";
          const exitCode = Number(code);
          const reason = classifyStartupExit(stderr);
          yield* Deferred.fail(
            readyDeferred,
            new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              ...(reason ? { reason } : {}),
              detail: [
                `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
              ]
                .filter(Boolean)
                .join("\n\n"),
              cause: { exitCode, stdout, stderr },
            }),
          ).pipe(Effect.ignore);
        }),
      ),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );

    const readyExit = yield* Effect.exit(
      Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
    );

    if (Exit.isFailure(readyExit) || Option.isNone(readyExit.value)) {
      yield* Fiber.interruptAll([stdoutFiber, stderrFiber, exitFiber]).pipe(Effect.ignore);
    }

    if (Exit.isFailure(readyExit)) {
      const squashed = Cause.squash(readyExit.cause);
      return yield* ensureRuntimeError(
        "startOpenCodeServerProcess",
        `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
        squashed,
      );
    }

    const readyOption = readyExit.value;
    if (Option.isNone(readyOption)) {
      return yield* new OpenCodeRuntimeError({
        operation: "startOpenCodeServerProcess",
        detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
      });
    }

    // Keep draining both pipes until the process scope closes. Stopping the
    // readers can block OpenCode when its output buffers fill. Startup output
    // is no longer needed, so discard later output instead of retaining it.
    yield* Ref.set(stdoutRef, null);
    yield* Ref.set(stderrRef, null);

    const url = readyOption.value;
    const version = yield* (
      input.verify?.(url) ??
        verifyOpenCodeServerVersion(
          createOpenCodeSdkClient({
            baseUrl: url,
            directory: input.directory,
            ...(serverPassword !== undefined ? { serverPassword } : {}),
          }),
        )
    );

    return {
      url,
      ...(serverPassword !== undefined ? { serverPassword } : {}),
      version,
      isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
      exitCode: child.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => 0),
      ),
    } satisfies OpenCodeServerProcess;
  });

  const startOpenCodeServerProcess: OpenCodeRuntime["Service"]["startOpenCodeServerProcess"] =
    Effect.fn("OpenCodeRuntime.startOpenCodeServerProcess")(function* (input) {
      const ownerScope = yield* Scope.Scope;
      const attempt = Effect.gen(function* () {
        const attemptScope = yield* Scope.fork(ownerScope);
        return yield* startServerAttempt(input).pipe(
          Effect.provideService(Scope.Scope, attemptScope),
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void,
          ),
        );
      });
      // Shared opencode.db locks are transient; retry those, not configuration/executable errors.
      return yield* attempt.pipe(
        Effect.retry({
          times: 3,
          schedule: Schedule.spaced("250 millis"),
          while: (error) => error.reason === "databaseLocked",
        }),
      );
    });

  const connectToOpenCodeServer: OpenCodeRuntime["Service"]["connectToOpenCodeServer"] = (
    input,
  ) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: serverUrl,
          directory: input.directory,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      ).pipe(
        Effect.map((version) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      directory: input.directory,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", (signal) => client.provider.list(undefined, { signal })).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", (signal) => client.app.agents(undefined, { signal })).pipe(
      Effect.map((result) => result.data ?? []),
      Effect.orElseSucceed((): ReadonlyArray<Agent> => []),
    );

  const loadOpenCodeSkills: OpenCodeRuntime["Service"]["loadOpenCodeSkills"] = (client) =>
    runOpenCodeSdk("app.skills", (signal) => client.app.skills(undefined, { signal })).pipe(
      Effect.map((result) =>
        (result.data ?? []).map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: skill.location,
        })),
      ),
    );
  const loadSkills = (client: OpencodeClient) =>
    loadOpenCodeSkills(client).pipe(Effect.orElseSucceed((): ReadonlyArray<OpenCodeSkill> => []));

  const loadOpenCodeInventory: OpenCodeRuntime["Service"]["loadOpenCodeInventory"] = (client) =>
    Effect.all(
      [
        loadProviders(client),
        loadAgents(client),
        loadSkills(client),
        loadOpenCodeCommands(client).pipe(Effect.orElseSucceed(() => [])),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.map(([providerList, agents, skills, commands]) => ({
        providerList,
        agents,
        skills,
        commands,
      })),
    );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSkills,
  } satisfies OpenCodeRuntime["Service"];
});

export const layer = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
