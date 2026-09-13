import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";

/**
 * A pinned runtime is an exact t3 release archive unpacked into
 * <baseDir>/runtime/versions/<version>: the self-contained executable, the
 * web client, and the native packages beside it. The boot service points its
 * unit or launch agent at the executable, and server self-update installs the
 * target version here before switching over. The runtime never depends on a
 * Node or npm on the machine; the only npm involvement in T3 Code is the `t3`
 * package for people who prefer `npx t3` or `npm install -g t3`, and even a
 * CLI installed that way pins an archive when it sets up the service.
 */
const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  /** The executable. Its existence is what marks a runtime as present. */
  readonly entryPath: string;
  readonly sentinelPath: string;
}

/** The exact command that runs a pinned runtime. */
export function pinnedRuntimeCommand(paths: PinnedRuntimePaths): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return { command: paths.entryPath, args: [] };
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PinnedRuntimePaths {
  const versionDir = path.join(baseDir, PINNED_RUNTIME_DIR, "versions", version);
  return {
    versionDir,
    entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * Installs the t3 release archive for `version` into the pinned runtime
 * directory unless a complete install is already there, and returns its
 * paths. The sentinel is written only after extraction and validation
 * succeed; checking the entry file alone is not enough, since tar writes the
 * executable before the last native package and a killed install leaves a
 * plausible-looking but broken tree behind.
 */
interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly releaseBaseUrl?: string | undefined;
}

const fetchReleaseAsset = Effect.fn("cloud.pinned_runtime.fetch_release_asset")(function* (
  httpClient: HttpClient.HttpClient,
  url: string,
  step: string,
) {
  // The install lock is held for the whole transaction, so a stalled download
  // must fail rather than block every other caller.
  return yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((cause) => new PinnedRuntimeInstallError({ step, cause })),
    Effect.timeoutOrElse({
      duration: PINNED_RUNTIME_INSTALL_TIMEOUT,
      orElse: () => Effect.fail(new PinnedRuntimeInstallError({ step: `${step} (timed out)` })),
    }),
  );
});

/**
 * Downloads the release archive for this platform, verifies it against the
 * release's checksum file, and unpacks it so the executable sits directly in
 * the staging directory. Only `tar` is required on the host; every supported
 * OS ships one that reads gzip and zip.
 */
const installFromArchive = Effect.fn("cloud.pinned_runtime.install_archive")(function* (
  input: PinnedRuntimeInstallInput,
  stagingDir: string,
) {
  const { fs, path } = input;
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  if (platformKey === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
    });
  }
  const httpClient = input.httpClient;
  const baseUrl = cliReleaseDownloadBaseUrl(input.version, input.releaseBaseUrl);
  const fileName = cliArchiveFileName(input.version, platformKey);

  const checksums = parseChecksums(
    new TextDecoder().decode(
      yield* fetchReleaseAsset(
        httpClient,
        `${baseUrl}/${CLI_RELEASE_CHECKSUMS_FILE}`,
        "downloading the t3 release checksums",
      ),
    ),
  );
  const expected = checksums.get(fileName);
  if (expected === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `finding ${fileName} in the t3 release checksums`,
    });
  }
  const archive = yield* fetchReleaseAsset(
    httpClient,
    `${baseUrl}/${fileName}`,
    "downloading the t3 release archive",
  );
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", archive),
    catch: (cause) =>
      new PinnedRuntimeInstallError({ step: "verifying the t3 release archive", cause }),
  });
  if (Encoding.encodeHex(new Uint8Array(digest)) !== expected) {
    return yield* new PinnedRuntimeInstallError({
      step: "verifying the t3 release archive checksum",
    });
  }

  const archivePath = path.join(stagingDir, PINNED_RUNTIME_ARCHIVE_FILE);
  yield* fs
    .writeFile(archivePath, archive)
    .pipe(
      Effect.mapError(
        (cause) => new PinnedRuntimeInstallError({ step: "writing the t3 release archive", cause }),
      ),
    );
  const extractStep = "extracting the t3 release archive";
  // The archive wraps everything in one directory named after its stem;
  // strip it so the executable lands at <versionDir>/t3.
  yield* input.runner
    .run({
      command: cliArchiveTarCommand(input.platform, process.env),
      args: ["-xf", archivePath, "-C", stagingDir, "--strip-components=1"],
      timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
    })
    .pipe(
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: extractStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PinnedRuntimeInstallError({
            step: extractStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
    );
  yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
});

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs } = input;
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version, input.platform);
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const alreadyPinned =
    entryExists && Option.isSome(sentinel) && sentinel.value.trim() === input.version;
  if (alreadyPinned) {
    yield* input.validate(paths);
    return paths;
  }
  if (versionDirExists) {
    yield* fs.remove(paths.versionDir, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "removing an incomplete pinned runtime",
            cause,
          }),
      ),
    );
  }

  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, input.path.relative(paths.versionDir, paths.entryPath)),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    yield* installFromArchive(input, stagingDir);

    yield* input.validate(stagingPaths);
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, `${input.version}\n`)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    const published = yield* fs.rename(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            publishedSentinel.value.trim() === input.version
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!published) yield* input.validate(paths);
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));
