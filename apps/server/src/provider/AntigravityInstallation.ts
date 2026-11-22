// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or free-space query.
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ModelManifest from "./ModelManifest.ts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  ProviderDriverKind,
  type ProviderInstallState,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as EffectAcpErrors from "effect-acp/errors";
import { lock } from "proper-lockfile";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ANTIGRAVITY_CLI_MANIFEST_BASE,
  antigravityCliTarget,
  parseAntigravityCliRelease,
  type AntigravityCliReleaseAsset,
} from "./antigravityCliRelease.ts";
import { makeAntigravityAcpRuntime } from "./acp/AntigravityAcpSupport.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
} from "./antigravityAuthSupport.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const DOWNLOAD_TIMEOUT = "45 minutes";
const VALIDATION_TIMEOUT = "90 seconds";
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = ".install-complete.json";
const LARGE_PAGE_KERNEL_MESSAGE =
  "Google's linux-arm64 Antigravity runtime needs a kernel with 4 KiB memory pages, and this kernel uses larger pages (as on Asahi Linux or Raspberry Pi 5). Use a remote environment or a custom Antigravity executable.";

const ReleaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ActiveRelease = Schema.Struct({ releaseId: ReleaseId });
const InstalledRelease = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
});
type InstalledRelease = typeof InstalledRelease.Type;
const encodeActiveRelease = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
const encodeInstalledRelease = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));
const decodeInstalledRelease = Schema.decodeEffect(Schema.fromJsonString(InstalledRelease));

export class AntigravityInstallationError extends Schema.TaggedError<AntigravityInstallationError>()(
  "AntigravityInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallationError = Schema.is(AntigravityInstallationError);
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);

export interface AntigravityExecutable {
  readonly executablePath: string;
  readonly source: "override" | "managed" | "path";
  readonly version: string | null;
  readonly managedVersionDirectory: string | null;
}

interface AntigravityInstallationService {
  readonly managedDirectory: string;
  readonly resolve: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
  /** Hold the lease until the spawned process has exited. */
  readonly acquire: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError, Scope.Scope>;
  readonly compatibility: (
    version: string,
  ) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
  readonly start: Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly checkForUpdate: Effect.Effect<void>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, AntigravityInstallationError>;
}

export class AntigravityInstallation extends Context.Service<
  AntigravityInstallation,
  AntigravityInstallationService
>()("t3/provider/AntigravityInstallation") {
  static readonly layer = Layer.effect(
    AntigravityInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const settings = yield* ServerSettings.ServerSettingsService;
      return yield* makeAntigravityInstallation({
        baseDir: config.baseDir,
        updateChecksEnabled: settings.getSettings.pipe(
          Effect.map((value) => value.enableProviderUpdateChecks),
          Effect.orElseSucceed(() => false),
        ),
      });
    }),
  );
}

export interface AntigravityInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: AntigravityCliReleaseAsset | null;
  readonly updateChecksEnabled?: Effect.Effect<boolean>;
  readonly validate?: (
    executable: AntigravityExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, AntigravityInstallationError, Scope.Scope>;
}

const installationError = (operation: string, detail: string, cause?: unknown) =>
  new AntigravityInstallationError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);

function isAntigravityCli(...candidates: ReadonlyArray<string>) {
  return candidates.some((candidate) =>
    /^(?:agy|antigravity)(?:\.(?:exe|cmd|bat))?$/iu.test(candidate.split(/[\\/]/u).at(-1) ?? ""),
  );
}

function isRunning(state: ProviderInstallState) {
  return (
    state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying"
  );
}

export const makeAntigravityInstallation = Effect.fn("AntigravityInstallation.make")(function* (
  options: AntigravityInstallationOptions,
) {
  const manifestService = yield* ModelManifest.ModelManifest;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  let releaseAsset = options.releaseAsset ?? null;
  const supported =
    options.releaseAsset === undefined
      ? antigravityCliTarget(platform, arch) !== null
      : options.releaseAsset !== null;
  const cliExecutableName = platform === "win32" ? "agy.exe" : "antigravity";
  const managedDirectory = path.join(
    options.baseDir,
    "tools",
    "antigravity-acp",
    `${platform}-${arch}`,
  );
  const versionsDirectory = path.join(managedDirectory, "versions");
  const activePath = path.join(managedDirectory, "active.json");
  // Windows briefly keeps handles on fresh runtime files after taskkill or an antivirus scan; retry for up to 10 seconds.
  const retryWhileWindowsHoldsHandles = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
    effect.pipe(
      Effect.retry({
        times: platform === "win32" ? 40 : 0,
        schedule: Schedule.spaced("250 millis"),
        while: (error) =>
          error.reason._tag === "PermissionDenied" ||
          error.reason._tag === "Busy" ||
          error.reason._tag === "Unknown",
      }),
    );
  const gate = yield* Semaphore.make(1);
  const leases = new Map<string, number>();
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: releaseAsset?.version ?? null,
    installedVersion: null,
    canRemove: false,
    message: null,
  });

  const compatibility = Effect.fn("AntigravityInstallation.compatibility")(function* (
    version: string,
  ) {
    return ModelManifest.providerCompatibility(yield* manifestService.current, DRIVER, version);
  });
  const isWithdrawn = Effect.fn("AntigravityInstallation.isWithdrawn")(function* (version: string) {
    const status = (yield* compatibility(version))?.status;
    return status === "broken" || status === "unsupported";
  });
  const ensureEligible = Effect.fn("AntigravityInstallation.ensureEligible")(function* (
    version: string,
  ) {
    if (yield* isWithdrawn(version))
      return yield* installationError(
        "verify",
        "This Antigravity release was withdrawn. Check for updates and try again.",
      );
  });

  const readRecord = Effect.fn("AntigravityInstallation.readRecord")(function* <A>(
    filePath: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(filePath);
    if (info.type !== "File" || Number(info.size) > RECORD_MAX_BYTES) {
      return yield* installationError(
        "resolve",
        "The managed runtime record is invalid. Reinstall Antigravity.",
      );
    }
    const contents = yield* fs.readFileString(filePath);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents);
  });

  const executableFile = Effect.fn("AntigravityInstallation.executableFile")(function* (
    filePath: string,
    bytes?: number,
  ) {
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    return (
      Option.isSome(info) &&
      info.value.type === "File" &&
      (bytes === undefined || Number(info.value.size) === bytes) &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
    );
  });

  const isSymlink = Effect.fn("AntigravityInstallation.isSymlink")(function* (filePath: string) {
    return yield* fs.readLink(filePath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  });

  const isInsideDirectory = Effect.fn("AntigravityInstallation.isInsideDirectory")(function* (
    targetPath: string,
    rootDirectory: string,
  ) {
    const realRoot = yield* fs.realPath(rootDirectory).pipe(Effect.option);
    const realTarget = yield* fs.realPath(targetPath).pipe(Effect.option);
    if (Option.isNone(realRoot) || Option.isNone(realTarget)) return false;
    return (
      realTarget.value === realRoot.value ||
      realTarget.value.startsWith(`${realRoot.value}${path.sep}`)
    );
  });

  const hasSymlinkedManagedRoot = Effect.gen(function* () {
    return (yield* isSymlink(managedDirectory)) || (yield* isSymlink(versionsDirectory));
  });

  const ensureRealManagedRoot = Effect.fn("AntigravityInstallation.ensureRealManagedRoot")(
    function* (operation: "install" | "activate" | "resolve") {
      if (yield* hasSymlinkedManagedRoot) {
        return yield* installationError(
          operation,
          "The managed Antigravity directory is a symbolic link. Remove it and reinstall.",
        );
      }
    },
  );

  const isLockContentionError = (cause: unknown) =>
    isInstallationError(cause) &&
    Predicate.isObject(cause.cause) &&
    Predicate.hasProperty(cause.cause, "code") &&
    cause.cause.code === "ELOCKED";

  // Prevent the native CLI auto-updater from staging and replacing the managed binary in place.
  const lockReleaseDirectory = Effect.fn("AntigravityInstallation.lockReleaseDirectory")(function* (
    directory: string,
    executablePath: string,
    strict: boolean,
  ) {
    if (platform === "win32") return;
    const recordPath = path.join(directory, RELEASE_RECORD);
    const apply = Effect.gen(function* () {
      if (
        (yield* hasSymlinkedManagedRoot) ||
        (yield* isSymlink(directory)) ||
        (yield* isSymlink(executablePath)) ||
        (yield* isSymlink(recordPath)) ||
        !(yield* isInsideDirectory(directory, versionsDirectory)) ||
        !(yield* isInsideDirectory(executablePath, directory)) ||
        !(yield* isInsideDirectory(recordPath, directory))
      ) {
        return yield* installationError(
          "activate",
          "The managed Antigravity runtime contains an unexpected symbolic link. Reinstall it.",
        );
      }
      yield* fs.chmod(executablePath, 0o555);
      yield* fs.chmod(recordPath, 0o400);
      yield* fs.chmod(directory, 0o500);
    });
    if (strict) {
      yield* apply;
    } else {
      yield* apply.pipe(Effect.ignore);
    }
  });

  const unlockDirectoryTree = Effect.fn("AntigravityInstallation.unlockDirectoryTree")(function* (
    directory: string,
  ): Effect.fn.Return<void> {
    if (platform === "win32") return;
    if (
      (yield* hasSymlinkedManagedRoot) ||
      (yield* isSymlink(directory)) ||
      !(yield* isInsideDirectory(directory, managedDirectory))
    ) {
      return;
    }
    const info = yield* fs.stat(directory).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") return;
    yield* fs.chmod(directory, 0o700).pipe(Effect.ignore);
    const entries = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      if (yield* isSymlink(entryPath)) continue;
      const entryInfo = yield* fs.stat(entryPath).pipe(Effect.option);
      if (Option.isSome(entryInfo) && entryInfo.value.type === "Directory") {
        yield* unlockDirectoryTree(entryPath);
      }
    }
  });

  const removeReleaseDirectory = Effect.fn("AntigravityInstallation.removeReleaseDirectory")(
    function* (directory: string) {
      yield* unlockDirectoryTree(directory);
      yield* fs
        .remove(directory, { recursive: true, force: true })
        .pipe(retryWhileWindowsHoldsHandles);
    },
  );

  // Serialize resolve, publish, activation, pruning, and removal across server instances sharing managedDirectory.
  // Locking managedDirectory places the lock directory beside it so remove() can delete managedDirectory safely.
  const withManagedLock = <A, E, R>(
    operation: "activate" | "remove" | "resolve",
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AntigravityInstallationError, R> =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(managedDirectory, {
              realpath: false,
              stale: 30_000,
              update: 10_000,
              retries: { retries: 60, minTimeout: 25, maxTimeout: 150 },
              onCompromised: () => {},
            }),
          catch: (cause) =>
            installationError(
              operation,
              Predicate.isObject(cause) &&
                Predicate.hasProperty(cause, "code") &&
                cause.code === "ELOCKED"
                ? "Another Antigravity installation is already in progress. Try again."
                : "Could not lock the managed Antigravity directory. Try again.",
              cause,
            ),
        }),
        (release) => Effect.promise(() => release().catch(() => undefined)),
      ).pipe(Effect.andThen(effect)),
    );

  const inspectManagedFile = Effect.fn("AntigravityInstallation.inspectManagedFile")(function* (
    filePath: string,
    expectedBytes: number,
  ) {
    if (yield* isSymlink(filePath)) return "incomplete" as const;
    const info = yield* fs.stat(filePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (
      info === null ||
      info.type !== "File" ||
      (platform !== "win32" && (info.mode & 0o111) === 0)
    ) {
      return "incomplete" as const;
    }
    return Number(info.size) === expectedBytes ? ("ok" as const) : ("changed" as const);
  });

  const inspectRelease = Effect.fn("AntigravityInstallation.inspectRelease")(function* (
    releaseId: string,
  ) {
    const incomplete = () =>
      ({
        _tag: "repairable",
        error: installationError(
          "resolve",
          "The managed Antigravity runtime is incomplete. Reinstall it.",
        ),
      }) as const;
    const invalidRecord = (cause?: unknown) =>
      ({
        _tag: "repairable",
        error: installationError(
          "resolve",
          "The managed runtime record is invalid. Reinstall Antigravity.",
          cause,
        ),
      }) as const;
    if (yield* hasSymlinkedManagedRoot) return incomplete();
    const directory = path.join(versionsDirectory, releaseId);
    if (yield* isSymlink(directory)) return incomplete();
    const directoryInfo = yield* fs.stat(directory).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (directoryInfo === null || directoryInfo.type !== "Directory") return incomplete();
    const recordPath = path.join(directory, RELEASE_RECORD);
    if (yield* isSymlink(recordPath)) return incomplete();
    const recordInfo = yield* fs.stat(recordPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (recordInfo === null) return incomplete();
    if (recordInfo.type !== "File" || Number(recordInfo.size) > RECORD_MAX_BYTES) {
      return invalidRecord();
    }
    const readResult = yield* fs.readFileString(recordPath).pipe(
      Effect.map((contents) => ({ _tag: "ok" as const, contents })),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed({ _tag: "missing" as const }),
      ),
      Effect.catchIf(
        (error) => error.reason._tag === "PermissionDenied",
        (error) => Effect.succeed({ _tag: "unreadable" as const, error }),
      ),
    );
    if (readResult._tag === "missing") return incomplete();
    if (readResult._tag === "unreadable") return invalidRecord(readResult.error);
    const decoded = yield* decodeInstalledRelease(readResult.contents).pipe(Effect.option);
    if (Option.isNone(decoded)) return invalidRecord();
    const record = decoded.value;
    if (record.releaseId === releaseId && record.executable.name !== cliExecutableName) {
      return {
        _tag: "repairable" as const,
        error: installationError(
          "resolve",
          `Antigravity ${record.version} predates the Antigravity CLI and no longer works with this T3 Code release. Update it in Antigravity setup.`,
        ),
      };
    }
    if (
      record.releaseId !== releaseId ||
      !Number.isSafeInteger(record.executable.bytes) ||
      record.executable.bytes <= 0 ||
      !record.version.trim()
    ) {
      return incomplete();
    }
    const executablePath = path.join(directory, record.executable.name);
    const executableStatus = yield* inspectManagedFile(executablePath, record.executable.bytes);
    if (executableStatus === "incomplete") return incomplete();
    if (executableStatus === "changed") {
      return {
        _tag: "repairable" as const,
        error: installationError(
          "resolve",
          "The managed Antigravity runtime changed on disk. Reinstall it in Antigravity setup.",
        ),
      };
    }
    return {
      _tag: "valid" as const,
      executable: {
        executablePath,
        source: "managed" as const,
        version: record.version,
        managedVersionDirectory: directory,
      } satisfies AntigravityExecutable,
    };
  });

  const completedRelease = Effect.fn("AntigravityInstallation.completedRelease")(function* (
    releaseId: string,
  ) {
    const inspected = yield* inspectRelease(releaseId);
    if (inspected._tag === "repairable") return yield* inspected.error;
    return inspected.executable;
  });

  const isManagedVersionCandidate = Effect.fn("AntigravityInstallation.isManagedVersionCandidate")(
    function* (executablePath: string) {
      const realVersions = yield* fs.realPath(versionsDirectory).pipe(Effect.option);
      const directory = path.dirname(executablePath);
      return (
        Option.isSome(realVersions) &&
        path.dirname(directory) === realVersions.value &&
        /^[a-f0-9]{64}$/u.test(path.basename(directory))
      );
    },
  );

  const fromExternal = Effect.fn("AntigravityInstallation.fromExternal")(function* (
    candidate: string,
    source: "override" | "path",
  ) {
    if (!(yield* executableFile(candidate))) return null;
    const executablePath = yield* fs.realPath(candidate);
    const directory = path.dirname(executablePath);
    if (yield* isManagedVersionCandidate(executablePath)) {
      const installed = yield* completedRelease(path.basename(directory));
      return { ...installed, source };
    }
    // Keep launcher symlinks intact: version-manager shims dispatch by their invoked name.
    if (!isAntigravityCli(candidate, executablePath)) return null;
    return {
      executablePath: candidate,
      source,
      version: null,
      managedVersionDirectory: null,
    } satisfies AntigravityExecutable;
  });

  // Resolve a verified external CLI outside versions/ without taking the managed lock, so a
  // read-only managed parent or active repair does not block unrelated external executables.
  const findVerifiedExternal = Effect.fn("AntigravityInstallation.findVerifiedExternal")(function* (
    candidates: ReadonlyArray<string>,
    source: "override" | "path",
  ) {
    for (const candidate of candidates) {
      if (!(yield* executableFile(candidate))) continue;
      const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
      if (Option.isNone(resolved)) return null;
      const executablePath = resolved.value;
      if (yield* isManagedVersionCandidate(executablePath)) return null;
      if (isAntigravityCli(candidate, executablePath)) {
        return {
          executablePath: candidate,
          source,
          version: null,
          managedVersionDirectory: null,
        } satisfies AntigravityExecutable;
      }
    }
    return null;
  });

  const commandPath = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.map((resolved) => (resolved === null ? null : path.resolve(resolved))),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  // Resolve per PATH entry so a candidate that is not the CLI falls through to later entries.
  const commandCandidates = Effect.fn("AntigravityInstallation.commandCandidates")(function* (
    command: string,
    processEnvironment = environment,
  ) {
    if (command.includes("/") || command.includes("\\")) {
      const resolved = yield* commandPath(command, processEnvironment);
      return resolved === null ? [] : [resolved];
    }
    const pathValue =
      platform === "win32"
        ? Object.entries(processEnvironment).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
        : processEnvironment.PATH;
    const candidates: string[] = [];
    for (const entry of (pathValue ?? "").split(platform === "win32" ? ";" : ":")) {
      if (entry.length === 0) continue;
      const resolved = yield* commandPath(command, { ...processEnvironment, PATH: entry });
      if (resolved !== null) candidates.push(resolved);
    }
    return candidates;
  });

  const resolveUnlocked = Effect.fn("AntigravityInstallation.resolveUnlocked")(function* (
    binaryPath?: string,
    processEnvironment?: NodeJS.ProcessEnv,
  ) {
    const override = expandHomePath(binaryPath?.trim() ?? "", yield* HostProcess.HomeDirectory);
    if (override) {
      for (const candidate of yield* commandCandidates(override, processEnvironment)) {
        const selected = yield* fromExternal(candidate, "override");
        if (selected) return selected;
      }
      return yield* installationError(
        "resolve",
        "The custom Antigravity executable is missing or not executable, or it is not the agy CLI.",
      );
    }
    if (yield* fs.exists(activePath)) {
      yield* ensureRealManagedRoot("resolve");
      const active = yield* readRecord(activePath, ActiveRelease);
      const installed = yield* completedRelease(active.releaseId);
      if (yield* isWithdrawn(installed.version))
        return yield* installationError(
          "resolve",
          `Antigravity ${installed.version} no longer works with this T3 Code release. Update it in Antigravity setup.`,
        );
      return installed;
    }
    for (const candidate of yield* commandCandidates("agy", processEnvironment)) {
      const selected = yield* fromExternal(candidate, "path");
      if (selected) return selected;
    }
    return yield* installationError(
      "resolve",
      supported
        ? "Antigravity ACP runtime is not installed. Install it in this environment's provider settings or set a custom ACP executable path. The Antigravity app, IDE, and CLI are separate installations."
        : `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported environment or a custom executable.`,
    );
  });

  const resolve: AntigravityInstallationService["resolve"] = Effect.fn(
    "AntigravityInstallation.resolve",
  )(
    function* (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) {
      const override = expandHomePath(binaryPath?.trim() ?? "", yield* HostProcess.HomeDirectory);
      if (override) {
        const external = yield* findVerifiedExternal(
          yield* commandCandidates(override, processEnvironment),
          "override",
        );
        if (external !== null) return external;
      }
      const lookup = resolveUnlocked(binaryPath, processEnvironment);
      if (!(yield* fs.exists(managedDirectory))) return yield* lookup;
      return yield* withManagedLock("resolve", lookup).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (!override && !(yield* fs.exists(activePath))) {
              const external = yield* findVerifiedExternal(
                yield* commandCandidates("agy", processEnvironment),
                "path",
              );
              if (external !== null) return external;
            }
            return yield* cause;
          }),
        ),
      );
    },
    Effect.mapError(
      wrapFailure(
        "resolve",
        "Could not read the Antigravity installation. Reinstall it or set a custom executable path.",
      ),
    ),
  );

  const acquire = (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) =>
    Effect.acquireRelease(
      gate.withPermit(
        Effect.gen(function* () {
          const executable = yield* resolve(binaryPath, processEnvironment);
          const directory = executable.managedVersionDirectory;
          if (directory) leases.set(directory, (leases.get(directory) ?? 0) + 1);
          return executable;
        }),
      ),
      (executable) =>
        gate.withPermit(
          Effect.sync(() => {
            const directory = executable.managedVersionDirectory;
            if (!directory) return;
            const remaining = (leases.get(directory) ?? 1) - 1;
            if (remaining > 0) leases.set(directory, remaining);
            else leases.delete(directory);
          }),
        ),
    );

  const withValidationTimeout = Effect.timeoutOrElse({
    duration: VALIDATION_TIMEOUT,
    orElse: () =>
      Effect.fail(
        installationError(
          "verify",
          "Antigravity runtime verification timed out after 90 seconds. Check this environment's server logs for startup errors, then retry installation.",
        ),
      ),
  });
  const validate =
    options.validate ??
    Effect.fn("AntigravityInstallation.validate")(
      function* (executable: AntigravityExecutable, expectedVersion: string) {
        const validationScope = yield* Effect.scope;
        const profileDirectory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "t3-antigravity-validate-" }),
          (directory) =>
            fs
              .remove(directory, { recursive: true, force: true })
              .pipe(retryWhileWindowsHoldsHandles, Effect.orDie),
        );
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          platform,
          baseEnv: environment,
          // A shallow scoped profile cleans up unpacked files within Windows' path limit.
          tempDirectory: profileDirectory,
        });
        const runtime = yield* makeAntigravityAcpRuntime({
          runtimeVersion: expectedVersion,
          spawn: buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd: profileDirectory,
            baseEnv: environment,
          }),
          cwd: profileDirectory,
          childProcessSpawner:
            platform === "win32"
              ? ChildProcessSpawner.make(
                  Effect.fnUntraced(function* (command) {
                    const child = yield* spawner.spawn(command);
                    // Stop PyInstaller's tree before ACP closes pipes; after launcher exit, taskkill cannot reach children holding DLLs open.
                    yield* Scope.addFinalizer(
                      validationScope,
                      child.kill({ forceKillAfter: "1 second" }).pipe(Effect.orDie),
                    );
                    return child;
                  }),
                )
              : spawner,
        });
        const initialized = yield* runtime.initialize();
        if (
          initialized.agentInfo?.name !== "Antigravity ACP Server" ||
          initialized.agentInfo?.version !== expectedVersion ||
          (initialized.protocolVersion !== 1 && initialized.protocolVersion !== 2) ||
          initialized.agentCapabilities?.loadSession !== true ||
          !initialized.agentCapabilities.sessionCapabilities?.resume ||
          !initialized.agentCapabilities.auth?.logout ||
          !initialized.authMethods?.some((method) => method.id === "oauth-personal")
        ) {
          return yield* installationError(
            "verify",
            "The downloaded runtime did not identify as the expected Google Antigravity release.",
          );
        }
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.mapError((cause) => {
        if (isInstallationError(cause)) return cause;
        const stderr = isAcpProcessExitedError(cause) ? (cause.stderr ?? "") : "";
        const detail = /\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/.test(stderr)
          ? "Antigravity requires IPv6 socket support. Enable IPv6 in this environment. On WSL, remove ipv6.disable=1 from .wslconfig and run wsl --shutdown."
          : /page-size\.cc|Compile-time page size does not match/.test(stderr)
            ? LARGE_PAGE_KERNEL_MESSAGE
            : "The downloaded Antigravity runtime could not start in this environment.";
        return installationError("verify", detail, cause);
      }),
    );

  // Each update lands in its own directory. Best effort: a busy gate means a session is
  // resolving, so the next start or update finishes the cleanup.
  const pruneInactiveReleasesBody = Effect.gen(function* () {
    if ((yield* isSymlink(managedDirectory)) || (yield* isSymlink(versionsDirectory))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    for (const entry of yield* fs.readDirectory(versionsDirectory)) {
      if (entry === active.releaseId || !/^[a-f0-9]{64}$/u.test(entry)) continue;
      const directory = path.join(versionsDirectory, entry);
      if (leases.has(directory)) continue;
      yield* removeReleaseDirectory(directory).pipe(Effect.ignore);
    }
  });

  const pruneInactiveReleases = Effect.gen(function* () {
    if (!(yield* fs.exists(activePath))) return;
    yield* withManagedLock("activate", pruneInactiveReleasesBody);
  }).pipe(
    gate.withPermitsIfAvailable(1),
    Effect.ignore,
    Effect.withSpan("AntigravityInstallation.pruneInactiveReleases"),
  );

  const install = Effect.fn("AntigravityInstallation.install")(
    function* (asset: AntigravityCliReleaseAsset) {
      yield* ensureEligible(asset.version);
      // Release IDs are 64 hex characters, so a release is named by its SHA-512's prefix.
      const releaseId = asset.sha512.slice(0, 64);
      yield* resolveNodeExecutable("Antigravity", environment).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.mapError((cause) =>
          installationError("verify", nodeRuntimeUnavailableMessage("Antigravity"), cause),
        ),
      );
      const report = (phase: ProviderInstallState["phase"], message: string | null) =>
        SubscriptionRef.update(state, (current) => ({ ...current, phase, message }));
      yield* ensureRealManagedRoot("install");
      yield* fs.makeDirectory(versionsDirectory, { recursive: true });
      yield* ensureRealManagedRoot("install");
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(versionsDirectory, releaseId);
      const writeAndActivate = Effect.fn("AntigravityInstallation.writeAndActivate")(function* (
        pointerDirectory: string,
      ) {
        yield* ensureRealManagedRoot("activate");
        yield* ensureEligible(asset.version);
        const inspected = yield* inspectRelease(releaseId);
        if (inspected._tag !== "valid" || inspected.executable.version !== asset.version) {
          return yield* installationError(
            "activate",
            "Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.",
          );
        }
        yield* lockReleaseDirectory(destination, inspected.executable.executablePath, true);
        const pointerPath = path.join(pointerDirectory, "contents.tmp");
        yield* fs.writeFileString(pointerPath, yield* encodeActiveRelease({ releaseId }), {
          flag: "wx",
          mode: 0o600,
        });
        yield* fs.rename(pointerPath, activePath);
        yield* pruneInactiveReleasesBody.pipe(Effect.ignore);
        yield* SubscriptionRef.update(
          state,
          (current) =>
            ({
              ...current,
              phase: "succeeded",
              installedVersion: asset.version,
              message: null,
            }) satisfies ProviderInstallState,
        );
      });
      const activate = Effect.fn("AntigravityInstallation.activate")(
        function* () {
          const pointerDirectory = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: "active.json.",
          });
          yield* gate.withPermit(
            withManagedLock(
              "activate",
              writeAndActivate(pointerDirectory).pipe(Effect.uninterruptible),
            ),
          );
        },
        Effect.scoped,
        Effect.mapError(
          wrapFailure(
            "activate",
            "Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.",
          ),
        ),
      );

      if ((yield* fs.exists(destination)) || (yield* isSymlink(destination))) {
        const existing = yield* inspectRelease(releaseId);
        if (existing._tag === "valid") {
          if (existing.executable.version !== asset.version) {
            return yield* installationError(
              "verify",
              "The existing managed release has the wrong version. Remove it before reinstalling.",
            );
          }
          yield* report("verifying", "Checking the installed runtime.");
          yield* validate(existing.executable, asset.version).pipe(
            Effect.scoped,
            withValidationTimeout,
          );
          yield* activate();
          return;
        }
      }

      const available = yield* Effect.tryPromise({
        try: () => NodeFSP.statfs(versionsDirectory, { bigint: true }),
        catch: (cause) => installationError("download", "Could not check free disk space.", cause),
      }).pipe(Effect.option);
      const required = MAX_DOWNLOAD_BYTES + MAX_EXECUTABLE_BYTES + FREE_SPACE_MARGIN;
      if (
        Option.isSome(available) &&
        available.value.bavail * available.value.bsize < BigInt(required)
      ) {
        return yield* installationError(
          "download",
          `Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`,
        );
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: versionsDirectory,
        prefix: ".install-",
      });
      yield* Effect.addFinalizer(() => unlockDirectoryTree(staging).pipe(Effect.ignore));
      const archivePath = path.join(staging, "download");
      const pairDirectory = path.join(staging, "runtime");
      yield* fs.makeDirectory(pairDirectory);
      const hash = NodeCrypto.createHash("sha512");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        const response = yield* http
          .execute(HttpClientRequest.get(asset.url))
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              downloadedBytes += chunk.byteLength;
              if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
                return yield* installationError(
                  "download",
                  "The Antigravity download exceeded its allowed size.",
                );
              }
              hash.update(chunk);
              const now = yield* Clock.currentTimeMillis;
              if (now - lastProgressAt >= 250) {
                lastProgressAt = now;
                yield* SubscriptionRef.update(state, (current) => ({
                  ...current,
                  downloadedBytes,
                }));
              }
            }),
          ),
          Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        );
      }).pipe(
        Effect.timeout(DOWNLOAD_TIMEOUT),
        Effect.mapError((cause) =>
          HttpClientError.isHttpClientError(cause) || Cause.isTimeoutError(cause)
            ? installationError(
                "download",
                "Could not download Antigravity from Google. Check the network connection and any proxy settings, then try again.",
                cause,
              )
            : cause,
        ),
      );
      if (hash.digest("hex") !== asset.sha512) {
        return yield* installationError(
          "download",
          "The Antigravity download failed its size or checksum check. Nothing was installed.",
        );
      }

      yield* report("extracting", "Extracting the verified runtime.");
      const executablePath = path.join(pairDirectory, asset.executable.name);
      if (asset.format === "executable") {
        yield* fs.copyFile(archivePath, executablePath);
      } else {
        const tar = cliArchiveTarCommand(platform, environment);
        const list = yield* spawner.string(ChildProcess.make(tar, ["-tzf", archivePath]));
        const types = yield* spawner.string(ChildProcess.make(tar, ["-tvzf", archivePath]));
        if (
          list.trim() !== asset.executable.name ||
          types.trim().split(/\r?\n/u).length !== 1 ||
          !types.startsWith("-")
        ) {
          return yield* installationError(
            "extract",
            "The Antigravity archive must contain one regular executable.",
          );
        }
        yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(tar, ["-xOzf", archivePath, asset.executable.name], {
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          let extractedBytes = 0;
          yield* child.stdout.pipe(
            Stream.tap((chunk) =>
              Effect.gen(function* () {
                extractedBytes += chunk.byteLength;
                if (extractedBytes > MAX_EXECUTABLE_BYTES)
                  return yield* installationError(
                    "extract",
                    "The Antigravity executable exceeded its size limit.",
                  );
              }),
            ),
            Stream.run(fs.sink(executablePath, { flag: "wx", mode: 0o700 })),
          );
          if ((yield* child.exitCode) !== 0 || extractedBytes === 0)
            return yield* installationError(
              "extract",
              "Could not extract the Antigravity executable.",
            );
        }).pipe(Effect.scoped);
      }
      yield* fs.remove(archivePath);
      if (platform !== "win32") yield* fs.chmod(executablePath, 0o755);
      yield* report("verifying", "Checking the downloaded runtime.");
      yield* validate(
        {
          executablePath,
          source: "managed",
          version: asset.version,
          managedVersionDirectory: pairDirectory,
        },
        asset.version,
      ).pipe(Effect.scoped, withValidationTimeout);
      const record: InstalledRelease = {
        releaseId,
        version: asset.version,
        executable: {
          name: asset.executable.name,
          bytes: Number((yield* fs.stat(executablePath)).size),
        },
      };
      yield* fs.writeFileString(
        path.join(pairDirectory, RELEASE_RECORD),
        yield* encodeInstalledRelease(record),
        { flag: "wx", mode: 0o600 },
      );
      // Lock files read-only before publishing; the directory itself is locked after cross-parent rename
      // because macOS requires write permission on a moved directory to update its `..` entry.
      if (platform !== "win32") {
        yield* fs.chmod(executablePath, 0o555);
        yield* fs.chmod(path.join(pairDirectory, RELEASE_RECORD), 0o400);
      }
      const published = yield* Effect.scoped(
        Effect.gen(function* () {
          const pointerDirectory = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: "active.json.",
          });
          return yield* gate.withPermit(
            withManagedLock(
              "activate",
              Effect.gen(function* () {
                yield* ensureRealManagedRoot("activate");
                const destinationExisted =
                  (yield* fs.exists(destination)) || (yield* isSymlink(destination));
                if (!destinationExisted) {
                  const renameError = yield* fs.rename(pairDirectory, destination).pipe(
                    retryWhileWindowsHoldsHandles,
                    Effect.as(null),
                    Effect.catch((cause) => Effect.succeed(cause)),
                  );
                  if (renameError === null) {
                    const activateError = yield* writeAndActivate(pointerDirectory).pipe(
                      Effect.as(null),
                      Effect.catch((cause) => Effect.succeed(cause)),
                    );
                    if (activateError !== null) {
                      yield* removeReleaseDirectory(destination).pipe(Effect.ignore);
                      return yield* activateError;
                    }
                    return { _tag: "published" as const };
                  }
                  if (!(yield* fs.exists(destination)) && !(yield* isSymlink(destination))) {
                    return yield* installationError(
                      "activate",
                      "Could not publish the Antigravity runtime. The previous release is unchanged. Try again.",
                      renameError,
                    );
                  }
                }
                const inspected = yield* inspectRelease(releaseId);
                if (inspected._tag === "valid") {
                  if (inspected.executable.version !== asset.version) {
                    return yield* installationError(
                      "activate",
                      "Another installation published a different Antigravity release.",
                    );
                  }
                  return { _tag: "existing" as const, executable: inspected.executable };
                }
                // acquire() cannot lease a broken release, but an already-running session may hold one.
                if (leases.has(destination)) {
                  return yield* installationError(
                    "activate",
                    "Stop Antigravity sessions and sign-in flows before reinstalling its managed runtime.",
                  );
                }
                // Move the damaged release aside into staging so failure can restore it.
                const displaced = path.join(staging, "displaced");
                yield* unlockDirectoryTree(destination);
                yield* fs.rename(destination, displaced).pipe(
                  retryWhileWindowsHoldsHandles,
                  Effect.mapError((cause) =>
                    installationError(
                      "activate",
                      "Could not replace the damaged Antigravity runtime. Check for open processes and try again.",
                      cause,
                    ),
                  ),
                );
                const publishError = yield* fs.rename(pairDirectory, destination).pipe(
                  retryWhileWindowsHoldsHandles,
                  Effect.as(null),
                  Effect.catch((cause) => Effect.succeed(cause)),
                );
                if (publishError !== null) {
                  const restored = yield* fs.rename(displaced, destination).pipe(
                    retryWhileWindowsHoldsHandles,
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  );
                  return yield* installationError(
                    "activate",
                    restored
                      ? "Could not replace the damaged Antigravity runtime. The previous files were restored. Try again."
                      : "Could not replace the damaged Antigravity runtime, and the damaged files could not be restored. Reinstall Antigravity.",
                    publishError,
                  );
                }
                const activateError = yield* writeAndActivate(pointerDirectory).pipe(
                  Effect.as(null),
                  Effect.catch((cause) => Effect.succeed(cause)),
                );
                if (activateError !== null) {
                  const rolledBack = yield* Effect.gen(function* () {
                    yield* removeReleaseDirectory(destination);
                    yield* fs.rename(displaced, destination).pipe(retryWhileWindowsHoldsHandles);
                  }).pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  );
                  return yield* installationError(
                    "activate",
                    rolledBack
                      ? "Could not activate the repaired Antigravity runtime. The previous files were restored. Try again."
                      : "Could not activate the repaired Antigravity runtime, and the damaged files could not be restored. Reinstall Antigravity.",
                    activateError,
                  );
                }
                return { _tag: "published" as const };
              }).pipe(
                Effect.mapError((error) =>
                  isInstallationError(error)
                    ? error
                    : installationError(
                        "activate",
                        "Could not publish the Antigravity runtime. The previous release is unchanged. Try again.",
                        error,
                      ),
                ),
                Effect.uninterruptible,
              ),
            ),
          );
        }),
      );
      if (published._tag === "existing") {
        yield* validate(published.executable, asset.version).pipe(
          Effect.scoped,
          withValidationTimeout,
        );
        yield* activate();
      }
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Antigravity. Check free disk space and directory access, then try again.",
      ),
    ),
  );

  let lastUpdateCheck: number | undefined;
  const refreshRelease = Effect.fn("AntigravityInstallation.refreshRelease")(function* (
    explicit = false,
  ) {
    if (options.releaseAsset !== undefined || !supported) return;
    if (!explicit && !(yield* options.updateChecksEnabled ?? Effect.succeed(true))) return;
    const now = yield* Clock.currentTimeMillis;
    if (!explicit && lastUpdateCheck !== undefined && now - lastUpdateCheck < UPDATE_CHECK_INTERVAL)
      return;
    lastUpdateCheck = now;
    const musl =
      platform === "linux" &&
      (yield* fs.exists(
        arch === "arm64" ? "/lib/libc.musl-aarch64.so.1" : "/lib/libc.musl-x86_64.so.1",
      ));
    const target = antigravityCliTarget(platform, arch, musl);
    const latest = yield* http.get(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => parseAntigravityCliRelease(json, platform, arch, musl)),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    );
    if (latest === null) return;
    if (yield* isWithdrawn(latest.version)) {
      releaseAsset = null;
      return;
    }
    releaseAsset = latest;
    yield* SubscriptionRef.updateEffect(state, (value) =>
      isRunning(value)
        ? Effect.succeed(value)
        : Effect.gen(function* () {
            const keepInstalled =
              value.installedVersion !== null &&
              compareSemverVersions(value.installedVersion, latest.version) > 0 &&
              !(yield* isWithdrawn(value.installedVersion));
            return {
              ...value,
              version: keepInstalled ? value.installedVersion : latest.version,
              totalBytes: null,
            };
          }),
    );
  });

  const start = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (isRunning(current)) return current;
    yield* refreshRelease(true);
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        if (!supported) {
          return yield* installationError(
            "start",
            `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
          );
        }
        const asset =
          releaseAsset !== null && !(yield* isWithdrawn(releaseAsset.version))
            ? releaseAsset
            : null;
        const installed = yield* resolve().pipe(Effect.option);
        const reuse =
          Option.isSome(installed) &&
          installed.value.source === "managed" &&
          (asset === null || compareSemverVersions(installed.value.version!, asset.version) > 0)
            ? installed.value
            : undefined;
        if (asset === null && reuse === undefined)
          return yield* installationError(
            "start",
            "Could not find a native Antigravity CLI release. Check the network connection and try again.",
          );
        const operationId = yield* random.uuidV4();
        const next: ProviderInstallState = {
          driver: DRIVER,
          operationId,
          phase: reuse === undefined ? "downloading" : "verifying",
          downloadedBytes: 0,
          totalBytes: null,
          version: reuse?.version ?? asset?.version ?? null,
          installedVersion: current.installedVersion,
          canRemove: current.canRemove,
          message:
            reuse === undefined
              ? "Downloading Google's official Antigravity runtime."
              : "Checking the installed runtime.",
        };
        yield* SubscriptionRef.set(state, next);
        const work = (
          reuse === undefined
            ? install(asset!)
            : validate(reuse, reuse.version!).pipe(
                Effect.scoped,
                withValidationTimeout,
                Effect.andThen(ensureEligible(reuse.version!)),
                Effect.andThen(
                  SubscriptionRef.update(state, (value) => ({
                    ...value,
                    phase: "succeeded" as const,
                    installedVersion: reuse.version,
                    message: null,
                  })),
                ),
              )
        ).pipe(
          Effect.mapError(
            wrapFailure("verify", "Could not verify the installed Antigravity runtime."),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? SubscriptionRef.update(state, (value) => {
                  if (value.operationId !== operationId || value.phase === "succeeded")
                    return value;
                  const error = Cause.findErrorOption(exit.cause);
                  const cancelled = Cause.hasInterruptsOnly(exit.cause);
                  return {
                    ...value,
                    phase: cancelled ? "cancelled" : "failed",
                    message: cancelled
                      ? "Installation cancelled. The previous runtime is unchanged."
                      : Option.isSome(error)
                        ? error.value.detail
                        : "Could not finish the Antigravity installation. Check disk space and directory access.",
                  } satisfies ProviderInstallState;
                })
              : Effect.void,
          ),
          Effect.ignoreCause,
          Effect.ensuring(
            Effect.sync(() => {
              if (running?.operationId === operationId) running = undefined;
            }),
          ),
        );
        const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
        running = { operationId, fiber };
        return next;
      }).pipe(Effect.uninterruptible),
    );
  }).pipe(Effect.mapError(wrapFailure("start", "Could not start the Antigravity installation.")));

  const cancel = Effect.fn("AntigravityInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId) {
          return yield* installationError(
            "cancel",
            "This installation is no longer current. Refresh its status before cancelling.",
          );
        }
        if (running?.operationId === operationId && isRunning(current)) {
          yield* Fiber.interrupt(running.fiber);
        }
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = Effect.fn("AntigravityInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases.size > 0) {
            return yield* installationError(
              "remove",
              "Stop Antigravity sessions and sign-in flows before removing its managed runtime.",
            );
          }
          if ((yield* fs.exists(managedDirectory)) || (yield* isSymlink(managedDirectory))) {
            const homeDirectory = yield* HostProcess.HomeDirectory;
            yield* withManagedLock(
              "remove",
              Effect.gen(function* () {
                const managedIsSymlink = yield* isSymlink(managedDirectory);
                if (!managedIsSymlink) {
                  const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
                  if (Option.isSome(realManaged)) {
                    for (const binaryPath of protectedBinaryPaths) {
                      const trimmed = binaryPath.trim();
                      if (!trimmed) continue;
                      const selected = yield* resolveUnlocked(trimmed).pipe(Effect.option);
                      if (Option.isSome(selected) && selected.value.managedVersionDirectory) {
                        return yield* installationError(
                          "remove",
                          "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                        );
                      }
                      const expanded = expandHomePath(trimmed, homeDirectory);
                      const resolved = yield* fs.realPath(expanded).pipe(Effect.option);
                      const candidate = Option.getOrElse(resolved, () => path.resolve(expanded));
                      if (candidate.startsWith(`${realManaged.value}${path.sep}`)) {
                        return yield* installationError(
                          "remove",
                          "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                        );
                      }
                    }
                  }
                  if (!(yield* isSymlink(versionsDirectory))) {
                    yield* unlockDirectoryTree(versionsDirectory);
                  }
                }
                yield* fs
                  .remove(managedDirectory, { recursive: true, force: true })
                  .pipe(retryWhileWindowsHoldsHandles);
              }),
            );
          }
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Antigravity runtime. Check for open processes and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    const canRemove = (yield* fs.exists(managedDirectory)) || (yield* isSymlink(managedDirectory));
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (!(yield* fs.exists(activePath))) return;
    yield* gate.withPermit(
      withManagedLock(
        "activate",
        Effect.gen(function* () {
          if (!(yield* fs.exists(activePath))) {
            const exists =
              (yield* fs.exists(managedDirectory)) || (yield* isSymlink(managedDirectory));
            yield* SubscriptionRef.update(state, (current) => ({
              ...current,
              canRemove: exists,
            }));
            return;
          }
          yield* ensureRealManagedRoot("activate");
          const active = yield* readRecord(activePath, ActiveRelease);
          const installed = yield* completedRelease(active.releaseId);
          if (installed.managedVersionDirectory !== null) {
            yield* lockReleaseDirectory(
              installed.managedVersionDirectory,
              installed.executablePath,
              false,
            );
          }
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            installedVersion: installed.version,
          }));
        }),
      ),
    );
  }).pipe(
    Effect.catch((cause) =>
      isLockContentionError(cause)
        ? Effect.void
        : SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                phase: "failed",
                message: isInstallationError(cause)
                  ? cause.detail
                  : "The managed Antigravity runtime is incomplete. Remove it and reinstall.",
              }) satisfies ProviderInstallState,
          ),
    ),
  );

  // A startup install prunes when it activates; pruning now could delete the release it is verifying.
  if (!isRunning(yield* SubscriptionRef.get(state))) yield* pruneInactiveReleases;

  return AntigravityInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    compatibility,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    checkForUpdate: refreshRelease().pipe(Effect.ignore),
    remove,
  });
});
