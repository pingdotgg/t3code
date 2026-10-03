// @effect-diagnostics nodeBuiltinImport:off - spawns the Docker CLI for long-lived relays and sync exec plans.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  SandboxListStreamEvent,
  SandboxStatus,
  SandboxSummary,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  dockerExecArgs,
  dockerRunArgs,
  isMountablePath,
  preferredSandboxHostPort,
  SANDBOX_DOCKERFILE,
  SANDBOX_LABELS,
  type SandboxCliVersions,
  type SandboxMount,
  sandboxContainerName,
  sandboxEnvNames,
  sandboxImageBuildArgs,
  sandboxImageTag,
  sandboxOwner,
} from "./sandboxDocker.ts";
import { SANDBOX_KILL_SOURCE, SANDBOX_RELAY_SOURCE, SandboxTunnel } from "./SandboxTunnel.ts";

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  operation: Schema.Literals(["create", "start", "exec", "stop", "remove"]),
  worktreePath: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** Runs commands inside one sandbox. Plain functions, so sync spawn callbacks can use it. */
export interface SandboxExecTarget {
  readonly worktreePath: string;
  readonly containerName: string;
  /**
   * Docker client command that runs `command` inside the sandbox. The caller
   * spawns it and calls `release` when it exits or is killed: killing the
   * Docker client alone leaves the command running in the container.
   * Throws `SandboxError` when the env needs a folder the sandbox cannot see.
   */
  readonly command: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly tty: boolean;
  }) => SandboxCommand;
}

export interface SandboxCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Env for the Docker client. It holds the values `-e NAME` copies in. */
  readonly env: NodeJS.ProcessEnv;
  /** Kills the command's processes in the container. Safe to call more than once. */
  readonly release: () => void;
}

export interface SandboxForwardedPort {
  readonly worktreePath: string;
  readonly containerPort: number;
  readonly hostPort: number;
}

/**
 * Docker sandboxes for worktrees. A sandbox is one long-running container
 * that mounts its worktree (and the repository's git dir) at the same path,
 * plus the user's Claude and Codex config folders. Agents, terminals, and
 * setup scripts whose cwd is inside a sandboxed worktree run in it through
 * `docker exec`, so parallel threads get separate ports, services, and
 * machine state while T3 keeps reading the worktree on the host.
 *
 * A worktree is registered as sandboxed before anything slow happens, and
 * stays registered when provisioning fails, so work there fails instead of
 * running on the host. The list is persisted, and containers carry labels
 * that rebuild it if the file is lost.
 */
export class SandboxService extends Context.Service<
  SandboxService,
  {
    /** Whether this host can run sandboxes at all: Linux and macOS with Docker. */
    readonly supported: boolean;
    /**
     * Marks a new worktree as sandboxed and saves it. Fast; call it before
     * anything can run in the worktree, then `start`. `providers` supplies
     * the Claude and Codex versions to install; their home folders, plus
     * `homes` (see `sandboxProviderHomes`), are mounted.
     */
    readonly register: (input: {
      readonly worktreePath: string;
      /** The project checkout, mounted read-only for setup scripts that copy or link from it. */
      readonly projectRoot: string;
      readonly providers: ReadonlyArray<ServerProvider>;
      readonly homes: ReadonlyArray<string>;
    }) => Effect.Effect<void, SandboxError>;
    /** Builds the image if needed, then creates and starts a registered sandbox. */
    readonly start: (input: {
      readonly worktreePath: string;
      readonly onOutput?: (line: string) => Effect.Effect<void>;
    }) => Effect.Effect<SandboxSummary, SandboxError>;
    /** The started sandbox that owns `cwd`, or none when `cwd` is not sandboxed. */
    readonly execTarget: (
      cwd: string,
    ) => Effect.Effect<Option.Option<SandboxExecTarget>, SandboxError>;
    /** Whether `cwd` is inside a sandboxed worktree. Does not start anything. */
    readonly isSandboxed: (cwd: string) => Effect.Effect<boolean>;
    /** Stops the container. The next command in the worktree starts it again. */
    readonly stop: (worktreePath: string) => Effect.Effect<void, SandboxError>;
    /** Deletes the container. Work in the worktree runs on the host afterwards. */
    readonly remove: (worktreePath: string) => Effect.Effect<void, SandboxError>;
    readonly list: Effect.Effect<ReadonlyArray<SandboxSummary>>;
    /** Emits the full list first, then after every change. */
    readonly stream: Stream.Stream<SandboxListStreamEvent>;
    /** Every forwarded sandbox port, for preview discovery. */
    readonly forwardedPorts: () => ReadonlyArray<SandboxForwardedPort>;
    /**
     * Worktrees whose container stopped, was removed, or lost its relay. The
     * processes T3 ran there are gone, so sessions holding them are dead.
     */
    readonly stopped: Stream.Stream<string>;
  }
>()("t3/sandbox/SandboxService") {}

const Mount = Schema.Struct({ path: Schema.String, readOnly: Schema.Boolean });

const RegistryEntry = Schema.Struct({
  worktreePath: Schema.String,
  containerName: Schema.String,
  image: Schema.String,
  versions: Schema.Struct({ claude: Schema.String, codex: Schema.String }),
  mounts: Schema.Array(Mount),
});
const RegistryFile = Schema.Struct({
  version: Schema.Literal(1),
  /** Saved while an unreadable list has not been rebuilt from Docker yet. */
  unverified: Schema.optional(Schema.Boolean),
  sandboxes: Schema.Array(RegistryEntry),
});
const RegistryJson = Schema.fromJsonString(RegistryFile);
const decodeRegistry = Schema.decodeUnknownEffect(RegistryJson);
const encodeRegistry = Schema.encodeEffect(RegistryJson);
const MarkerJson = Schema.fromJsonString(RegistryEntry);
const decodeMarker = Schema.decodeUnknownEffect(MarkerJson);
const encodeMarker = Schema.encodeEffect(MarkerJson);
/** Kept in the worktree's own git admin folder, which `git worktree remove` deletes. */
const MARKER_FILE = "t3code-sandbox.json";

/** The parts of `docker inspect` output used to adopt a labeled container. */
const InspectedContainers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Name: Schema.String,
      Config: Schema.Struct({
        Image: Schema.String,
        Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
      }),
      State: Schema.Struct({ Running: Schema.Boolean }),
      Mounts: Schema.NullOr(
        Schema.Array(
          Schema.Struct({ Source: Schema.String, Destination: Schema.String, RW: Schema.Boolean }),
        ),
      ),
    }),
  ),
);
const decodeInspected = Schema.decodeUnknownEffect(InspectedContainers);

interface SandboxRecord {
  readonly worktreePath: string;
  readonly containerName: string;
  readonly versions: SandboxCliVersions;
  readonly mounts: ReadonlyArray<SandboxMount>;
  /** Empty until the first image build finishes. */
  image: string;
  status: SandboxStatus;
  error: string | null;
  tunnel: SandboxTunnel | null;
  /** Commands left running by an earlier server process were killed. */
  reaped: boolean;
  readonly lock: Semaphore.Semaphore;
}

const DOCKER = "docker";
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["linux", "darwin"]);
const SANDBOX_DRIVERS = { claude: "claudeAgent", codex: "codex" } as const;

const containsPath = (root: string, candidate: string, separator: string) =>
  candidate === root || candidate.startsWith(root.endsWith(separator) ? root : root + separator);

/** The version T3 runs for a driver: its default instance first, then any enabled one. */
const providerVersion = (providers: ReadonlyArray<ServerProvider>, driver: string) =>
  (
    providers.find((provider) => provider.instanceId === driver && provider.version) ??
    providers.find((provider) => provider.driver === driver && provider.enabled && provider.version)
  )?.version ?? "latest";

/**
 * Claude and Codex home folders configured in settings: the built-in
 * providers, provider instances, and their CLAUDE_CONFIG_DIR or CODEX_HOME.
 * Sandboxes mount them so any of those providers can run inside.
 */
export const sandboxProviderHomes = (settings: ServerSettings): ReadonlyArray<string> => {
  const homes: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      homes.push(expandHomePath(value.trim()));
    }
  };
  add(settings.providers.codex.homePath);
  add(settings.providers.codex.shadowHomePath);
  add(settings.providers.claudeAgent.homePath);
  for (const instance of Object.values(settings.providerInstances)) {
    if (!Object.values(SANDBOX_DRIVERS).some((driver) => driver === instance.driver)) continue;
    const config = instance.config;
    if (typeof config === "object" && config !== null) {
      if ("homePath" in config) add(config.homePath);
      if ("shadowHomePath" in config) add(config.shadowHomePath);
    }
    for (const variable of instance.environment ?? []) {
      if (variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR") {
        add(variable.value);
      }
    }
  }
  return homes;
};

const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const supported = SUPPORTED_PLATFORMS.has(platform);
  const hostEnv = { ...process.env };
  const home = NodeOS.homedir();
  const registryPath = path.join(serverConfig.stateDir, "sandboxes.json");
  const owner = sandboxOwner(serverConfig.stateDir);
  const records = new Map<string, SandboxRecord>();
  const changes = yield* PubSub.unbounded<void>();
  const stoppedWorktrees = yield* PubSub.unbounded<string>();
  const registryLock = yield* Semaphore.make(1);
  // Lookups wait until labeled containers missing from the saved list are adopted.
  const ready = yield* Deferred.make<void>();
  // Set while an unreadable list has not been rebuilt from Docker yet. Then
  // no T3 worktree can be shown to be unsandboxed, so lookups there fail.
  let unverified = false;

  // Agents reach T3's MCP endpoint on the server's own loopback address. The
  // relay listens on that address and port inside the container and connects
  // back. A wildcard bind is announced as 127.0.0.1; other addresses are
  // reachable from the container without help.
  const mcpReverse = (() => {
    if (!NetAddress.isInetAddress(httpServer.address)) return null;
    const host = NetAddress.isUnspecified(httpServer.address.address)
      ? "127.0.0.1"
      : NetAddress.formatIp(httpServer.address.address);
    if (!host.startsWith("127.") && host !== "::1") return null;
    return { host, port: httpServer.address.port };
  })();

  const summarize = (record: SandboxRecord): SandboxSummary => ({
    worktreePath: record.worktreePath,
    containerName: record.containerName,
    image: record.image || "building",
    status: record.status,
    ports: record.tunnel?.ports ?? [],
    error: record.error,
  });
  const publish = () => PubSub.publishUnsafe(changes, undefined);
  const setStatus = (record: SandboxRecord, status: SandboxStatus, error: string | null = null) => {
    record.status = status;
    record.error = error;
    publish();
  };

  const fail =
    (operation: SandboxError["operation"], worktreePath: string, detail: string) =>
    (cause?: unknown) =>
      new SandboxError({
        operation,
        worktreePath,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

  /** Runs a short Docker CLI command and returns trimmed stdout, failing on a non-zero exit. */
  const docker = (
    operation: SandboxError["operation"],
    worktreePath: string,
    args: ReadonlyArray<string>,
    options: { readonly stdin?: string; readonly onLine?: (line: string) => void } = {},
  ) => {
    let partial = "";
    const onChunk =
      options.onLine === undefined
        ? undefined
        : (chunk: Uint8Array) => {
            const lines = (partial + Buffer.from(chunk).toString("utf8")).split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) if (line.trim().length > 0) options.onLine!(line);
          };
    return processRunner
      .run({
        command: DOCKER,
        args,
        env: hostEnv,
        maxOutputBytes: 4 * 1024 * 1024,
        outputMode: "truncate",
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(onChunk === undefined ? {} : { onStdoutChunk: onChunk, onStderrChunk: onChunk }),
      })
      .pipe(
        Effect.mapError(
          fail(
            operation,
            worktreePath,
            "Docker is not installed or not on PATH. Install Docker to use sandboxes.",
          ),
        ),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(
                fail(
                  operation,
                  worktreePath,
                  `docker ${args[0]} failed: ${(result.stderr.trim() || result.stdout.trim()).slice(-400)}`,
                )(),
              ),
        ),
      );
  };

  /** Saves the list. Writes are serialized so an older snapshot never lands last. */
  const persist = registryLock.withPermits(1)(
    Effect.gen(function* () {
      const contents = yield* encodeRegistry({
        version: 1,
        ...(unverified ? { unverified: true } : {}),
        sandboxes: [...records.values()].map((record) => ({
          worktreePath: record.worktreePath,
          containerName: record.containerName,
          image: record.image,
          versions: record.versions,
          mounts: record.mounts,
        })),
      });
      yield* writeFileStringAtomically({ filePath: registryPath, contents });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(fail("create", registryPath, "Could not save the sandbox list.")),
    ),
  );
  const persistOrLog = persist.pipe(
    Effect.catchCause((cause) => Effect.logError("Failed to save the sandbox list", { cause })),
  );

  const ensureImage = Effect.fn("SandboxService.ensureImage")(function* (
    record: SandboxRecord,
    onOutput: (line: string) => void,
  ) {
    const input = {
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      home,
      versions: record.versions,
    };
    const tag = sandboxImageTag(input);
    const exists = yield* docker("start", record.worktreePath, ["image", "inspect", tag]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!exists) {
      onOutput(`Building sandbox image ${tag}`);
      yield* docker("start", record.worktreePath, sandboxImageBuildArgs(input, tag), {
        stdin: SANDBOX_DOCKERFILE,
        onLine: onOutput,
      });
    }
    return tag;
  });

  /** Folders mounted at their own path. Only folders that exist are mounted. */
  const mountsFor = Effect.fn("SandboxService.mountsFor")(function* (
    worktreePath: string,
    gitCommonDir: string,
    projectRoot: string,
    providers: ReadonlyArray<ServerProvider>,
    homes: ReadonlyArray<string>,
  ) {
    const providerHomes = providers
      .filter((provider) => Object.values(SANDBOX_DRIVERS).some((d) => d === provider.driver))
      .flatMap((provider) =>
        provider.runtimePaths === undefined
          ? []
          : [provider.runtimePaths.homePath, provider.runtimePaths.shadowHomePath ?? ""],
      )
      .filter((home) => home.length > 0);
    const candidates: ReadonlyArray<SandboxMount> = [
      { path: worktreePath, readOnly: false },
      { path: gitCommonDir, readOnly: false },
      { path: hostEnv.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), readOnly: false },
      { path: hostEnv.CODEX_HOME ?? path.join(home, ".codex"), readOnly: false },
      ...[...providerHomes, ...homes].map((providerHome) => ({
        path: providerHome,
        readOnly: false,
      })),
      { path: path.join(home, ".gitconfig"), readOnly: true },
      // Claude reads pasted images from T3's attachment folder.
      { path: serverConfig.attachmentsDir, readOnly: true },
      // Setup scripts copy or link files such as .env from the checkout. A
      // checkout that holds the home folder would hide the sandbox's own home.
      ...(containsPath(projectRoot, home, path.sep) ? [] : [{ path: projectRoot, readOnly: true }]),
    ];
    const mounts: Array<SandboxMount> = [];
    for (const mount of candidates) {
      if (!isMountablePath(mount.path)) continue;
      // A writable mount already covers anything inside it; a read-only one
      // covers only read-only paths, so the worktree and git dir stay writable.
      const covered = mounts.some(
        (existing) =>
          containsPath(existing.path, mount.path, path.sep) &&
          (!existing.readOnly || mount.readOnly),
      );
      if (covered) continue;
      if (yield* fileSystem.exists(mount.path).pipe(Effect.orElseSucceed(() => false))) {
        mounts.push(mount);
      }
    }
    return mounts;
  });

  const runContainer = Effect.fn("SandboxService.runContainer")(function* (record: SandboxRecord) {
    yield* docker("start", record.worktreePath, ["rm", "--force", record.containerName]).pipe(
      Effect.ignore,
    );
    yield* docker(
      "start",
      record.worktreePath,
      dockerRunArgs({
        owner,
        containerName: record.containerName,
        image: record.image,
        worktreePath: record.worktreePath,
        versions: record.versions,
        mounts: record.mounts,
        ipv6Loopback: mcpReverse?.host === "::1",
      }),
    );
    // Claude rewrites ~/.claude.json by renaming over it, which fails on a
    // bind-mounted file. The sandbox gets its own copy; credentials stay
    // shared through the mounted ~/.claude folder.
    const claudeJson = path.join(home, ".claude.json");
    if (yield* fileSystem.exists(claudeJson).pipe(Effect.orElseSucceed(() => false))) {
      yield* docker("start", record.worktreePath, [
        "cp",
        "--archive",
        claudeJson,
        `${record.containerName}:${claudeJson}`,
      ]).pipe(Effect.ignore);
    }
  });

  const spawnDocker = (args: ReadonlyArray<string>) =>
    NodeChildProcess.spawn(DOCKER, [...args], { env: hostEnv, stdio: ["pipe", "pipe", "pipe"] });

  const startTunnel = (record: SandboxRecord) => {
    const tunnel: SandboxTunnel = new SandboxTunnel({
      spawnRelay: () =>
        spawnDocker(["exec", "-i", record.containerName, "node", "-e", SANDBOX_RELAY_SOURCE]),
      reversePorts:
        mcpReverse === null
          ? []
          : [{ host: mcpReverse.host, containerPort: mcpReverse.port, hostPort: mcpReverse.port }],
      preferredHostPort: (containerPort) =>
        preferredSandboxHostPort(record.containerName, containerPort),
      onPortsChanged: publish,
      onExit: (detail) => {
        if (record.tunnel !== tunnel) return;
        record.tunnel = null;
        // The relay only exits by itself when the container or Docker went away.
        if (detail !== "closed") {
          setStatus(record, "stopped");
          PubSub.publishUnsafe(stoppedWorktrees, record.worktreePath);
        } else {
          publish();
        }
      },
    });
    record.tunnel = tunnel;
  };

  const release = (containerName: string, target: string) => {
    const child = NodeChildProcess.spawn(
      DOCKER,
      ["exec", containerName, "node", "-e", SANDBOX_KILL_SOURCE, target],
      { env: hostEnv, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  };

  /**
   * Builds the image and creates the container when either is missing, starts
   * a stopped container, and starts the relay. Callers hold the record lock.
   */
  const startUnlocked = (record: SandboxRecord, onOutput: (line: string) => void = () => {}) =>
    Effect.gen(function* () {
      // A lookup can hold a record that Remove deleted while it waited for the lock.
      if (records.get(record.worktreePath) !== record) return false;
      if (record.status === "running" && record.tunnel?.alive === true) return true;
      setStatus(record, "starting");
      const state = yield* docker("start", record.worktreePath, [
        "inspect",
        "--format",
        "{{.State.Running}}",
        record.containerName,
      ]).pipe(Effect.orElseSucceed(() => "missing"));
      if (state === "missing") {
        yield* docker("start", record.worktreePath, [
          "version",
          "--format",
          "{{.Server.Version}}",
        ]).pipe(
          Effect.mapError((error) =>
            fail(
              "start",
              record.worktreePath,
              `Docker is not running. Start Docker and try again. (${error.detail})`,
            )(error),
          ),
        );
        record.image = yield* ensureImage(record, onOutput);
        yield* persistOrLog;
        onOutput(`Starting container ${record.containerName}`);
        yield* runContainer(record);
      } else if (state !== "true") {
        yield* docker("start", record.worktreePath, ["start", record.containerName]);
      }
      if (!record.reaped) {
        // Commands an earlier server process started outlive it in the
        // container; stop them like the host stops orphaned terminals.
        yield* docker("start", record.worktreePath, [
          "exec",
          record.containerName,
          "node",
          "-e",
          SANDBOX_KILL_SOURCE,
          "--all",
        ]).pipe(Effect.ignore);
        record.reaped = true;
      }
      if (record.tunnel?.alive !== true) startTunnel(record);
      setStatus(record, "running");
      return true;
    }).pipe(
      Effect.tapError((error) => Effect.sync(() => setStatus(record, "error", error.detail))),
    );

  const ensureRunning = (record: SandboxRecord) =>
    record.lock.withPermits(1)(startUnlocked(record));

  const recordFor = (cwd: string) => {
    for (const record of records.values()) {
      if (containsPath(record.worktreePath, cwd, path.sep)) return record;
    }
    return undefined;
  };

  /** True when `cwd` might be sandboxed but the list is unverified. Retries the rebuild once. */
  const unknownSandbox = (cwd: string) =>
    Effect.gen(function* () {
      if (!unverified || !containsPath(serverConfig.worktreesDir, cwd, path.sep)) return false;
      yield* reconcileOnce;
      return unverified && recordFor(cwd) === undefined;
    });

  const makeExecTarget = (record: SandboxRecord): SandboxExecTarget => ({
    worktreePath: record.worktreePath,
    containerName: record.containerName,
    command: (input) => {
      for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
        const value = input.env[name];
        if (value === undefined || value === hostEnv[name]) continue;
        if (!record.mounts.some((mount) => containsPath(mount.path, value, path.sep))) {
          throw fail(
            "exec",
            record.worktreePath,
            `This provider uses ${name}=${value}, which this sandbox does not mount. Start a new sandbox after changing a provider's home folder.`,
          )();
        }
      }
      const execId = NodeCrypto.randomUUID();
      let released = false;
      return {
        command: DOCKER,
        args: dockerExecArgs({
          containerName: record.containerName,
          execId,
          cwd: input.cwd,
          envNames: sandboxEnvNames(input.env, hostEnv),
          tty: input.tty,
          command: input.command,
          args: input.args,
        }),
        env: { ...hostEnv, ...input.env },
        release: () => {
          if (released) return;
          released = true;
          release(record.containerName, execId);
        },
      };
    },
  });

  /**
   * The marker file for a worktree: `<git admin dir>/t3code-sandbox.json`,
   * found through the `.git` file a linked worktree has at its root.
   */
  const markerPath = (worktreePath: string) =>
    fileSystem.readFileString(path.join(worktreePath, ".git")).pipe(
      Effect.map((text) => /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()),
      Effect.map((gitDir) =>
        gitDir === undefined
          ? undefined
          : path.join(path.resolve(worktreePath, gitDir), MARKER_FILE),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  /**
   * Rebuilds a sandbox from the marker in its worktree when the saved list
   * lost it, so a lost list never lets sandboxed work start on the host.
   */
  const recordFromMarker = (cwd: string) =>
    Effect.gen(function* () {
      // Every ancestor is checked, so a submodule or nested repository inside
      // a sandboxed worktree still finds the worktree's marker.
      let dir = cwd;
      while (true) {
        const marker = yield* markerPath(dir);
        const entry =
          marker === undefined
            ? undefined
            : yield* fileSystem.readFileString(marker).pipe(
                Effect.flatMap(decodeMarker),
                Effect.orElseSucceed(() => undefined),
              );
        if (entry !== undefined && entry.worktreePath === dir) {
          const existing = records.get(entry.worktreePath);
          if (existing !== undefined) return existing;
          addLoadedRecord(entry);
          publish();
          yield* persistOrLog;
          return records.get(entry.worktreePath);
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    });

  /** The sandbox owning `cwd`, from memory or its worktree's marker. */
  const lookup = (cwd: string) =>
    Effect.suspend(() => {
      const record = recordFor(cwd);
      return record === undefined ? recordFromMarker(cwd) : Effect.succeed(record);
    });

  const register: SandboxService["Service"]["register"] = Effect.fn("SandboxService.register")(
    function* (input) {
      yield* Deferred.await(ready);
      if (!supported) {
        return yield* fail(
          "create",
          input.worktreePath,
          "Sandboxes run on Linux and macOS hosts.",
        )();
      }
      if (!isMountablePath(input.worktreePath)) {
        return yield* fail(
          "create",
          input.worktreePath,
          "Sandboxes cannot mount a path that contains a comma.",
        )();
      }
      const gitCommonDir = yield* processRunner
        .run({
          command: "git",
          args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          cwd: input.worktreePath,
          env: hostEnv,
        })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0 && result.stdout.trim().length > 0
              ? Effect.succeed(result.stdout.trim())
              : Effect.fail(result.stderr),
          ),
          Effect.mapError(
            fail("create", input.worktreePath, "Could not find the worktree's git folder."),
          ),
        );
      records.get(input.worktreePath)?.tunnel?.close();
      const record: SandboxRecord = {
        worktreePath: input.worktreePath,
        containerName: sandboxContainerName(input.worktreePath),
        versions: {
          claude: providerVersion(input.providers, SANDBOX_DRIVERS.claude),
          codex: providerVersion(input.providers, SANDBOX_DRIVERS.codex),
        },
        mounts: yield* mountsFor(
          input.worktreePath,
          gitCommonDir,
          input.projectRoot,
          input.providers,
          input.homes,
        ),
        image: "",
        status: "starting",
        error: null,
        tunnel: null,
        reaped: true,
        lock: Semaphore.makeUnsafe(1),
      };
      // Saved before the slow start, so terminals opened during the build wait
      // for the sandbox instead of starting on the host. A failed start leaves
      // the record in place for the next attempt.
      records.set(record.worktreePath, record);
      publish();
      const marker = yield* markerPath(record.worktreePath);
      yield* persist.pipe(
        Effect.andThen(
          marker === undefined
            ? fail("create", record.worktreePath, "The worktree has no git admin folder.")()
            : encodeMarker(record).pipe(
                Effect.flatMap((contents) =>
                  writeFileStringAtomically({ filePath: marker, contents }),
                ),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  fail("create", record.worktreePath, "Could not mark the worktree as sandboxed."),
                ),
              ),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            records.delete(record.worktreePath);
            publish();
          }).pipe(Effect.andThen(persistOrLog)),
        ),
      );
    },
  );

  const start: SandboxService["Service"]["start"] = Effect.fn("SandboxService.start")(
    function* (input) {
      const record = records.get(input.worktreePath);
      if (record === undefined) {
        return yield* fail("start", input.worktreePath, "This worktree has no sandbox.")();
      }
      const onOutput = (line: string) => {
        if (input.onOutput) Effect.runFork(input.onOutput(line));
      };
      yield* record.lock.withPermits(1)(startUnlocked(record, onOutput));
      return summarize(record);
    },
  );

  const execTarget: SandboxService["Service"]["execTarget"] = (cwd) =>
    Effect.gen(function* () {
      yield* Deferred.await(ready);
      if (yield* unknownSandbox(cwd)) {
        return yield* fail(
          "start",
          cwd,
          "T3 could not read its sandbox list and Docker is not reachable, so it cannot tell whether this worktree runs in a sandbox. Start Docker and try again.",
        )();
      }
      const record = yield* lookup(cwd);
      if (record === undefined) return Option.none();
      return (yield* ensureRunning(record)) ? Option.some(makeExecTarget(record)) : Option.none();
    });

  const stop: SandboxService["Service"]["stop"] = (worktreePath) =>
    Effect.gen(function* () {
      const record = records.get(worktreePath);
      if (record === undefined) return;
      yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          record.tunnel?.close();
          record.tunnel = null;
          yield* docker("stop", worktreePath, ["stop", "--time", "3", record.containerName]);
          // The container's processes are gone, so nothing is left to reap.
          record.reaped = true;
          setStatus(record, "stopped");
          PubSub.publishUnsafe(stoppedWorktrees, worktreePath);
        }),
      );
    });

  const remove: SandboxService["Service"]["remove"] = (worktreePath) =>
    Effect.gen(function* () {
      const record = records.get(worktreePath);
      if (record === undefined) return;
      yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          record.tunnel?.close();
          record.tunnel = null;
          // A failed first start can leave no container to delete.
          yield* docker("remove", worktreePath, ["rm", "--force", record.containerName]).pipe(
            Effect.catchIf(
              (error) => /no such container/i.test(error.detail),
              () => Effect.succeed(""),
            ),
          );
          records.delete(worktreePath);
          publish();
          PubSub.publishUnsafe(stoppedWorktrees, worktreePath);
          yield* persistOrLog;
          const marker = yield* markerPath(worktreePath);
          if (marker !== undefined) yield* fileSystem.remove(marker).pipe(Effect.ignore);
        }),
      );
    });

  const list = Effect.sync(() => [...records.values()].map(summarize));

  /** One-slot sliding mailbox: a slow client only ever holds the newest list. */
  const stream: SandboxService["Service"]["stream"] = Stream.callback<SandboxListStreamEvent>(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, { sandboxes: yield* list });
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach(() =>
            Effect.map(list, (sandboxes) => Queue.offerUnsafe(mailbox, { sandboxes })),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  const forwardedPorts: SandboxService["Service"]["forwardedPorts"] = () =>
    [...records.values()].flatMap((record) =>
      (record.tunnel?.ports ?? []).map((port) => ({ worktreePath: record.worktreePath, ...port })),
    );

  const worktreeExists = (worktreePath: string) =>
    fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false));

  const addLoadedRecord = (entry: {
    readonly worktreePath: string;
    readonly containerName: string;
    readonly image: string;
    readonly versions: SandboxCliVersions;
    readonly mounts: ReadonlyArray<SandboxMount>;
  }) =>
    records.set(entry.worktreePath, {
      ...entry,
      status: "stopped",
      error: null,
      tunnel: null,
      reaped: false,
      lock: Semaphore.makeUnsafe(1),
    });

  // Load the saved list. A missing file means no sandboxes yet; an unreadable
  // one is logged, and the labeled containers below rebuild what they can.
  const saved = yield* fileSystem.readFileString(registryPath).pipe(
    Effect.flatMap(decodeRegistry),
    Effect.map((registry) => {
      if (registry.unverified === true) unverified = true;
      return registry.sandboxes;
    }),
    Effect.catchCause((cause) =>
      fileSystem.exists(registryPath).pipe(
        Effect.orElseSucceed(() => true),
        Effect.flatMap((exists) =>
          exists
            ? Effect.logError("Could not read the sandbox list", { registryPath, cause }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    unverified = true;
                  }),
                ),
              )
            : Effect.void,
        ),
        Effect.as([]),
      ),
    ),
  );
  for (const entry of saved) addLoadedRecord(entry);

  /**
   * Adopts labeled containers the saved list does not know, drops sandboxes
   * whose worktree is gone, and reconnects containers that are still running
   * so their ports show up after a restart.
   */
  const reconcile = Effect.gen(function* () {
    const names = yield* docker("start", registryPath, [
      "ps",
      "--all",
      "--filter",
      `label=${SANDBOX_LABELS.owner}=${owner}`,
      "--format",
      "{{.Names}}",
    ]);
    const containers =
      names.length === 0
        ? []
        : yield* docker("start", registryPath, ["inspect", ...names.split("\n")]).pipe(
            Effect.flatMap(decodeInspected),
          );
    let changed = false;
    for (const container of containers) {
      const labels = container.Config.Labels ?? {};
      const worktreePath = labels[SANDBOX_LABELS.worktree];
      if (worktreePath === undefined || records.has(worktreePath)) continue;
      addLoadedRecord({
        worktreePath,
        containerName: container.Name.replace(/^\//, ""),
        image: container.Config.Image,
        versions: {
          claude: labels[SANDBOX_LABELS.claude] ?? "latest",
          codex: labels[SANDBOX_LABELS.codex] ?? "latest",
        },
        mounts: (container.Mounts ?? [])
          .filter((mount) => mount.Source === mount.Destination)
          .map((mount) => ({ path: mount.Source, readOnly: !mount.RW })),
      });
      changed = true;
    }
    for (const record of [...records.values()]) {
      if (yield* worktreeExists(record.worktreePath)) continue;
      records.delete(record.worktreePath);
      changed = true;
      yield* docker("remove", record.worktreePath, ["rm", "--force", record.containerName]).pipe(
        Effect.ignore,
      );
    }
    if (unverified) changed = true;
    unverified = false;
    if (changed) {
      publish();
      yield* persistOrLog;
    }
    const running = new Set(
      containers.filter((container) => container.State.Running).map((c) => c.Name.slice(1)),
    );
    return [...records.values()].filter((record) => running.has(record.containerName));
  });

  const reconcileOnce = reconcile.pipe(
    Effect.timeout("15 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not check sandbox containers", { cause }).pipe(Effect.as([])),
    ),
  );

  yield* reconcile.pipe(
    Effect.timeout("15 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not check sandbox containers", { cause }).pipe(Effect.as([])),
    ),
    Effect.tap(() => Deferred.succeed(ready, undefined)),
    Effect.flatMap((running) =>
      Effect.forEach(running, (record) => ensureRunning(record).pipe(Effect.ignore), {
        discard: true,
      }),
    ),
    Effect.ensuring(Deferred.succeed(ready, undefined)),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const record of records.values()) record.tunnel?.close();
    }),
  );

  return SandboxService.of({
    supported,
    register,
    start,
    execTarget,
    isSandboxed: (cwd) =>
      Deferred.await(ready).pipe(
        Effect.andThen(unknownSandbox(cwd)),
        Effect.flatMap((unknown) =>
          unknown
            ? Effect.succeed(true)
            : lookup(cwd).pipe(Effect.map((record) => record !== undefined)),
        ),
      ),
    stop,
    remove,
    list,
    stream,
    forwardedPorts,
    stopped: Stream.fromPubSub(stoppedWorktrees),
  });
});

export const layer = Layer.effect(SandboxService, make);
