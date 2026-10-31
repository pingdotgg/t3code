// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.remove cannot remove an empty directory nonrecursively.
import * as NodeFSP from "node:fs/promises";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import type {
  RelayClientInstallProgressEvent,
  RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isWindowsRenameLock } from "./atomicWrite.ts";
import * as HostProcess from "./HostProcess.ts";

export const CLOUDFLARED_VERSION = "2026.10.4";
// Minimum for --output support; older connectors exit on that flag.
export const CLOUDFLARED_MIN_VERSION = "2025.6.1";
const CLOUDFLARED_PATH_ENV_NAME = "T3CODE_CLOUDFLARED_PATH";

const CLOUDFLARED_DOWNLOAD_TIMEOUT = "10 minutes";

export type RelayClientExecutableSource = "override" | "managed" | "path";

export type RelayClientStatus =
  | {
      readonly status: "available";
      readonly executablePath: string;
      readonly source: RelayClientExecutableSource;
      readonly version: string;
    }
  | {
      readonly status: "missing";
      readonly version: string;
    }
  | {
      readonly status: "unsupported";
      readonly platform: NodeJS.Platform;
      readonly arch: string;
      readonly version: string;
    };

export type AvailableRelayClient = Extract<RelayClientStatus, { readonly status: "available" }>;

export class RelayClientInstallError extends Data.TaggedError("RelayClientInstallError")<{
  readonly reason:
    | "download_failed"
    | "invalid_checksum"
    | "install_locked"
    | "override_missing"
    | "unsupported_platform"
    | "validation_failed"
    | "write_failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

class CloudflaredCommandError extends Data.TaggedError("CloudflaredCommandError")<{
  readonly command: string;
  readonly exitCode: number;
}> {}

export interface CloudflaredReleaseAsset {
  readonly url: string;
  readonly sha256: string;
  readonly archive: "binary" | "tgz";
}

const CLOUDFLARED_RELEASE_ASSETS: Readonly<
  Partial<Record<`${NodeJS.Platform}-${string}`, CloudflaredReleaseAsset>>
> = {
  "darwin-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-darwin-arm64.tgz",
    sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f",
    archive: "tgz",
  },
  "darwin-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-darwin-amd64.tgz",
    sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d",
    archive: "tgz",
  },
  "linux-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-arm64",
    sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6",
    archive: "binary",
  },
  "linux-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64",
    sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
    archive: "binary",
  },
  "win32-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
    archive: "binary",
  },
  // Cloudflare publishes no Windows ARM64 build; Windows 11 on ARM runs x64 under emulation.
  "win32-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
    archive: "binary",
  },
};

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
// Legacy locks have no owner; allow both ten-minute download stages and the install tail.
const INSTALL_LOCK_LEGACY_STALE_MS = 30 * 60 * 1_000;
const VERSION_PROBE_TIMEOUT = "10 seconds";

const ACTIVATE_RETRY_COUNT = 40;
const ACTIVATE_RETRY_DELAY = "250 millis";

const trimmedString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(
      Option.flatMap((value) => {
        const trimmed = value.trim();
        return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
      }),
    ),
  );

const CloudflaredConfig = Config.all({
  executableOverride: trimmedString(CLOUDFLARED_PATH_ENV_NAME),
});

export interface CloudflaredRelayClientOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CloudflaredReleaseAsset;
}

export interface RelayClientShape {
  readonly resolve: Effect.Effect<RelayClientStatus>;
  readonly install: Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  readonly installWithProgress: (
    report: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  /** Removes managed releases older than the pin, except the newest one. Call once the pin has connected. */
  readonly pruneManagedVersions: Effect.Effect<void>;
}

export function isPinnedManagedRelayClient(client: AvailableRelayClient): boolean {
  return client.source === "managed" && client.version === CLOUDFLARED_VERSION;
}

export class RelayClient extends Context.Service<RelayClient, RelayClientShape>()(
  "@t3tools/shared/relayClient",
) {}

function executableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function resolveReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): CloudflaredReleaseAsset | null {
  return CLOUDFLARED_RELEASE_ASSETS[`${platform}-${arch}`] ?? null;
}

const VERSION_PATTERN = /\b(\d{4})\.(\d{1,2})\.(\d+)\b/u;

function parseVersion(value: string): readonly [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareCloudflaredVersions(left: string, right: string): number {
  const a = parseVersion(left) ?? [0, 0, 0];
  const b = parseVersion(right) ?? [0, 0, 0];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function parseCloudflaredVersionOutput(output: string): string | null {
  const version = parseVersion(output);
  return version ? version.join(".") : null;
}

class VersionProbeKey extends Data.Class<{
  readonly executablePath: string;
  readonly size: number;
  readonly mtimeMillis: number;
}> {}

function isLockContention(error: PlatformError.PlatformError): boolean {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return (
    error.reason._tag === "AlreadyExists" ||
    error.reason._tag === "BadResource" ||
    code === "ENOTEMPTY" ||
    isWindowsRenameLock(error)
  );
}

function parseLockOwnerPid(owner: string): number | null {
  const separator = owner.indexOf("-");
  if (separator <= 0) return null;
  const pid = Number(owner.slice(0, separator));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { readonly code?: unknown }).code !== "ESRCH";
  }
}

const wrapInstallFailure =
  (
    reason: RelayClientInstallError["reason"],
    message: string,
  ): (<E, R>(
    effect: Effect.Effect<void, E, R>,
  ) => Effect.Effect<void, RelayClientInstallError, R>) =>
  (effect) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason,
            message,
            cause,
          }),
      ),
    );

export const makeCloudflaredRelayClient = Effect.fn("cloudflared.make")(function* (
  options: CloudflaredRelayClientOptions,
): Effect.fn.Return<
  RelayClientShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const installSemaphore = yield* Semaphore.make(1);
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const releaseAsset = options.releaseAsset ?? resolveReleaseAsset(platform, arch);
  const loadCloudflaredConfig = Effect.suspend(() => CloudflaredConfig).pipe(Effect.orDie);
  const managedRoot = path.join(options.baseDir, "tools", "cloudflared");
  const managedPathFor = (version: string) =>
    path.join(managedRoot, version, `${platform}-${arch}`, executableFileName(platform));
  const managedPath = managedPathFor(CLOUDFLARED_VERSION);

  const isExecutableFile = Effect.fn("cloudflared.isExecutableFile")(function* (
    executablePath: string,
  ) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return false;
    return platform === "win32" || (info.value.mode & 0o111) !== 0;
  });

  // Cache successful version probes per file revision; do not let transient failures hide valid binaries.
  const versionCache = yield* Cache.makeWith(
    (key: VersionProbeKey) =>
      spawner
        .string(
          ChildProcess.make(key.executablePath, ["version"], { stdin: "ignore", stderr: "ignore" }),
        )
        .pipe(
          Effect.map(parseCloudflaredVersionOutput),
          Effect.timeoutOption(VERSION_PROBE_TIMEOUT),
          Effect.map(Option.getOrNull),
          Effect.orElseSucceed(() => null),
        ),
    {
      capacity: 16,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value !== null ? Duration.infinity : Duration.zero,
    },
  );
  const probeVersion = Effect.fn("cloudflared.probeVersion")(function* (executablePath: string) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return null;
    if (platform !== "win32" && (info.value.mode & 0o111) === 0) return null;
    return yield* Cache.get(
      versionCache,
      new VersionProbeKey({
        executablePath,
        size: Number(info.value.size),
        mtimeMillis: Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0,
      }),
    );
  });

  const compatibleCandidate = Effect.fn("cloudflared.compatibleCandidate")(function* (
    executablePath: string,
    source: RelayClientExecutableSource,
    expectedVersion?: string,
  ) {
    const version = yield* probeVersion(executablePath);
    if (version === null || compareCloudflaredVersions(version, CLOUDFLARED_MIN_VERSION) < 0) {
      return null;
    }
    if (expectedVersion !== undefined && version !== expectedVersion) {
      yield* Effect.logWarning("Ignoring a managed relay client that reports another version", {
        executablePath,
        expectedVersion,
        version,
      });
      return null;
    }
    return { status: "available", executablePath, source, version } satisfies AvailableRelayClient;
  });

  // Newer managed folders may belong to another server; never use or prune them.
  const olderManagedVersions = Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectory(managedRoot)
      .pipe(Effect.orElseSucceed(() => []));
    return entries
      .filter(
        (entry) =>
          parseVersion(entry) !== null &&
          compareCloudflaredVersions(entry, CLOUDFLARED_VERSION) < 0,
      )
      .sort((left, right) => compareCloudflaredVersions(right, left));
  });

  const resolvePathExecutable = Effect.gen(function* () {
    // Read hydrated PATH directly; ConfigProvider may have cached it before fixPath.
    const pathValue = (yield* HostProcess.Environment).PATH?.trim();
    if (!pathValue) return null;
    const delimiter = platform === "win32" ? ";" : ":";
    for (const directory of pathValue.split(delimiter)) {
      const trimmed = directory.trim().replace(/^"|"$/gu, "");
      if (trimmed.length === 0) continue;
      const candidate = path.join(trimmed, executableFileName(platform));
      if (!(yield* isExecutableFile(candidate))) continue;
      const available = yield* compatibleCandidate(candidate, "path");
      if (available) return available;
      yield* Effect.logWarning("Skipping an incompatible relay client on PATH", {
        executablePath: candidate,
        minimumVersion: CLOUDFLARED_MIN_VERSION,
      });
    }
    return null;
  });

  const missingStatus: RelayClientStatus = { status: "missing", version: CLOUDFLARED_VERSION };
  const unsupportedStatus: RelayClientStatus = {
    status: "unsupported",
    platform,
    arch,
    version: CLOUDFLARED_VERSION,
  };
  const resolve: RelayClientShape["resolve"] = Effect.gen(function* () {
    const config = yield* loadCloudflaredConfig;
    if (Option.isSome(config.executableOverride)) {
      const override = yield* compatibleCandidate(config.executableOverride.value, "override");
      if (override) return override;
      yield* Effect.logWarning(
        `${CLOUDFLARED_PATH_ENV_NAME} must point to cloudflared ${CLOUDFLARED_MIN_VERSION} or newer`,
        { executablePath: config.executableOverride.value },
      );
      return missingStatus;
    }
    const pinned = yield* compatibleCandidate(managedPath, "managed");
    if (pinned) return pinned;
    for (const version of yield* olderManagedVersions) {
      const older = yield* compatibleCandidate(managedPathFor(version), "managed");
      if (older) return older;
    }
    const pathExecutable = yield* resolvePathExecutable;
    if (pathExecutable) return pathExecutable;
    return releaseAsset ? missingStatus : unsupportedStatus;
  }).pipe(Effect.withSpan("cloudflared.resolve"));

  const pruneManagedVersions: RelayClientShape["pruneManagedVersions"] = Effect.gen(function* () {
    // Retain the newest older release for rollback or older servers that cannot redownload it.
    for (const version of (yield* olderManagedVersions).slice(1)) {
      // Windows cannot delete another server's running connector; retry next prune.
      yield* fileSystem.remove(path.join(managedRoot, version), { recursive: true }).pipe(
        Effect.tap(() => Effect.logInfo("Removed an older managed relay client", { version })),
        Effect.catch((cause) =>
          Effect.logDebug("Could not remove an older managed relay client", { version, cause }),
        ),
      );
    }
  }).pipe(Effect.withSpan("cloudflared.pruneManagedVersions"));

  const renameWhenUnlocked = (from: string, to: string) =>
    fileSystem.rename(from, to).pipe(
      Effect.retry({
        times: ACTIVATE_RETRY_COUNT,
        schedule: Schedule.spaced(ACTIVATE_RETRY_DELAY),
        while: (error) => platform === "win32" && isWindowsRenameLock(error),
      }),
    );

  const runCommand = Effect.fn("cloudflared.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        shell: false,
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new CloudflaredCommandError({ command, exitCode });
    }
  });

  const downloadAsset = Effect.fn("cloudflared.downloadAsset")(function* (
    asset: CloudflaredReleaseAsset,
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("downloading");
    const response = yield* httpClient.execute(HttpClientRequest.get(asset.url)).pipe(
      Effect.timeout(CLOUDFLARED_DOWNLOAD_TIMEOUT),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason: "download_failed",
            message: "Could not download the relay client.",
            cause,
          }),
      ),
    );
    const bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.timeout(CLOUDFLARED_DOWNLOAD_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new RelayClientInstallError({
              reason: "download_failed",
              message: "Could not read the downloaded relay client binary.",
              cause,
            }),
        ),
      ),
    );
    yield* report("verifying");
    const checksum = yield* crypto.digest("SHA-256", bytes).pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientInstallError({
            reason: "validation_failed",
            message: "Could not verify the downloaded relay client checksum.",
            cause,
          }),
      ),
    );
    if (Hex.encode(checksum) !== asset.sha256) {
      return yield* new RelayClientInstallError({
        reason: "invalid_checksum",
        message: "Downloaded relay client checksum did not match the pinned release.",
      });
    }
    return bytes;
  });

  const removeEmptyLock = (lockPath: string) =>
    Effect.tryPromise(() => NodeFSP.rmdir(lockPath)).pipe(Effect.ignore);

  const releaseOwnedLock = Effect.fn("cloudflared.releaseOwnedLock")(function* (
    lockPath: string,
    owner: string,
  ) {
    yield* fileSystem.remove(path.join(lockPath, owner), { force: true }).pipe(Effect.ignore);
    // A replacement contains a different owner entry, so rmdir cannot remove it.
    yield* removeEmptyLock(lockPath);
  });

  const acquireInstallLock = Effect.fn("cloudflared.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    const owner = `${process.pid}-${yield* crypto.randomUUIDv4()}`;
    const candidate = yield* Effect.acquireRelease(
      fileSystem.makeTempDirectory({ directory: path.dirname(lockPath), prefix: ".lock-" }),
      (directory) =>
        fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    yield* fileSystem.writeFileString(path.join(candidate, owner), "");
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* Effect.acquireRelease(
        // Publish a populated directory atomically, with no ownerless acquisition window.
        fileSystem.rename(candidate, lockPath),
        () => releaseOwnedLock(lockPath, owner),
      ).pipe(
        Effect.as(true),
        Effect.catchIf(isLockContention, () => Effect.succeed(false)),
      );
      if (acquired) return;

      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      if (Option.isNone(lockInfo)) continue;
      if (lockInfo.value.type === "Directory") {
        const owners = yield* fileSystem
          .readDirectory(lockPath)
          .pipe(Effect.orElseSucceed(() => []));
        let recovered = owners.length === 0;
        for (const entry of owners) {
          const pid = parseLockOwnerPid(entry);
          if (pid !== null && !processIsAlive(pid)) {
            yield* releaseOwnedLock(lockPath, entry);
            recovered = true;
          }
        }
        if (recovered) {
          yield* removeEmptyLock(lockPath);
          continue;
        }
      } else {
        const now = yield* Clock.currentTimeMillis;
        const mtime = lockInfo.value.mtime;
        if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_LEGACY_STALE_MS) {
          // Nonrecursive removal also refuses a populated directory that replaced this file.
          yield* fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore);
          continue;
        }
      }
      yield* Effect.sleep(INSTALL_LOCK_RETRY_DELAY);
    }
    return yield* new RelayClientInstallError({
      reason: "install_locked",
      message: "Another relay client installation is still in progress.",
    });
  });

  const installUnlocked = Effect.fn("cloudflared.installUnlocked")(function* (
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("checking");
    const config = yield* loadCloudflaredConfig;
    if (Option.isSome(config.executableOverride)) {
      const override = yield* compatibleCandidate(config.executableOverride.value, "override");
      if (override) return override;
      return yield* new RelayClientInstallError({
        reason: "override_missing",
        message: `${CLOUDFLARED_PATH_ENV_NAME} must point to cloudflared ${CLOUDFLARED_MIN_VERSION} or newer.`,
      });
    }
    const existing = yield* compatibleCandidate(managedPath, "managed", CLOUDFLARED_VERSION);
    if (existing) return existing;
    if (!releaseAsset) {
      return yield* new RelayClientInstallError({
        reason: "unsupported_platform",
        message: `T3 Code does not provide a managed relay client binary for ${platform}-${arch}.`,
      });
    }

    const managedDirectory = path.dirname(managedPath);
    const lockPath = `${managedPath}.lock`;
    yield* fileSystem
      .makeDirectory(managedDirectory, { recursive: true })
      .pipe(
        wrapInstallFailure("write_failed", "Could not create the relay client tool directory."),
      );
    yield* report("waiting_for_lock");
    yield* acquireInstallLock(lockPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            new RelayClientInstallError({
              reason: "write_failed",
              message: "Could not acquire the relay client installation lock.",
              cause,
            }),
          ),
      }),
    );
    return yield* Effect.gen(function* () {
      const afterLock = yield* compatibleCandidate(managedPath, "managed", CLOUDFLARED_VERSION);
      if (afterLock) return afterLock;

      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(
        tempDirectory,
        releaseAsset.archive === "tgz" ? "cloudflared.tgz" : executableFileName(platform),
      );
      const download = yield* downloadAsset(releaseAsset, report);
      yield* report("installing");
      yield* fileSystem
        .writeFile(archivePath, download)
        .pipe(wrapInstallFailure("write_failed", "Could not write the relay client download."));

      const executablePath = path.join(tempDirectory, executableFileName(platform));
      if (releaseAsset.archive === "tgz") {
        yield* runCommand("tar", ["-xzf", archivePath, "-C", tempDirectory]).pipe(
          wrapInstallFailure("write_failed", "Could not extract the relay client."),
        );
      }
      if (platform !== "win32") {
        yield* fileSystem
          .chmod(executablePath, 0o755)
          .pipe(wrapInstallFailure("write_failed", "Could not make the relay client executable."));
      }
      yield* report("validating");
      // Verify the pin so mislabeled assets cannot cause repeated redownloads.
      const installedVersion = yield* probeVersion(executablePath);
      if (installedVersion !== CLOUDFLARED_VERSION) {
        return yield* new RelayClientInstallError({
          reason: "validation_failed",
          message:
            installedVersion === null
              ? "The downloaded relay client binary did not run."
              : `The downloaded relay client reports version ${installedVersion}, not ${CLOUDFLARED_VERSION}.`,
        });
      }

      const stagedPath = `${managedPath}.${yield* crypto.randomUUIDv4()}.tmp`;
      yield* report("activating");
      yield* renameWhenUnlocked(executablePath, stagedPath).pipe(
        wrapInstallFailure("write_failed", "Could not stage the relay client."),
      );
      yield* renameWhenUnlocked(stagedPath, managedPath).pipe(
        wrapInstallFailure("write_failed", "Could not activate the relay client."),
        Effect.ensuring(fileSystem.remove(stagedPath, { force: true }).pipe(Effect.ignore)),
      );
      return {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
      } satisfies AvailableRelayClient;
    }).pipe(
      Effect.scoped,
      Effect.catchIf(
        (cause) => !(cause instanceof RelayClientInstallError),
        (cause) =>
          Effect.fail(
            new RelayClientInstallError({
              reason: "write_failed",
              message: "Could not install the relay client.",
              cause,
            }),
          ),
      ),
    );
  });
  const installWithProgress: RelayClientShape["installWithProgress"] = (report) =>
    installSemaphore.withPermit(
      installUnlocked((stage) =>
        report({
          type: "progress",
          stage,
        }),
      ).pipe(Effect.scoped),
    );
  const install = installWithProgress(() => Effect.void);

  return RelayClient.of({ resolve, install, installWithProgress, pruneManagedVersions });
});

export const layerCloudflared = (options: CloudflaredRelayClientOptions) =>
  Layer.effect(RelayClient, makeCloudflaredRelayClient(options));
