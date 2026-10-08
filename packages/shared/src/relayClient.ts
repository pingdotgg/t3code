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
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

export const CLOUDFLARED_VERSION = "2026.10.0";
// The oldest release that accepts every flag the connector is started with
// (`--output` arrived in 2025.6.1). Override, PATH, and older managed binaries
// below it are skipped, since they exit immediately on the unknown flag.
export const CLOUDFLARED_MIN_VERSION = "2025.6.1";
const CLOUDFLARED_PATH_ENV_NAME = "T3CODE_CLOUDFLARED_PATH";

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
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-arm64.tgz",
    sha256: "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70",
    archive: "tgz",
  },
  "darwin-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-amd64.tgz",
    sha256: "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f",
    archive: "tgz",
  },
  "linux-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-arm64",
    sha256: "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
    archive: "binary",
  },
  "linux-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64",
    sha256: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
    archive: "binary",
  },
  "win32-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe",
    sha256: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
    archive: "binary",
  },
  // Cloudflare publishes no Windows ARM64 build; Windows 11 on ARM runs x64 under emulation.
  "win32-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe",
    sha256: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
    archive: "binary",
  },
};

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;
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
  path: trimmedString("PATH"),
});

export interface CloudflaredRelayClientOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CloudflaredReleaseAsset;
}

export interface RelayClientShape {
  /**
   * Finds the relay client to run, without downloading anything: the override,
   * else the pinned managed folder, else the newest older managed folder, else
   * `cloudflared` on PATH. Every candidate must report a compatible version, and
   * the status carries the version the binary reports.
   */
  readonly resolve: Effect.Effect<RelayClientStatus>;
  /** Installs the pinned managed release unless it, or a valid override, is already present. */
  readonly install: Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  readonly installWithProgress: (
    report: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) => Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  /** Removes managed releases older than the pin, except the newest one. Call once the pin has connected. */
  readonly pruneManagedVersions: Effect.Effect<void>;
}

/** True when this is the pinned managed release, which needs no update. */
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

/** Orders `YYYY.M.P` cloudflared versions; unparseable versions sort first. */
export function compareCloudflaredVersions(left: string, right: string): number {
  const a = parseVersion(left) ?? [0, 0, 0];
  const b = parseVersion(right) ?? [0, 0, 0];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Reads the version from `cloudflared version` output, e.g. `cloudflared version 2026.5.2 (built ...)`. */
export function parseCloudflaredVersionOutput(output: string): string | null {
  const version = parseVersion(output);
  return version ? version.join(".") : null;
}

// A changed file is a new key, so a replaced binary is probed again.
class VersionProbeKey extends Data.Class<{
  readonly executablePath: string;
  readonly size: number;
  readonly mtimeMillis: number;
}> {}

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

// Windows refuses to rename a file another process briefly holds open, such as a virus
// scanner reading the binary that just ran. These codes clear once it lets go.
function isTransientWindowsLock(error: PlatformError.PlatformError): boolean {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
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
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
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

  // `cloudflared version` costs a process spawn, so answers are cached per file
  // revision. Before `--no-autoupdate`, a managed binary could replace itself in
  // place, so the version is read from the binary, never from its folder name.
  // A failed or timed-out probe is not cached, so a slow spawn under an AV scan
  // does not hide a good binary until it changes on disk.
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

  // Managed releases older than the pin, newest first. Newer folders belong to
  // a newer server sharing this base dir and are never used or pruned here.
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
    const config = yield* loadCloudflaredConfig;
    const pathValue = Option.getOrUndefined(config.path);
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
    // A managed binary reports the version it actually runs. One that replaced
    // itself in place still serves as a fallback; the runtime sees it is not the
    // pinned release and installs that.
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
    // The newest older release stays: an older server sharing this base dir, or a
    // rollback after a failed update, may still need it and cannot redownload it.
    for (const version of (yield* olderManagedVersions).slice(1)) {
      // A connector from another server sharing this base dir may still run an
      // older release; Windows refuses to delete it, so the next prune retries.
      yield* fileSystem.remove(path.join(managedRoot, version), { recursive: true }).pipe(
        Effect.tap(() => Effect.logInfo("Removed an older managed relay client", { version })),
        Effect.catch((cause) =>
          Effect.logDebug("Could not remove an older managed relay client", { version, cause }),
        ),
      );
    }
  }).pipe(Effect.withSpan("cloudflared.pruneManagedVersions"));

  /** Moves the new binary toward its final path, waiting out a brief Windows lock. */
  const renameWhenUnlocked = (from: string, to: string) =>
    fileSystem.rename(from, to).pipe(
      Effect.retry({
        times: ACTIVATE_RETRY_COUNT,
        schedule: Schedule.spaced(ACTIVATE_RETRY_DELAY),
        while: (error) => platform === "win32" && isTransientWindowsLock(error),
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

  const acquireInstallLock = Effect.fn("cloudflared.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* Effect.acquireRelease(
        fileSystem.writeFileString(lockPath, "", { flag: "wx" }),
        () => fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore),
      ).pipe(
        Effect.as(true),
        Effect.catchIf(isAlreadyExists, () => Effect.succeed(false)),
      );
      if (acquired) return;

      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_STALE_MS) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
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
      // Requiring the pinned version here keeps a mislabelled asset from being
      // activated, ignored by resolve, and downloaded again on every reconcile.
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

      const stagedPath = `${managedPath}.${yield* crypto.randomUUIDv4}.tmp`;
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
