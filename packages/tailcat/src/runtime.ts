import type {
  TailcatAddress,
  TailcatNodeKey,
  TailcatPathProbe,
  TailcatRuntimeInfo,
  TailcatRuntimeSource,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { decodeTailcatAddress, isTailcatNodeKey } from "./address.ts";
import {
  TailcatAddressInvalidError,
  TailcatBinaryMissingError,
  TailcatBinaryNotExecutableError,
  TailcatCommandError,
  TailcatPortInUseError,
  TailcatStartupError,
  TailcatTimeoutError,
  TailcatVersionIncompatibleError,
  redactTailcatOutputLine,
} from "./errors.ts";
import {
  TAILCAT_COMPATIBLE_RANGE,
  TAILCAT_PINNED_VERSION,
  isCompatibleTailcatVersion,
  normalizeTailcatVersion,
  tailcatExecutableName,
  tailcatPlatformKey,
} from "./manifest.ts";

/**
 * TailcatRuntime owns every interaction with the `tailcat` executable:
 * resolving which binary to run, checking its version, generating identities,
 * serving a local port, forwarding to a remote server, and probing the path.
 * Callers never see argv or child-process handles; they get typed handles whose
 * lifetime is a Scope, so a closed scope always means a dead process.
 */

export const TAILCAT_SERVE_READY_TIMEOUT = Duration.seconds(30);
export const TAILCAT_FORWARD_LISTEN_TIMEOUT = Duration.seconds(10);
export const TAILCAT_COMMAND_TIMEOUT = Duration.seconds(15);
export const TAILCAT_PING_DEFAULT_TIMEOUT = Duration.seconds(8);
export const TAILCAT_PROCESS_STOP_GRACE = Duration.seconds(2);
export const TAILCAT_RECENT_OUTPUT_LINES = 40;

export type TailcatAllowPolicy =
  | { readonly _tag: "all" }
  | { readonly _tag: "none" }
  | { readonly _tag: "keys"; readonly nodeKeys: ReadonlyArray<TailcatNodeKey> };

export interface TailcatExecutableResolution {
  /** Explicit developer override (`T3CODE_TAILCAT_BINARY`), checked first. */
  readonly overridePath?: string | undefined;
  /** Bundled candidates in preference order (packaged resources, dev staging). */
  readonly bundledCandidates: ReadonlyArray<string>;
  /** Whether a `tailcat` found on PATH is acceptable. */
  readonly allowSystem: boolean;
}

export interface TailcatProcessHandle {
  readonly pid: number;
  /** Resolves when the process exits, with its exit code when known. */
  readonly exit: Effect.Effect<Option.Option<number>>;
  readonly isRunning: Effect.Effect<boolean>;
  readonly recentOutput: Effect.Effect<ReadonlyArray<string>>;
  /** Terminates the process. Closing the owning scope does the same. */
  readonly stop: Effect.Effect<void>;
}

export interface TailcatServeHandle extends TailcatProcessHandle {
  readonly address: TailcatAddress;
  readonly localPort: number;
  readonly allow: TailcatAllowPolicy;
}

export interface TailcatForwardHandle extends TailcatProcessHandle {
  readonly address: TailcatAddress;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type TailcatResolveError =
  | TailcatBinaryMissingError
  | TailcatBinaryNotExecutableError
  | TailcatVersionIncompatibleError
  | TailcatCommandError;

export type TailcatServeError =
  | TailcatResolveError
  | TailcatStartupError
  | TailcatTimeoutError
  | TailcatPortInUseError;

export type TailcatForwardError =
  | TailcatResolveError
  | TailcatAddressInvalidError
  | TailcatStartupError
  | TailcatTimeoutError
  | TailcatPortInUseError;

export type TailcatIdentityError = TailcatResolveError | TailcatAddressInvalidError;

export type TailcatPingError =
  | TailcatResolveError
  | TailcatAddressInvalidError
  | TailcatCommandError;

export class TailcatRuntime extends Context.Service<
  TailcatRuntime,
  {
    /** Resolves and version-checks the executable. Cached until `refresh`. */
    readonly resolve: Effect.Effect<TailcatRuntimeInfo, TailcatResolveError>;
    readonly refresh: Effect.Effect<TailcatRuntimeInfo, TailcatResolveError>;
    /** Creates a server identity file (0600) and returns its stable address. */
    readonly generateServerIdentity: (options: {
      readonly keyPath: string;
    }) => Effect.Effect<{ readonly address: TailcatAddress }, TailcatIdentityError>;
    /** Creates a client identity file (0600) and returns its public node key. */
    readonly generateClientIdentity: (options: {
      readonly keyPath: string;
    }) => Effect.Effect<{ readonly nodeKey: TailcatNodeKey }, TailcatIdentityError>;
    readonly readClientPublicKey: (options: {
      readonly keyPath: string;
    }) => Effect.Effect<TailcatNodeKey, TailcatIdentityError>;
    /** Exposes a local port; the process lives as long as the current Scope. */
    readonly serve: (options: {
      readonly keyPath: string;
      readonly localPort: number;
      readonly allow: TailcatAllowPolicy;
    }) => Effect.Effect<TailcatServeHandle, TailcatServeError, Scope.Scope>;
    /**
     * Forwards a reserved loopback port to a remote port. Resolves once the
     * local listener accepts and `readiness` (if given) succeeds through it.
     */
    readonly forward: <E = never>(options: {
      readonly keyPath: string | null;
      readonly address: string;
      readonly remotePort: number;
      readonly localPort: number;
      readonly readiness?: (endpoint: { readonly httpBaseUrl: string }) => Effect.Effect<void, E>;
      readonly readinessTimeout?: Duration.Input;
    }) => Effect.Effect<TailcatForwardHandle, TailcatForwardError | E, Scope.Scope>;
    /** One disco ping: direct path or relay, and latency. */
    readonly ping: (options: {
      readonly keyPath: string | null;
      readonly address: string;
      readonly timeout?: Duration.Input;
    }) => Effect.Effect<TailcatPathProbe, TailcatPingError>;
  }
>()("@t3tools/tailcat/runtime/TailcatRuntime") {}

const ServeListenAddrJson = Schema.fromJsonString(Schema.Struct({ listenAddr: Schema.String }));
const decodeServeListenAddr = Schema.decodeUnknownOption(ServeListenAddrJson);

interface OutputBuffer {
  readonly push: (line: string) => Effect.Effect<void>;
  readonly lines: Effect.Effect<ReadonlyArray<string>>;
}

const makeOutputBuffer = Effect.fn("TailcatRuntime.makeOutputBuffer")(function* () {
  const ref = yield* Ref.make<ReadonlyArray<string>>([]);
  return {
    push: (line: string) =>
      Ref.update(ref, (lines) => {
        const next = [...lines, redactTailcatOutputLine(line)];
        return next.length > TAILCAT_RECENT_OUTPUT_LINES
          ? next.slice(next.length - TAILCAT_RECENT_OUTPUT_LINES)
          : next;
      }),
    lines: Ref.get(ref),
  } satisfies OutputBuffer;
});

const lineStream = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.map((line) => line.trimEnd()),
    Stream.filter((line) => line.length > 0),
  );

/** Parses Go duration text (`280µs`, `127.25ms`, `1.2s`) into milliseconds. */
export function parseGoDurationMs(text: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(ns|µs|us|ms|s|m|h)$/u.exec(text.trim());
  if (!match) {
    return null;
  }
  const value = Number.parseFloat(match[1]!);
  switch (match[2]) {
    case "ns":
      return value / 1_000_000;
    case "µs":
    case "us":
      return value / 1_000;
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return null;
  }
}

/** Parses one `tailcat ping` pong line into a path probe. */
export function parseTailcatPong(line: string, measuredAt: string): TailcatPathProbe | null {
  const match = /^pong in (\S+) via (.+)$/u.exec(line.trim());
  if (!match) {
    return null;
  }
  const via = match[2]!.trim();
  const latencyMs = parseGoDurationMs(match[1]!);
  const relay = /^DERP\((.*)\)$/u.exec(via);
  return {
    kind: relay ? "relay" : "direct",
    via: relay ? relay[1]!.trim() || null : via,
    latencyMs,
    measuredAt,
  };
}

export function tailcatAllowFlag(policy: TailcatAllowPolicy): ReadonlyArray<string> {
  switch (policy._tag) {
    case "all":
      return [];
    case "none":
      return ["--allow=none"];
    case "keys":
      return policy.nodeKeys.length === 0
        ? ["--allow=none"]
        : [`--allow=${policy.nodeKeys.join(",")}`];
  }
}

const isPortInUseOutput = (lines: ReadonlyArray<string>): boolean =>
  lines.some((line) =>
    /address already in use|EADDRINUSE|Only one usage of each socket/iu.test(line),
  );

const isNotFoundSpawnError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  ((cause as { code?: unknown }).code === "ENOENT" ||
    (cause as { code?: unknown }).code === "EACCES");

export interface TailcatRuntimeLayerOptions {
  readonly resolution: TailcatExecutableResolution;
}

type RuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | NetService.NetService;

export const make = Effect.fn("TailcatRuntime.make")(function* (
  options: TailcatRuntimeLayerOptions,
): Effect.fn.Return<TailcatRuntime["Service"], never, RuntimeServices> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const executableName = tailcatExecutableName(platform);

  const findOnPath = Effect.fn("TailcatRuntime.findOnPath")(function* () {
    const pathEntries = (environment.PATH ?? environment.Path ?? "")
      .split(platform === "win32" ? ";" : ":")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const names =
      platform === "win32"
        ? [
            executableName,
            ...(environment.PATHEXT ?? "")
              .split(";")
              .filter(Boolean)
              .map((ext) => `tailcat${ext.toLowerCase()}`),
          ]
        : [executableName];
    for (const entry of pathEntries) {
      for (const name of names) {
        const candidate = path.join(entry, name);
        const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
        if (exists) {
          return Option.some(candidate);
        }
      }
    }
    return Option.none<string>();
  });

  const checkExecutable = Effect.fn("TailcatRuntime.checkExecutable")(function* (
    candidate: string,
  ): Effect.fn.Return<boolean, TailcatBinaryNotExecutableError> {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isSome(stat) && (stat.value.mode & 0o111) === 0) {
      return yield* new TailcatBinaryNotExecutableError({
        path: candidate,
        detail: `The Tailcat runtime at ${candidate} is not executable. Reinstall T3 Code or run chmod +x on it.`,
      });
    }
    return true;
  });

  const runCommand = Effect.fn("TailcatRuntime.runCommand")(function* (input: {
    readonly executablePath: string;
    readonly args: ReadonlyArray<string>;
    readonly subcommand: string;
    readonly timeout?: Duration.Input;
  }): Effect.fn.Return<
    { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
    TailcatCommandError
  > {
    const timeout = Duration.fromInputUnsafe(input.timeout ?? TAILCAT_COMMAND_TIMEOUT);
    return yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.executablePath, input.args, {
          stdin: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: TAILCAT_PROCESS_STOP_GRACE,
        }),
      );
      const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TailcatCommandError({
            subcommand: input.subcommand,
            exitCode: null,
            detail: isNotFoundSpawnError(cause)
              ? `The Tailcat runtime at ${input.executablePath} could not be started.`
              : `tailcat ${input.subcommand} failed to run.`,
            cause,
          }),
      ),
      Effect.catchDefect((cause) =>
        Effect.fail(
          new TailcatCommandError({
            subcommand: input.subcommand,
            exitCode: null,
            detail: `The Tailcat runtime at ${input.executablePath} could not be started.`,
            cause,
          }),
        ),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new TailcatCommandError({
              subcommand: input.subcommand,
              exitCode: null,
              detail: `tailcat ${input.subcommand} did not finish within ${Duration.toMillis(timeout)}ms.`,
            }),
          ),
      }),
    );
  });

  const readVersion = Effect.fn("TailcatRuntime.readVersion")(function* (
    executablePath: string,
  ): Effect.fn.Return<string, TailcatCommandError> {
    const result = yield* runCommand({ executablePath, args: ["version"], subcommand: "version" });
    const version = normalizeTailcatVersion(result.stdout);
    if (result.exitCode !== 0 || version === null) {
      return yield* new TailcatCommandError({
        subcommand: "version",
        exitCode: result.exitCode,
        detail: `The Tailcat runtime at ${executablePath} did not report a version.`,
      });
    }
    return version;
  });

  const resolveUncached = Effect.fn("TailcatRuntime.resolve")(function* (): Effect.fn.Return<
    TailcatRuntimeInfo,
    TailcatResolveError
  > {
    const candidates: Array<{ readonly path: string; readonly source: TailcatRuntimeSource }> = [];
    const override = options.resolution.overridePath?.trim();
    if (override) {
      candidates.push({ path: override, source: "override" });
    }
    for (const candidate of options.resolution.bundledCandidates) {
      candidates.push({ path: candidate, source: "bundled" });
    }
    if (options.resolution.allowSystem) {
      const onPath = yield* findOnPath();
      if (Option.isSome(onPath)) {
        candidates.push({ path: onPath.value, source: "system" });
      }
    }

    for (const candidate of candidates) {
      if (!(yield* checkExecutable(candidate.path))) {
        if (candidate.source === "override") {
          return yield* new TailcatBinaryMissingError({
            candidates: [candidate.path],
            detail: `T3CODE_TAILCAT_BINARY points at ${candidate.path}, which does not exist.`,
          });
        }
        continue;
      }
      const version = yield* readVersion(candidate.path);
      const compatible = isCompatibleTailcatVersion(version);
      if (!compatible) {
        return yield* new TailcatVersionIncompatibleError({
          path: candidate.path,
          version,
          compatibleRange: TAILCAT_COMPATIBLE_RANGE,
          detail: `Tailcat ${version} at ${candidate.path} is not compatible with this T3 Code build, which expects ${TAILCAT_COMPATIBLE_RANGE} (bundled ${TAILCAT_PINNED_VERSION}).`,
        });
      }
      return {
        executablePath: candidate.path,
        source: candidate.source,
        version,
        pinnedVersion: TAILCAT_PINNED_VERSION,
        compatible,
      };
    }

    const platformKey = tailcatPlatformKey(platform, architecture);
    return yield* new TailcatBinaryMissingError({
      candidates: candidates.map((candidate) => candidate.path),
      detail:
        platformKey === undefined
          ? `Tailcat is not available for ${platform}/${architecture}.`
          : "The Tailcat runtime is not available. Reinstall T3 Code, or install tailcat and set T3CODE_TAILCAT_BINARY.",
    });
  });

  const cache = yield* SynchronizedRef.make<Option.Option<TailcatRuntimeInfo>>(Option.none());
  const resolve: TailcatRuntime["Service"]["resolve"] = SynchronizedRef.modifyEffect(
    cache,
    (cached) =>
      Option.isSome(cached)
        ? Effect.succeed([cached.value, cached] as const)
        : resolveUncached().pipe(Effect.map((info) => [info, Option.some(info)] as const)),
  );
  const refresh: TailcatRuntime["Service"]["refresh"] = SynchronizedRef.set(
    cache,
    Option.none(),
  ).pipe(Effect.andThen(resolve));

  const requireAddress = (raw: string) =>
    Effect.gen(function* () {
      const decoded = decodeTailcatAddress(raw);
      if (Result.isFailure(decoded)) {
        return yield* decoded.failure;
      }
      return raw.trim() as TailcatAddress;
    });

  const generateServerIdentity: TailcatRuntime["Service"]["generateServerIdentity"] = Effect.fn(
    "TailcatRuntime.generateServerIdentity",
  )(function* ({ keyPath }) {
    const runtime = yield* resolve;
    yield* fileSystem.makeDirectory(path.dirname(keyPath), { recursive: true }).pipe(Effect.ignore);
    // A fixed region bakes the DERP bootstrap region into the address, so the
    // address stays stable across restarts instead of changing with whichever
    // relay happens to be nearest at each start.
    const result = yield* runCommand({
      executablePath: runtime.executablePath,
      args: ["genkey", `--key=${keyPath}`, "--fixed-region", "--force"],
      subcommand: "genkey",
      timeout: TAILCAT_SERVE_READY_TIMEOUT,
    });
    const lines = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const address = lines.find((line) => line.startsWith("tc"));
    if (result.exitCode !== 0 || address === undefined) {
      return yield* new TailcatCommandError({
        subcommand: "genkey",
        exitCode: result.exitCode,
        detail: `Could not create a Tailcat identity: ${redactTailcatOutputLine(result.stderr.trim()) || "tailcat genkey failed"}.`,
      });
    }
    yield* fileSystem.chmod(keyPath, 0o600).pipe(Effect.ignore);
    return { address: yield* requireAddress(address) };
  });

  const generateClientIdentity: TailcatRuntime["Service"]["generateClientIdentity"] = Effect.fn(
    "TailcatRuntime.generateClientIdentity",
  )(function* ({ keyPath }) {
    const runtime = yield* resolve;
    yield* fileSystem.makeDirectory(path.dirname(keyPath), { recursive: true }).pipe(Effect.ignore);
    const result = yield* runCommand({
      executablePath: runtime.executablePath,
      args: ["genkey", "--client", `--key=${keyPath}`, "--force"],
      subcommand: "genkey",
    });
    const nodeKey = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(isTailcatNodeKey);
    if (result.exitCode !== 0 || nodeKey === undefined) {
      return yield* new TailcatCommandError({
        subcommand: "genkey",
        exitCode: result.exitCode,
        detail: `Could not create a Tailcat client identity: ${redactTailcatOutputLine(result.stderr.trim()) || "tailcat genkey failed"}.`,
      });
    }
    yield* fileSystem.chmod(keyPath, 0o600).pipe(Effect.ignore);
    return { nodeKey };
  });

  const readClientPublicKey: TailcatRuntime["Service"]["readClientPublicKey"] = Effect.fn(
    "TailcatRuntime.readClientPublicKey",
  )(function* ({ keyPath }) {
    const runtime = yield* resolve;
    // `printpub` silently mints an ephemeral key when the file is missing, which
    // would trust a key nobody holds. Refuse instead.
    const exists = yield* fileSystem.exists(keyPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* new TailcatCommandError({
        subcommand: "printpub",
        exitCode: null,
        detail: `The Tailcat client identity at ${keyPath} does not exist.`,
      });
    }
    const result = yield* runCommand({
      executablePath: runtime.executablePath,
      args: [`--key=${keyPath}`, "printpub"],
      subcommand: "printpub",
    });
    const nodeKey = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(isTailcatNodeKey);
    if (result.exitCode !== 0 || nodeKey === undefined) {
      return yield* new TailcatCommandError({
        subcommand: "printpub",
        exitCode: result.exitCode,
        detail: "Could not read the Tailcat client identity.",
      });
    }
    return nodeKey;
  });

  interface SpawnedProcess {
    readonly handle: ChildProcessSpawner.ChildProcessHandle;
    readonly output: OutputBuffer;
    readonly exited: Deferred.Deferred<Option.Option<number>>;
    readonly stdoutLines: Stream.Stream<string>;
  }

  /**
   * Spawns a long-running tailcat process bound to the current Scope. Stderr is
   * drained into the bounded output buffer; stdout is exposed as a line stream
   * for the caller to consume (serve's JSON), and also mirrored into the buffer.
   */
  const spawnLongRunning = Effect.fn("TailcatRuntime.spawnLongRunning")(function* (input: {
    readonly executablePath: string;
    readonly args: ReadonlyArray<string>;
    readonly subcommand: "serve" | "forward";
  }): Effect.fn.Return<SpawnedProcess, TailcatStartupError, Scope.Scope> {
    const output = yield* makeOutputBuffer();
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(input.executablePath, input.args, {
          stdin: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: TAILCAT_PROCESS_STOP_GRACE,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new TailcatStartupError({
              subcommand: input.subcommand,
              exitCode: null,
              recentOutput: [],
              detail: `Could not start tailcat ${input.subcommand}.`,
              cause,
            }),
        ),
        Effect.catchDefect((cause) =>
          Effect.fail(
            new TailcatStartupError({
              subcommand: input.subcommand,
              exitCode: null,
              recentOutput: [],
              detail: `Could not start tailcat ${input.subcommand}.`,
              cause,
            }),
          ),
        ),
      );
    const exited = yield* Deferred.make<Option.Option<number>>();
    yield* lineStream(handle.stderr).pipe(
      Stream.runForEach(output.push),
      Effect.ignore,
      Effect.forkScoped,
    );
    yield* handle.exitCode.pipe(
      Effect.map((code) => Option.some(Number(code))),
      Effect.orElseSucceed(() => Option.none<number>()),
      Effect.flatMap((code) => Deferred.succeed(exited, code)),
      Effect.forkScoped,
    );
    const stdoutLines = lineStream(handle.stdout).pipe(
      Stream.tap(output.push),
      Stream.catch(() => Stream.empty),
    );
    return { handle, output, exited, stdoutLines };
  });

  const processHandle = (spawned: SpawnedProcess): TailcatProcessHandle => ({
    pid: Number(spawned.handle.pid),
    exit: Deferred.await(spawned.exited),
    isRunning: spawned.handle.isRunning.pipe(Effect.orElseSucceed(() => false)),
    recentOutput: spawned.output.lines,
    stop: spawned.handle
      .kill({ killSignal: "SIGTERM", forceKillAfter: TAILCAT_PROCESS_STOP_GRACE })
      .pipe(Effect.ignore),
  });

  const serve: TailcatRuntime["Service"]["serve"] = Effect.fn("TailcatRuntime.serve")(function* ({
    keyPath,
    localPort,
    allow,
  }) {
    const runtime = yield* resolve;
    const args = [
      "--json",
      `--key=${keyPath}`,
      "serve",
      ...tailcatAllowFlag(allow),
      String(localPort),
    ];
    const spawned = yield* spawnLongRunning({
      executablePath: runtime.executablePath,
      args,
      subcommand: "serve",
    });
    const firstJsonLine = spawned.stdoutLines.pipe(
      Stream.map((line) => decodeServeListenAddr(line)),
      Stream.filter(Option.isSome),
      Stream.map((line) => line.value.listenAddr),
      Stream.runHead,
    );
    const settled = yield* Effect.raceFirst(
      firstJsonLine.pipe(Effect.map((address) => ({ _tag: "address" as const, address }))),
      Deferred.await(spawned.exited).pipe(
        Effect.map((exitCode) => ({ _tag: "exited" as const, exitCode })),
      ),
    ).pipe(Effect.timeoutOption(TAILCAT_SERVE_READY_TIMEOUT));
    // The race must settle before the kill: killing inside a `timeoutOrElse`
    // fallback lets the exit branch win and reports a crash, not a timeout.
    if (Option.isNone(settled)) {
      yield* spawned.handle
        .kill({ killSignal: "SIGTERM", forceKillAfter: TAILCAT_PROCESS_STOP_GRACE })
        .pipe(Effect.ignore);
      return yield* new TailcatTimeoutError({
        subcommand: "serve",
        timeoutMs: Duration.toMillis(TAILCAT_SERVE_READY_TIMEOUT),
        detail:
          "Tailcat did not publish an address in time. Check that this machine can reach the internet.",
      });
    }
    const ready = settled.value;
    const recentOutput = yield* spawned.output.lines;
    if (ready._tag === "exited" || Option.isNone(ready.address)) {
      const exitCode = ready._tag === "exited" ? Option.getOrNull(ready.exitCode) : null;
      if (isPortInUseOutput(recentOutput)) {
        return yield* new TailcatPortInUseError({
          port: localPort,
          detail: `Port ${localPort} is already in use.`,
        });
      }
      return yield* new TailcatStartupError({
        subcommand: "serve",
        exitCode,
        recentOutput,
        detail:
          recentOutput.at(-1) !== undefined
            ? `Tailcat could not start serving: ${recentOutput.at(-1)}`
            : "Tailcat exited before it published an address.",
      });
    }
    const address = yield* requireAddress(ready.address.value).pipe(
      Effect.mapError(
        (error) =>
          new TailcatStartupError({
            subcommand: "serve",
            exitCode: null,
            recentOutput,
            detail: `Tailcat published an address T3 could not decode: ${error.detail}`,
          }),
      ),
    );
    return {
      ...processHandle(spawned),
      address,
      localPort,
      allow,
    } satisfies TailcatServeHandle;
  });

  const waitForLocalListener = Effect.fn("TailcatRuntime.waitForLocalListener")(function* (
    localPort: number,
  ) {
    yield* Effect.gen(function* () {
      const listening = yield* net.hasListenerOnHost(localPort, "127.0.0.1");
      if (!listening) {
        return yield* Effect.fail("not-listening" as const);
      }
    }).pipe(
      Effect.retry(
        Schedule.spaced(Duration.millis(50)).pipe(
          Schedule.upTo({ duration: TAILCAT_FORWARD_LISTEN_TIMEOUT }),
        ),
      ),
    );
  });

  const forward: TailcatRuntime["Service"]["forward"] = Effect.fn("TailcatRuntime.forward")(
    function* (input) {
      const runtime = yield* resolve;
      const address = yield* requireAddress(input.address);
      const args = [
        ...(input.keyPath === null ? [] : [`--key=${input.keyPath}`]),
        "forward",
        address,
        `${input.localPort}:${input.remotePort}`,
      ];
      const spawned = yield* spawnLongRunning({
        executablePath: runtime.executablePath,
        args,
        subcommand: "forward",
      });
      const httpBaseUrl = `http://127.0.0.1:${input.localPort}/`;
      const wsBaseUrl = `ws://127.0.0.1:${input.localPort}/`;
      const readinessTimeout = Duration.fromInputUnsafe(
        input.readinessTimeout ?? TAILCAT_SERVE_READY_TIMEOUT,
      );
      const becomeReady = Effect.gen(function* () {
        yield* waitForLocalListener(input.localPort);
        if (input.readiness !== undefined) {
          yield* input.readiness({ httpBaseUrl });
        }
        return { _tag: "ready" as const };
      });
      const settled = yield* Effect.raceFirst(
        becomeReady,
        Deferred.await(spawned.exited).pipe(
          Effect.map((exitCode) => ({ _tag: "exited" as const, exitCode })),
        ),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // A failed readiness probe or listen timeout must not leave a
            // forwarder behind: the process is owned by this attempt.
            yield* spawned.handle
              .kill({ killSignal: "SIGTERM", forceKillAfter: TAILCAT_PROCESS_STOP_GRACE })
              .pipe(Effect.ignore);
            if (error === "not-listening") {
              const recentOutput = yield* spawned.output.lines;
              return yield* new TailcatStartupError({
                subcommand: "forward",
                exitCode: null,
                recentOutput,
                detail: "Tailcat did not open the local forwarding port.",
              });
            }
            return yield* Effect.fail(error);
          }),
        ),
        Effect.timeoutOption(readinessTimeout),
      );
      // The race must settle before the kill: killing inside a `timeoutOrElse`
      // fallback lets the exit branch win and reports a crash, not a timeout.
      if (Option.isNone(settled)) {
        yield* spawned.handle
          .kill({ killSignal: "SIGTERM", forceKillAfter: TAILCAT_PROCESS_STOP_GRACE })
          .pipe(Effect.ignore);
        return yield* new TailcatTimeoutError({
          subcommand: "forward",
          timeoutMs: Duration.toMillis(readinessTimeout),
          detail:
            "The remote machine did not answer through the Tailcat tunnel in time. It may be offline, or this device may not be trusted by it.",
        });
      }
      const outcome = settled.value;
      if (outcome._tag === "exited") {
        const recentOutput = yield* spawned.output.lines;
        if (isPortInUseOutput(recentOutput)) {
          return yield* new TailcatPortInUseError({
            port: input.localPort,
            detail: `Local port ${input.localPort} is already in use.`,
          });
        }
        return yield* new TailcatStartupError({
          subcommand: "forward",
          exitCode: Option.getOrNull(outcome.exitCode),
          recentOutput,
          detail:
            recentOutput.at(-1) !== undefined
              ? `Tailcat could not start forwarding: ${recentOutput.at(-1)}`
              : "Tailcat exited before the local forwarding port was ready.",
        });
      }
      return {
        ...processHandle(spawned),
        address,
        remotePort: input.remotePort,
        localPort: input.localPort,
        httpBaseUrl,
        wsBaseUrl,
      } satisfies TailcatForwardHandle;
    },
  );

  const ping: TailcatRuntime["Service"]["ping"] = Effect.fn("TailcatRuntime.ping")(
    function* (input) {
      const runtime = yield* resolve;
      const address = yield* requireAddress(input.address);
      const timeout = Duration.fromInputUnsafe(input.timeout ?? TAILCAT_PING_DEFAULT_TIMEOUT);
      const timeoutSeconds = Math.max(1, Math.ceil(Duration.toMillis(timeout) / 1000));
      const result = yield* runCommand({
        executablePath: runtime.executablePath,
        args: [
          ...(input.keyPath === null ? [] : [`--key=${input.keyPath}`]),
          "ping",
          `--timeout=${timeoutSeconds}s`,
          address,
        ],
        subcommand: "ping",
        timeout: Duration.millis(Duration.toMillis(timeout) + 5_000),
      });
      const measuredAt = DateTime.formatIso(yield* DateTime.now);
      const pong = result.stdout
        .split(/\r?\n/u)
        .map((line) => parseTailcatPong(line, measuredAt))
        .find((probe) => probe !== null);
      if (pong === undefined || pong === null) {
        return yield* new TailcatCommandError({
          subcommand: "ping",
          exitCode: result.exitCode,
          detail:
            result.exitCode === 0
              ? "Tailcat ping returned no result."
              : "The remote machine did not answer the Tailcat ping. It may be offline, or this device may not be trusted by it.",
        });
      }
      return pong;
    },
  );

  return TailcatRuntime.of({
    resolve,
    refresh,
    generateServerIdentity,
    generateClientIdentity,
    readClientPublicKey,
    serve,
    forward,
    ping,
  });
});

export const layer = (options: TailcatRuntimeLayerOptions) =>
  Layer.effect(TailcatRuntime, make(options));

/**
 * Bundled binary locations relative to a module directory, matching how the
 * resource monitor is staged: a `tailcat/<platform-key>/` directory next to the
 * bundle, a flat `tailcat/` directory, and the monorepo's `native/tailcat/dist`.
 */
export function bundledTailcatCandidates(input: {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly joinPath: (...segments: ReadonlyArray<string>) => string;
  readonly moduleDirectory: string;
  readonly repoRootCandidates?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const platformKey = tailcatPlatformKey(input.platform, input.architecture);
  if (platformKey === undefined) {
    return [];
  }
  const executable = tailcatExecutableName(input.platform);
  const candidates = [
    input.joinPath(input.moduleDirectory, "tailcat", platformKey, executable),
    input.joinPath(input.moduleDirectory, "tailcat", executable),
    input.joinPath(input.moduleDirectory, "..", "tailcat", executable),
  ];
  for (const repoRoot of input.repoRootCandidates ?? []) {
    candidates.push(input.joinPath(repoRoot, "native", "tailcat", "dist", platformKey, executable));
  }
  return candidates;
}

export const TAILCAT_BINARY_OVERRIDE_ENV = "T3CODE_TAILCAT_BINARY";

/** Reads the developer override from the host environment. */
export const tailcatOverridePathFromEnvironment = Effect.map(HostProcessEnvironment, (env) => {
  const value = env[TAILCAT_BINARY_OVERRIDE_ENV]?.trim();
  return value && value.length > 0 ? value : undefined;
});
