import * as Clock from "effect/Clock";
import type {
  RelayClientInstallProgressEvent,
  RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";
import { getUrlDiagnostics } from "./urlDiagnostics.ts";

export const CLOUDFLARED_VERSION = "2026.5.2";
export const CLOUDFLARED_PATH_ENV_NAME = "T3CODE_CLOUDFLARED_PATH";

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

const RelayClientUrlDiagnosticFields = {
  urlInputLength: Schema.Number,
  urlProtocol: Schema.optional(Schema.String),
  urlHostname: Schema.optional(Schema.String),
};

function relayClientUrlDiagnostics(input: string) {
  const diagnostics = getUrlDiagnostics(input);
  return {
    urlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { urlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { urlHostname: diagnostics.hostname }),
  };
}

export class RelayClientDownloadError extends Schema.TaggedErrorClass<RelayClientDownloadError>()(
  "RelayClientDownloadError",
  {
    ...RelayClientUrlDiagnosticFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not download the relay client.";
  }
}

export class RelayClientDownloadReadError extends Schema.TaggedErrorClass<RelayClientDownloadReadError>()(
  "RelayClientDownloadReadError",
  {
    ...RelayClientUrlDiagnosticFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not read the downloaded relay client binary.";
  }
}

export class RelayClientChecksumMismatchError extends Schema.TaggedErrorClass<RelayClientChecksumMismatchError>()(
  "RelayClientChecksumMismatchError",
  {
    expectedChecksum: Schema.String,
    actualChecksum: Schema.String,
  },
) {
  override get message(): string {
    return "Downloaded relay client checksum did not match the pinned release.";
  }
}

export class RelayClientInstallLockedError extends Schema.TaggedErrorClass<RelayClientInstallLockedError>()(
  "RelayClientInstallLockedError",
  {
    lockPath: Schema.String,
  },
) {
  override get message(): string {
    return "Another relay client installation is still in progress.";
  }
}

export class RelayClientOverrideMissingError extends Schema.TaggedErrorClass<RelayClientOverrideMissingError>()(
  "RelayClientOverrideMissingError",
  {
    executablePath: Schema.String,
  },
) {
  override get message(): string {
    return `${CLOUDFLARED_PATH_ENV_NAME} does not point to an executable file.`;
  }
}

export class RelayClientUnsupportedPlatformError extends Schema.TaggedErrorClass<RelayClientUnsupportedPlatformError>()(
  "RelayClientUnsupportedPlatformError",
  {
    platform: Schema.String,
    arch: Schema.String,
  },
) {
  override get message(): string {
    return `T3 Code does not provide a managed relay client binary for ${this.platform}-${this.arch}.`;
  }
}

export class RelayClientChecksumVerificationError extends Schema.TaggedErrorClass<RelayClientChecksumVerificationError>()(
  "RelayClientChecksumVerificationError",
  {
    ...RelayClientUrlDiagnosticFields,
    expectedChecksum: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not verify the downloaded relay client checksum.";
  }
}

export class RelayClientExecutableValidationError extends Schema.TaggedErrorClass<RelayClientExecutableValidationError>()(
  "RelayClientExecutableValidationError",
  {
    executablePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The downloaded relay client binary did not run.";
  }
}

export class RelayClientDirectoryCreateError extends Schema.TaggedErrorClass<RelayClientDirectoryCreateError>()(
  "RelayClientDirectoryCreateError",
  {
    directoryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create the relay client tool directory.";
  }
}

export class RelayClientInstallLockAcquireError extends Schema.TaggedErrorClass<RelayClientInstallLockAcquireError>()(
  "RelayClientInstallLockAcquireError",
  {
    lockPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not acquire the relay client installation lock.";
  }
}

export class RelayClientDownloadWriteError extends Schema.TaggedErrorClass<RelayClientDownloadWriteError>()(
  "RelayClientDownloadWriteError",
  {
    archivePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not write the relay client download.";
  }
}

export class RelayClientArchiveExtractError extends Schema.TaggedErrorClass<RelayClientArchiveExtractError>()(
  "RelayClientArchiveExtractError",
  {
    archivePath: Schema.String,
    destinationDirectory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not extract the relay client.";
  }
}

export class RelayClientExecutablePermissionError extends Schema.TaggedErrorClass<RelayClientExecutablePermissionError>()(
  "RelayClientExecutablePermissionError",
  {
    executablePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not make the relay client executable.";
  }
}

export class RelayClientStageError extends Schema.TaggedErrorClass<RelayClientStageError>()(
  "RelayClientStageError",
  {
    sourcePath: Schema.String,
    destinationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not stage the relay client.";
  }
}

export class RelayClientActivationError extends Schema.TaggedErrorClass<RelayClientActivationError>()(
  "RelayClientActivationError",
  {
    sourcePath: Schema.String,
    destinationPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not activate the relay client.";
  }
}

export class RelayClientInstallWriteError extends Schema.TaggedErrorClass<RelayClientInstallWriteError>()(
  "RelayClientInstallWriteError",
  {
    managedPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not install the relay client.";
  }
}

export const RelayClientInstallError = Schema.Union([
  RelayClientDownloadError,
  RelayClientDownloadReadError,
  RelayClientChecksumMismatchError,
  RelayClientInstallLockedError,
  RelayClientOverrideMissingError,
  RelayClientUnsupportedPlatformError,
  RelayClientChecksumVerificationError,
  RelayClientExecutableValidationError,
  RelayClientDirectoryCreateError,
  RelayClientInstallLockAcquireError,
  RelayClientDownloadWriteError,
  RelayClientArchiveExtractError,
  RelayClientExecutablePermissionError,
  RelayClientStageError,
  RelayClientActivationError,
  RelayClientInstallWriteError,
]);
export type RelayClientInstallError = typeof RelayClientInstallError.Type;

class CloudflaredCommandError extends Schema.TaggedErrorClass<CloudflaredCommandError>()(
  "CloudflaredCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export const isRelayClientInstallError = Schema.is(RelayClientInstallError);

export interface CloudflaredReleaseAsset {
  readonly url: string;
  readonly sha256: string;
  readonly archive: "binary" | "tgz";
}

const CLOUDFLARED_RELEASE_ASSETS: Readonly<
  Partial<Record<`${NodeJS.Platform}-${string}`, CloudflaredReleaseAsset>>
> = {
  "darwin-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-darwin-arm64.tgz",
    sha256: "ba94054c9fd4297645093d59d51442e5e546d07bb0516120e694a13d5b216d38",
    archive: "tgz",
  },
  "darwin-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-darwin-amd64.tgz",
    sha256: "7240f709506bc2c1eb9da4d89cf2555499c60280ecb854b7d80e8f17d4b7903d",
    archive: "tgz",
  },
  "linux-arm64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-linux-arm64",
    sha256: "5a4e8ce2701105271412059f44b6a0bf1ae4542b4d98ff3180c0c019443a5815",
    archive: "binary",
  },
  "linux-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-linux-amd64",
    sha256: "5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886",
    archive: "binary",
  },
  "win32-x64": {
    url: "https://github.com/cloudflare/cloudflared/releases/download/2026.5.2/cloudflared-windows-amd64.exe",
    sha256: "20b9638f685333d623798e733effbad2487093f15ba592f6c7752360ff3b7ab7",
    archive: "binary",
  },
};

const INSTALL_LOCK_RETRY_COUNT = 100;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;

const trimmedString = (name: string) =>
  Config.string(name).pipe(
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

export class RelayClient extends Context.Service<
  RelayClient,
  {
    readonly resolve: Effect.Effect<RelayClientStatus>;
    readonly install: Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
    readonly installWithProgress: (
      report: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
    ) => Effect.Effect<AvailableRelayClient, RelayClientInstallError>;
  }
>()("@t3tools/shared/relayClient") {}

function executableFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function resolveReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): CloudflaredReleaseAsset | null {
  return CLOUDFLARED_RELEASE_ASSETS[`${platform}-${arch}`] ?? null;
}

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

export const makeCloudflaredRelayClient = Effect.fn("cloudflared.make")(function* (
  options: CloudflaredRelayClientOptions,
): Effect.fn.Return<
  RelayClient["Service"],
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
  const managedPath = path.join(
    options.baseDir,
    "tools",
    "cloudflared",
    CLOUDFLARED_VERSION,
    `${platform}-${arch}`,
    executableFileName(platform),
  );

  const isExecutableFile = Effect.fn("cloudflared.isExecutableFile")(function* (
    executablePath: string,
  ) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return false;
    return platform === "win32" || (info.value.mode & 0o111) !== 0;
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
      if (yield* isExecutableFile(candidate)) return candidate;
    }
    return null;
  });

  const resolve: RelayClient["Service"]["resolve"] = Effect.gen(function* () {
    const config = yield* loadCloudflaredConfig;
    if (Option.isSome(config.executableOverride)) {
      return (yield* isExecutableFile(config.executableOverride.value))
        ? {
            status: "available",
            executablePath: config.executableOverride.value,
            source: "override",
            version: CLOUDFLARED_VERSION,
          }
        : { status: "missing", version: CLOUDFLARED_VERSION };
    }
    if (yield* isExecutableFile(managedPath)) {
      return {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLOUDFLARED_VERSION,
      };
    }
    const pathExecutable = yield* resolvePathExecutable;
    if (pathExecutable) {
      return {
        status: "available",
        executablePath: pathExecutable,
        source: "path",
        version: CLOUDFLARED_VERSION,
      };
    }
    return releaseAsset
      ? { status: "missing", version: CLOUDFLARED_VERSION }
      : {
          status: "unsupported",
          platform,
          arch,
          version: CLOUDFLARED_VERSION,
        };
  });

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
          new RelayClientDownloadError({
            ...relayClientUrlDiagnostics(asset.url),
            cause,
          }),
      ),
    );
    const bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) =>
            new RelayClientDownloadReadError({
              ...relayClientUrlDiagnostics(asset.url),
              cause,
            }),
        ),
      ),
    );
    yield* report("verifying");
    const checksum = yield* crypto.digest("SHA-256", bytes).pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientChecksumVerificationError({
            ...relayClientUrlDiagnostics(asset.url),
            expectedChecksum: asset.sha256,
            cause,
          }),
      ),
    );
    const actualChecksum = Encoding.encodeHex(checksum);
    if (actualChecksum !== asset.sha256) {
      return yield* new RelayClientChecksumMismatchError({
        expectedChecksum: asset.sha256,
        actualChecksum,
      });
    }
    return bytes;
  });

  const acquireInstallLock = Effect.fn("cloudflared.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.fail(error),
        ),
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
    return yield* new RelayClientInstallLockedError({
      lockPath,
    });
  });

  const installUnlocked = Effect.fn("cloudflared.installUnlocked")(function* (
    report: (stage: RelayClientInstallProgressStage) => Effect.Effect<void>,
  ) {
    yield* report("checking");
    const existing = yield* resolve;
    if (existing.status === "available") return existing;
    const config = yield* loadCloudflaredConfig;
    if (Option.isSome(config.executableOverride)) {
      return yield* new RelayClientOverrideMissingError({
        executablePath: config.executableOverride.value,
      });
    }
    if (!releaseAsset) {
      return yield* new RelayClientUnsupportedPlatformError({
        platform,
        arch,
      });
    }

    const managedDirectory = path.dirname(managedPath);
    const lockPath = `${managedPath}.lock`;
    yield* fileSystem.makeDirectory(managedDirectory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new RelayClientDirectoryCreateError({
            directoryPath: managedDirectory,
            cause,
          }),
      ),
    );
    yield* report("waiting_for_lock");
    yield* acquireInstallLock(lockPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            new RelayClientInstallLockAcquireError({
              lockPath,
              cause,
            }),
          ),
      }),
    );
    return yield* Effect.gen(function* () {
      const afterLock = yield* resolve;
      if (afterLock.status === "available") return afterLock;

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
      yield* fileSystem.writeFile(archivePath, download).pipe(
        Effect.mapError(
          (cause) =>
            new RelayClientDownloadWriteError({
              archivePath,
              cause,
            }),
        ),
      );

      const executablePath = path.join(tempDirectory, executableFileName(platform));
      if (releaseAsset.archive === "tgz") {
        yield* runCommand("tar", ["-xzf", archivePath, "-C", tempDirectory]).pipe(
          Effect.mapError(
            (cause) =>
              new RelayClientArchiveExtractError({
                archivePath,
                destinationDirectory: tempDirectory,
                cause,
              }),
          ),
        );
      }
      if (platform !== "win32") {
        yield* fileSystem.chmod(executablePath, 0o755).pipe(
          Effect.mapError(
            (cause) =>
              new RelayClientExecutablePermissionError({
                executablePath,
                cause,
              }),
          ),
        );
      }
      yield* report("validating");
      yield* runCommand(executablePath, ["--version"]).pipe(
        Effect.mapError(
          (cause) =>
            new RelayClientExecutableValidationError({
              executablePath,
              cause,
            }),
        ),
      );

      const stagedPath = `${managedPath}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* report("activating");
      yield* fileSystem.rename(executablePath, stagedPath).pipe(
        Effect.mapError(
          (cause) =>
            new RelayClientStageError({
              sourcePath: executablePath,
              destinationPath: stagedPath,
              cause,
            }),
        ),
      );
      yield* fileSystem.rename(stagedPath, managedPath).pipe(
        Effect.mapError(
          (cause) =>
            new RelayClientActivationError({
              sourcePath: stagedPath,
              destinationPath: managedPath,
              cause,
            }),
        ),
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
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.catch(
        (cause): Effect.Effect<never, RelayClientInstallError> =>
          isRelayClientInstallError(cause)
            ? Effect.fail(cause)
            : Effect.fail(
                new RelayClientInstallWriteError({
                  managedPath,
                  cause,
                }),
              ),
      ),
    );
  });
  const installWithProgress: RelayClient["Service"]["installWithProgress"] = (report) =>
    installSemaphore.withPermit(
      installUnlocked((stage) =>
        report({
          type: "progress",
          stage,
        }),
      ),
    );
  const install = installWithProgress(() => Effect.void);

  return RelayClient.of({ resolve, install, installWithProgress });
});

export const layerCloudflared = (options: CloudflaredRelayClientOptions) =>
  Layer.effect(RelayClient, makeCloudflaredRelayClient(options));
