import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { runProcess, type ProcessRunResult } from "../processRunner.ts";

const LABEL_PREFIX = "com.t3tools.t3code.server";
const COMMAND_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_INCOMPLETE_OWNER_STALE_MS = 2_000;

export interface ServiceInvocation {
  readonly cwd: string;
  readonly host?: string;
  readonly port?: number;
}

export interface ServicePaths {
  readonly instanceId: string;
  readonly label: string;
  readonly target: string;
  readonly definitionPath: string;
  readonly lockPath: string;
  readonly instanceDir: string;
  readonly runtimesDir: string;
  readonly versionPath: string;
  readonly logPath: string;
  readonly runtimeStatePath: string;
}

export interface ServicePlan extends ServicePaths {
  readonly baseDir: string;
  readonly runtimePath: string;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
}

export interface ServiceStatus extends ServicePaths {
  readonly supported: boolean;
  readonly platform: NodeJS.Platform;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly processAlive: boolean;
  readonly responsive: boolean;
  readonly pid?: number;
  readonly current: boolean;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background services currently support macOS launchd; '${this.platform}' is unsupported.`;
  }
}

export class BootServiceError extends Schema.TaggedErrorClass<BootServiceError>()(
  "BootServiceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Background service operation failed while ${this.operation}.`;
  }
}

export interface SupervisorState {
  readonly loaded: boolean;
  readonly processAlive: boolean;
  readonly pid?: number;
}

export interface ServiceHost {
  readonly canonicalize: (path: string) => Promise<string>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly read: (path: string) => Promise<string>;
  readonly writeAtomic: (path: string, contents: string, mode: number) => Promise<void>;
  readonly makeDirectory: (path: string, mode: number) => Promise<void>;
  readonly listDirectory: (path: string) => Promise<ReadonlyArray<string>>;
  readonly copyDirectory: (source: string, destination: string) => Promise<void>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly remove: (path: string, recursive?: boolean) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly acquireLock: (path: string, options: ServiceLockOptions) => Promise<ServiceLock>;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
  ) => Promise<ProcessRunResult>;
  readonly probeRuntime: (
    runtimeStatePath: string,
    expectedPid: number,
    timeoutMs: number,
  ) => Promise<boolean>;
  readonly removeRuntimeStateIfOwned: (
    runtimeStatePath: string,
    expectedPid: number,
  ) => Promise<boolean>;
}

export interface ServiceLockOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly incompleteOwnerStaleMs: number;
}

export interface ServiceLock {
  readonly release: () => Promise<void>;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

export const filesystemErrorIsAbsence = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR";
};

const parseRuntimePid = (contents: string): number | undefined => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("pid" in parsed) ||
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid)
    ) {
      return undefined;
    }
    return parsed.pid;
  } catch {
    return undefined;
  }
};

interface LockOwner {
  readonly pid: number;
  readonly token: string;
  readonly processStart?: string;
}

const parseLockOwner = (contents: string): LockOwner | undefined => {
  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    !("token" in parsed) ||
    typeof parsed.token !== "string"
  ) {
    return undefined;
  }
  const processStart = "processStart" in parsed ? parsed.processStart : undefined;
  if (processStart !== undefined && typeof processStart !== "string") {
    return undefined;
  }
  return {
    pid: parsed.pid,
    token: parsed.token,
    ...(typeof processStart === "string" ? { processStart } : {}),
  };
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) !== "ESRCH";
  }
};

const processStartIdentity = async (pid: number): Promise<string | undefined> => {
  const result = await runProcess("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    allowNonZeroExit: true,
    timeoutMs: 2_000,
    outputMode: "truncate",
    maxBufferBytes: 8 * 1024,
  });
  const identity = result.stdout.trim();
  return result.code === 0 && !result.timedOut && identity.length > 0 ? identity : undefined;
};

export const lockOwnerRemainsActive = (input: {
  readonly pidAlive: boolean;
  readonly recordedProcessStart?: string;
  readonly currentProcessStart?: string;
}): boolean =>
  input.pidAlive &&
  (input.recordedProcessStart === undefined ||
    input.currentProcessStart === undefined ||
    input.currentProcessStart === input.recordedProcessStart);

const lockOwnerIsAlive = async (owner: LockOwner): Promise<boolean> => {
  const pidAlive = processIsAlive(owner.pid);
  const currentProcessStart =
    pidAlive && owner.processStart !== undefined
      ? await processStartIdentity(owner.pid)
      : undefined;
  return lockOwnerRemainsActive({
    pidAlive,
    ...(owner.processStart === undefined ? {} : { recordedProcessStart: owner.processStart }),
    ...(currentProcessStart === undefined ? {} : { currentProcessStart }),
  });
};

const canonicalizeWithMissingSuffix = async (input: string): Promise<string> => {
  const absolute = resolve(input);
  const missingSegments: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments.toReversed());
    } catch (cause) {
      const code = errorCode(cause);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
      const parent = dirname(current);
      if (parent === current) throw cause;
      missingSegments.push(basename(current));
      current = parent;
    }
  }
};

export const liveServiceHost: ServiceHost = {
  canonicalize: canonicalizeWithMissingSuffix,
  exists: async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch (cause) {
      if (filesystemErrorIsAbsence(cause)) return false;
      throw cause;
    }
  },
  read: (path) => readFile(path, "utf8"),
  writeAtomic: async (path, contents, mode) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode });
    await rename(temporary, path);
    await chmod(path, mode);
  },
  makeDirectory: async (path, mode) => {
    await mkdir(path, { recursive: true, mode });
    await chmod(path, mode);
  },
  listDirectory: async (path) => {
    const { readdir } = await import("node:fs/promises");
    return readdir(path);
  },
  copyDirectory: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  },
  rename,
  remove: (path, recursive = false) => rm(path, { force: true, recursive }),
  chmod,
  acquireLock: async (path, options) => {
    const ownerPath = join(path, "owner.json");
    const reclaimPath = `${path}.reclaim`;
    const reclaimOwnerPath = join(reclaimPath, "owner.json");
    const deadline = Date.now() + options.timeoutMs;
    const ownerProcessStart = await processStartIdentity(process.pid);
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      ...(ownerProcessStart === undefined ? {} : { processStart: ownerProcessStart }),
    };
    const candidatePath = `${path}.${owner.token}.candidate`;
    const candidateOwnerPath = join(candidatePath, "owner.json");

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await mkdir(candidatePath, { mode: 0o700 });
    await writeFile(candidateOwnerPath, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
      flag: "wx",
    });

    const readOwner = async (ownerFile: string): Promise<LockOwner | undefined> => {
      try {
        return parseLockOwner(await readFile(ownerFile, "utf8"));
      } catch {
        return undefined;
      }
    };
    const isIncompleteOwnerStale = async (directory: string): Promise<boolean> => {
      try {
        return Date.now() - (await stat(directory)).mtimeMs >= options.incompleteOwnerStaleMs;
      } catch {
        return false;
      }
    };
    const removeDeadOrIncompleteLock = async (
      directory: string,
      ownerFile: string,
    ): Promise<boolean> => {
      const currentOwner = await readOwner(ownerFile);
      if (currentOwner !== undefined && (await lockOwnerIsAlive(currentOwner))) return false;
      if (currentOwner === undefined && !(await isIncompleteOwnerStale(directory))) return false;
      await rm(directory, { recursive: true, force: true });
      return true;
    };

    while (Date.now() < deadline) {
      if (
        await access(reclaimPath, constants.F_OK).then(
          () => true,
          () => false,
        )
      ) {
        await removeDeadOrIncompleteLock(reclaimPath, reclaimOwnerPath);
        await sleep(options.pollIntervalMs);
        continue;
      }

      try {
        await rename(candidatePath, path);
        return {
          release: async () => {
            const currentOwner = await readOwner(ownerPath);
            if (currentOwner?.token === owner.token) {
              await rm(path, { recursive: true, force: true });
            }
          },
        };
      } catch (cause) {
        const code = errorCode(cause);
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw cause;
      }

      const currentOwner = await readOwner(ownerPath);
      const reclaimable =
        currentOwner === undefined
          ? await isIncompleteOwnerStale(path)
          : !(await lockOwnerIsAlive(currentOwner));
      if (reclaimable) {
        try {
          await mkdir(reclaimPath, { mode: 0o700 });
          await writeFile(reclaimOwnerPath, `${JSON.stringify(owner)}\n`, {
            mode: 0o600,
            flag: "wx",
          });
          await removeDeadOrIncompleteLock(path, ownerPath);
        } catch (cause) {
          if (errorCode(cause) !== "EEXIST") throw cause;
        } finally {
          const reclaimOwner = await readOwner(reclaimOwnerPath);
          if (reclaimOwner?.token === owner.token) {
            await rm(reclaimPath, { recursive: true, force: true });
          }
        }
        continue;
      }
      await sleep(options.pollIntervalMs);
    }
    await rm(candidatePath, { recursive: true, force: true });
    throw new Error(`Timed out acquiring background service lock ${path}.`);
  },
  run: (command, args, timeoutMs) =>
    runProcess(command, args, {
      allowNonZeroExit: true,
      timeoutMs: timeoutMs ?? COMMAND_TIMEOUT_MS,
      outputMode: "truncate",
      maxBufferBytes: 256 * 1024,
    }),
  probeRuntime: async (runtimeStatePath, expectedPid, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const parsed: unknown = JSON.parse(await readFile(runtimeStatePath, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "pid" in parsed &&
          parsed.pid === expectedPid &&
          "origin" in parsed &&
          typeof parsed.origin === "string"
        ) {
          const response = await fetch(parsed.origin, { signal: AbortSignal.timeout(1_000) });
          if (response.ok) {
            const confirmed = JSON.parse(await readFile(runtimeStatePath, "utf8")) as {
              readonly pid?: unknown;
            };
            if (confirmed.pid === expectedPid) return true;
          }
        }
      } catch {
        // Startup races are expected; retry until the bounded deadline.
      }
      await sleep(100);
    }
    return false;
  },
  removeRuntimeStateIfOwned: async (runtimeStatePath, expectedPid) => {
    const claimedPath = `${runtimeStatePath}.${expectedPid}.${randomUUID()}.remove`;
    try {
      await rename(runtimeStatePath, claimedPath);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return false;
      throw cause;
    }
    const restoreClaimedState = async () => {
      try {
        await link(claimedPath, runtimeStatePath);
      } catch (cause) {
        if (errorCode(cause) !== "EEXIST") throw cause;
      }
      await rm(claimedPath, { force: true });
    };
    let claimedPid: number | undefined;
    try {
      claimedPid = parseRuntimePid(await readFile(claimedPath, "utf8"));
    } catch (cause) {
      await restoreClaimedState();
      throw cause;
    }
    if (claimedPid === expectedPid) {
      await rm(claimedPath, { force: true });
      return true;
    }
    if (claimedPid !== undefined && !processIsAlive(claimedPid)) {
      await rm(claimedPath, { force: true });
      return false;
    }
    await restoreClaimedState();
    return false;
  },
};

export const serviceInstanceId = (canonicalBaseDir: string): string =>
  createHash("sha256").update(canonicalBaseDir).digest("hex").slice(0, 12);

export function servicePaths(input: {
  readonly homeDir: string;
  readonly canonicalBaseDir: string;
  readonly userId: number;
}): ServicePaths {
  const instanceId = serviceInstanceId(input.canonicalBaseDir);
  const label = `${LABEL_PREFIX}.${instanceId}`;
  const instanceDir = join(input.canonicalBaseDir, "runtime", "background-service", instanceId);
  return {
    instanceId,
    label,
    target: `gui/${input.userId}/${label}`,
    definitionPath: join(input.homeDir, "Library", "LaunchAgents", `${label}.plist`),
    lockPath: join(
      input.homeDir,
      "Library",
      "Application Support",
      "T3 Code",
      "background-service-locks",
      `${instanceId}.lock`,
    ),
    instanceDir,
    runtimesDir: join(instanceDir, "runtimes"),
    versionPath: join(instanceDir, "version"),
    logPath: join(input.canonicalBaseDir, "userdata", "logs", "server.log"),
    runtimeStatePath: join(instanceDir, "server-runtime.json"),
  };
}

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export function renderLaunchAgent(plan: ServicePlan): string {
  const argumentsXml = plan.arguments
    .map((value) => `    <string>${xml(value)}</string>`)
    .join("\n");
  const environmentXml = Object.entries(plan.environment)
    .flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`])
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${plan.label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    argumentsXml,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environmentXml,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(plan.baseDir)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>5</integer>",
    "  <key>Umask</key>",
    "  <integer>63</integer>",
    "  <key>StandardOutPath</key>",
    "  <string>/dev/null</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>/dev/null</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function parseLaunchctlState(output: string): SupervisorState {
  const pidMatch = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(output);
  const parsedPid = pidMatch === null ? undefined : Number(pidMatch[1]);
  const pid = parsedPid !== undefined && parsedPid > 0 ? parsedPid : undefined;
  const stateMatch = /^\s*state\s*=\s*(\S+)\s*$/m.exec(output);
  return {
    loaded: true,
    processAlive: pid !== undefined && stateMatch?.[1] === "running",
    ...(pid === undefined ? {} : { pid }),
  };
}

const processSucceeded = (result: ProcessRunResult): boolean =>
  !result.timedOut && result.code === 0;

const launchctlServiceNotFound = (result: ProcessRunResult): boolean =>
  !result.timedOut && result.code === 113 && /Could not find service\b/i.test(result.stderr);

const launchctlDomainNotFound = (result: ProcessRunResult): boolean =>
  !result.timedOut &&
  (result.code === 112 || result.code === 113) &&
  /Could not find domain\b/i.test(result.stderr);

const launchctlBootoutTargetNotFound = (result: ProcessRunResult): boolean =>
  launchctlServiceNotFound(result) ||
  launchctlDomainNotFound(result) ||
  (!result.timedOut && result.code === 3 && /\bNo such process\b/i.test(result.stderr));

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BootServiceError({ operation, cause }),
  });

export const resolvePackagedDist = (entryPath: string, host: ServiceHost) =>
  attempt("resolving the packaged CLI", async () => {
    const resolvedEntry = await host.canonicalize(entryPath);
    if (resolvedEntry.includes("/_npx/") || resolvedEntry.includes("/.bun/install/cache/")) {
      throw new Error("Transient package-manager cache entrypoints cannot own a durable service.");
    }
    if (!resolvedEntry.endsWith("/dist/bin.mjs")) {
      throw new Error(`Expected a packaged dist/bin.mjs entrypoint, received ${resolvedEntry}.`);
    }
    const distDir = dirname(resolvedEntry);
    const entries = await Promise.all([
      host.exists(resolvedEntry),
      host.exists(join(distDir, "client", "index.html")),
    ]);
    if (!entries.every(Boolean)) {
      throw new Error("The packaged CLI is missing dist/bin.mjs or dist/client/index.html.");
    }
    return { entryPath: resolvedEntry, distDir };
  });

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: (
      invocation: ServiceInvocation,
    ) => Effect.Effect<ServicePlan, BootServiceError | BootServiceUnsupportedError>;
    readonly status: Effect.Effect<ServiceStatus, BootServiceError>;
    readonly start: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly restart: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly stop: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly enable: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly disable: Effect.Effect<void, BootServiceError | BootServiceUnsupportedError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError | BootServiceUnsupportedError>;
  }
>()("t3/cloud/BootService") {}

export const make = Effect.fn("cloud.bootService.make")(function* (input: {
  readonly baseDir: string;
  readonly host?: ServiceHost;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly userId?: number | null;
  readonly executablePath?: string;
  readonly cliEntryPath?: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
}) {
  const host = input.host ?? liveServiceHost;
  const platform = input.platform ?? (yield* HostProcessPlatform);
  const executablePath = input.executablePath ?? (yield* HostProcessExecutablePath);
  const processArguments = yield* HostProcessArguments;
  const cliEntryPath = input.cliEntryPath ?? processArguments[1] ?? "";
  const processEnvironment = input.processEnvironment ?? (yield* HostProcessEnvironment);
  const hostUserId = yield* HostProcessUserId;
  const userId = input.userId === undefined ? hostUserId : input.userId;
  const homeDir = input.homeDir ?? homedir();
  const canonicalBaseDir = yield* attempt("canonicalizing the base directory", () =>
    host.canonicalize(input.baseDir),
  );
  const paths = userId === null ? null : servicePaths({ homeDir, canonicalBaseDir, userId });

  const requireSupported = Effect.gen(function* () {
    if (platform !== "darwin" || paths === null) {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });
  const runChecked = (operation: string, args: ReadonlyArray<string>) =>
    attempt(operation, () => host.run("/bin/launchctl", args, COMMAND_TIMEOUT_MS)).pipe(
      Effect.flatMap((result) =>
        processSucceeded(result)
          ? Effect.succeed(result)
          : Effect.fail(
              new BootServiceError({
                operation,
                cause:
                  result.stderr ||
                  result.stdout ||
                  (result.timedOut
                    ? "launchctl timed out"
                    : `launchctl exited with code ${result.code ?? "null"}`),
              }),
            ),
      ),
    );
  const withMutationLock = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | BootServiceError | BootServiceUnsupportedError, R> =>
    requireSupported.pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          attempt("acquiring the background service lock", () =>
            host.acquireLock(paths!.lockPath, {
              timeoutMs: LOCK_TIMEOUT_MS,
              pollIntervalMs: LOCK_POLL_INTERVAL_MS,
              incompleteOwnerStaleMs: LOCK_INCOMPLETE_OWNER_STALE_MS,
            }),
          ),
          () => effect,
          (lock) => attempt("releasing the background service lock", () => lock.release()),
        ),
      ),
    );
  const supervisorState = Effect.gen(function* () {
    if (paths === null) return { loaded: false, processAlive: false } satisfies SupervisorState;
    const result = yield* attempt("checking launchd state", () =>
      host.run("/bin/launchctl", ["print", paths.target], COMMAND_TIMEOUT_MS),
    );
    if (processSucceeded(result)) return parseLaunchctlState(result.stdout);
    if (launchctlServiceNotFound(result) || launchctlDomainNotFound(result)) {
      return { loaded: false, processAlive: false } satisfies SupervisorState;
    }
    return yield* new BootServiceError({
      operation: "checking launchd state",
      cause:
        result.stderr ||
        result.stdout ||
        (result.timedOut
          ? "launchctl timed out"
          : `launchctl exited with code ${result.code ?? "null"}`),
    });
  });
  const enabled = Effect.gen(function* () {
    if (paths === null || userId === null) return false;
    const result = yield* attempt("checking launchd enablement", () =>
      host.run("/bin/launchctl", ["print-disabled", `gui/${userId}`], COMMAND_TIMEOUT_MS),
    );
    if (processSucceeded(result)) {
      const entry = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(`"${paths.label}" =>`));
      const value = entry
        ?.slice(entry.indexOf("=>") + 2)
        .trim()
        .toLowerCase();
      return value !== "true" && value !== "disabled";
    }
    if (launchctlDomainNotFound(result)) return false;
    return yield* new BootServiceError({
      operation: "checking launchd enablement",
      cause:
        result.stderr ||
        result.stdout ||
        (result.timedOut
          ? "launchctl timed out"
          : `launchctl exited with code ${result.code ?? "null"}`),
    });
  });
  const stopLoaded = Effect.gen(function* () {
    if (paths === null) return;
    const result = yield* attempt("stopping launchd service", () =>
      host.run("/bin/launchctl", ["bootout", paths.target], COMMAND_TIMEOUT_MS),
    );
    if (processSucceeded(result) || launchctlBootoutTargetNotFound(result)) return;
    return yield* new BootServiceError({
      operation: "stopping launchd service",
      cause:
        result.stderr ||
        result.stdout ||
        (result.timedOut
          ? "launchctl timed out"
          : `launchctl exited with code ${result.code ?? "null"}`),
    });
  });
  const disableTarget = Effect.gen(function* () {
    if (paths === null) return;
    const result = yield* attempt("disabling launchd service", () =>
      host.run("/bin/launchctl", ["disable", paths.target], COMMAND_TIMEOUT_MS),
    );
    if (processSucceeded(result) || launchctlDomainNotFound(result)) return;
    return yield* new BootServiceError({
      operation: "disabling launchd service",
      cause:
        result.stderr ||
        result.stdout ||
        (result.timedOut
          ? "launchctl timed out"
          : `launchctl exited with code ${result.code ?? "null"}`),
    });
  });
  const startAndProbe = Effect.gen(function* () {
    if (paths === null || userId === null) return;
    const current = yield* supervisorState;
    if (!current.loaded) {
      yield* runChecked("loading launchd service", [
        "bootstrap",
        `gui/${userId}`,
        paths.definitionPath,
      ]);
    }
    yield* runChecked("starting launchd service", ["kickstart", "-k", paths.target]);
    const started = yield* supervisorState;
    if (!started.processAlive || started.pid === undefined) {
      return yield* new BootServiceError({
        operation: "waiting for the background server to start",
        cause: "launchd did not report a running process after kickstart.",
      });
    }
    const startedPid = started.pid;
    const responsive = yield* attempt("waiting for the server health probe", () =>
      host.probeRuntime(paths.runtimeStatePath, startedPid, HEALTH_TIMEOUT_MS),
    );
    if (!responsive) {
      const state = yield* supervisorState;
      return yield* new BootServiceError({
        operation: "waiting for the background server to become responsive",
        cause: state.processAlive
          ? "The process is alive but its HTTP endpoint did not become responsive."
          : "launchd loaded the job but no server process remained alive.",
      });
    }
    const confirmed = yield* supervisorState;
    if (!confirmed.processAlive || confirmed.pid !== startedPid) {
      return yield* new BootServiceError({
        operation: "confirming background server ownership",
        cause: "launchd changed the service process during its health check.",
      });
    }
  });

  const status = Effect.gen(function* () {
    const fallbackPaths = paths ?? servicePaths({ homeDir, canonicalBaseDir, userId: userId ?? 0 });
    const [installed, versionExists] = yield* Effect.all(
      [
        attempt("checking service definition", () => host.exists(fallbackPaths.definitionPath)),
        attempt("checking service version", () => host.exists(fallbackPaths.versionPath)),
      ],
      { concurrency: "unbounded" },
    );
    const state =
      platform === "darwin" && paths !== null
        ? yield* supervisorState
        : ({ loaded: false, processAlive: false } satisfies SupervisorState);
    const statePid = state.pid;
    const responsive =
      state.processAlive &&
      statePid !== undefined &&
      (yield* attempt("probing the background server", () =>
        host.probeRuntime(fallbackPaths.runtimeStatePath, statePid, 1_000),
      ));
    const [installedVersion, definition] = yield* Effect.all(
      [
        versionExists
          ? attempt("reading service version", () => host.read(fallbackPaths.versionPath))
          : Effect.succeed(""),
        installed
          ? attempt("reading service definition", () => host.read(fallbackPaths.definitionPath))
          : Effect.succeed(""),
      ],
      { concurrency: "unbounded" },
    );
    return {
      ...fallbackPaths,
      supported: platform === "darwin" && paths !== null,
      platform,
      installed,
      enabled: platform === "darwin" && paths !== null ? yield* enabled : false,
      loaded: state.loaded,
      processAlive: state.processAlive,
      responsive,
      ...(state.pid === undefined ? {} : { pid: state.pid }),
      current:
        installedVersion.trim() === packageJson.version &&
        definition.includes(fallbackPaths.instanceId),
    } satisfies ServiceStatus;
  });

  return BootService.of({
    install: (invocation) =>
      withMutationLock(
        Effect.gen(function* () {
          yield* requireSupported;
          const activePaths = paths!;
          const packaged = yield* resolvePackagedDist(cliEntryPath, host);
          const candidateDir = join(
            activePaths.runtimesDir,
            `${packageJson.version}-${randomUUID()}`,
          );
          const candidateRuntime = join(candidateDir, "bin.mjs");
          const previousDefinitionExists = yield* attempt(
            "checking previous service definition",
            () => host.exists(activePaths.definitionPath),
          );
          const previousDefinition = previousDefinitionExists
            ? yield* attempt("reading previous service definition", () =>
                host.read(activePaths.definitionPath),
              )
            : undefined;
          const previousState = yield* supervisorState;
          const previouslyEnabled = yield* enabled;
          yield* attempt("creating private service directories", async () => {
            await host.makeDirectory(activePaths.instanceDir, 0o700);
            await host.makeDirectory(activePaths.runtimesDir, 0o700);
          });
          const copied = yield* attempt("copying the packaged runtime", () =>
            host.copyDirectory(packaged.distDir, candidateDir),
          ).pipe(Effect.exit);
          if (copied._tag === "Failure") {
            yield* attempt("removing partial runtime candidate", () =>
              host.remove(candidateDir, true),
            ).pipe(Effect.ignore);
            return yield* Effect.failCause(copied.cause);
          }
          yield* attempt("securing the packaged runtime", () => host.chmod(candidateDir, 0o700));
          const environment = {
            PATH: processEnvironment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            T3CODE_HOME: canonicalBaseDir,
            T3CODE_SERVICE_RUNTIME_STATE_PATH: activePaths.runtimeStatePath,
            T3CODE_NO_BROWSER: "true",
            T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
            T3CODE_BACKGROUND_SERVICE: "true",
            ...Object.fromEntries(
              [
                "T3CODE_RELAY_URL",
                "T3CODE_CLERK_PUBLISHABLE_KEY",
                "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
                "T3CODE_HOSTED_APP_URL",
              ].flatMap((name) => {
                const value = processEnvironment[name];
                return value === undefined ? [] : [[name, value] as const];
              }),
            ),
          };
          const plan: ServicePlan = {
            ...activePaths,
            baseDir: canonicalBaseDir,
            runtimePath: candidateRuntime,
            arguments: [
              executablePath,
              candidateRuntime,
              "serve",
              "--base-dir",
              canonicalBaseDir,
              ...(invocation.host === undefined ? [] : ["--host", invocation.host]),
              ...(invocation.port === undefined ? [] : ["--port", String(invocation.port)]),
              resolve(invocation.cwd),
            ],
            environment,
          };
          const definition = renderLaunchAgent(plan);
          const commit = Effect.gen(function* () {
            yield* attempt("writing the launchd definition", () =>
              host.writeAtomic(activePaths.definitionPath, definition, 0o600),
            );
            yield* runChecked("enabling launchd service", ["enable", activePaths.target]);
            yield* stopLoaded;
            yield* startAndProbe;
            yield* attempt("recording the active service version", () =>
              host.writeAtomic(activePaths.versionPath, `${packageJson.version}\n`, 0o600),
            );
          });
          const committed = yield* commit.pipe(Effect.exit);
          if (committed._tag === "Failure") {
            const stopped = yield* stopLoaded.pipe(Effect.exit);
            const removedCandidate = yield* attempt("removing failed runtime candidate", () =>
              host.remove(candidateDir, true),
            ).pipe(Effect.exit);
            const restoredDefinition = yield* (
              previousDefinition === undefined
                ? attempt("removing failed service definition", () =>
                    host.remove(activePaths.definitionPath),
                  )
                : attempt("restoring the previous service definition", () =>
                    host.writeAtomic(activePaths.definitionPath, previousDefinition, 0o600),
                  )
            ).pipe(Effect.exit);
            const restoredEnablement = yield* (
              previouslyEnabled
                ? runChecked("restoring launchd enablement", ["enable", activePaths.target])
                : disableTarget
            ).pipe(Effect.exit);
            const restarted =
              previousDefinition !== undefined &&
              previousState.loaded &&
              stopped._tag === "Success" &&
              restoredDefinition._tag === "Success"
                ? yield* startAndProbe.pipe(Effect.exit)
                : undefined;
            const rollbackFailure = [
              stopped,
              removedCandidate,
              restoredDefinition,
              restoredEnablement,
              ...(restarted === undefined ? [] : [restarted]),
            ].find((exit) => exit._tag === "Failure");
            if (rollbackFailure?._tag === "Failure") {
              return yield* Effect.failCause(rollbackFailure.cause);
            }
            return yield* Effect.failCause(committed.cause);
          }
          yield* attempt("pruning inactive service runtimes", async () => {
            const entries = await host.listDirectory(activePaths.runtimesDir);
            await Promise.all(
              entries
                .filter((entry) => join(activePaths.runtimesDir, entry) !== candidateDir)
                .map((entry) => host.remove(join(activePaths.runtimesDir, entry), true)),
            );
          });
          return plan;
        }),
      ),
    status,
    start: withMutationLock(requireSupported.pipe(Effect.andThen(startAndProbe))),
    restart: withMutationLock(
      requireSupported.pipe(Effect.andThen(stopLoaded), Effect.andThen(startAndProbe)),
    ),
    stop: withMutationLock(requireSupported.pipe(Effect.andThen(stopLoaded))),
    enable: withMutationLock(
      Effect.gen(function* () {
        yield* requireSupported;
        yield* runChecked("enabling launchd service", ["enable", paths!.target]);
        yield* startAndProbe;
      }),
    ),
    disable: withMutationLock(
      Effect.gen(function* () {
        yield* requireSupported;
        yield* stopLoaded;
        yield* disableTarget;
      }),
    ),
    uninstall: withMutationLock(
      Effect.gen(function* () {
        yield* requireSupported;
        const activePaths = paths!;
        const owned = yield* Effect.all([
          attempt("checking launchd definition", () => host.exists(activePaths.definitionPath)),
          attempt("checking service artifacts", () => host.exists(activePaths.instanceDir)),
        ]);
        const serviceState = yield* supervisorState;
        yield* stopLoaded;
        yield* disableTarget;
        yield* attempt("removing launchd definition", () =>
          host.remove(activePaths.definitionPath),
        );
        const servicePid = serviceState.pid;
        if (servicePid !== undefined) {
          yield* attempt("removing owned runtime state", () =>
            host.removeRuntimeStateIfOwned(activePaths.runtimeStatePath, servicePid),
          );
        }
        yield* attempt("removing service artifacts", () =>
          host.remove(activePaths.instanceDir, true),
        );
        return owned.some(Boolean);
      }),
    ),
  });
});

export const layer = (baseDir: string) => Layer.effect(BootService, make({ baseDir }));
