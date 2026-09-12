import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  isArchiveDistributedVersion,
  parseChecksums,
} from "@t3tools/shared/cliRelease";

import * as ProcessRunner from "../processRunner.ts";

/**
 * A pinned runtime is an exact `t3@<version>` installed into
 * <baseDir>/runtime/versions/<version>. The boot service points its unit or
 * launch agent here, and server self-update installs the target version here before
 * switching over, never `npx t3`, whose cache is ephemeral and whose
 * registry fetch at boot would make startup depend on the network.
 *
 * Two layouts exist. npm-distributed versions are `npm install`ed and run as
 * `<node> node_modules/t3/dist/bin.mjs`. Archive-distributed versions are the
 * self-contained release archive unpacked in place and run as `./t3`, which
 * needs neither Node nor npm on the machine. The layout is decided by the
 * version string alone so every consumer agrees without probing the disk.
 */

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export type PinnedRuntimeLayout = "npm" | "archive";

export interface PinnedRuntimePaths {
  readonly layout: PinnedRuntimeLayout;
  readonly versionDir: string;
  /**
   * `bin.mjs` for npm layouts, the executable itself for archives. Existence
   * of this file is what marks a runtime as present.
   */
  readonly entryPath: string;
  readonly sentinelPath: string;
}

/** The exact command that runs a pinned runtime, given the Node hosting the caller. */
export function pinnedRuntimeCommand(
  paths: PinnedRuntimePaths,
  nodePath: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  return paths.layout === "archive"
    ? { command: paths.entryPath, args: [] }
    : { command: nodePath, args: [paths.entryPath] };
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PinnedRuntimePaths {
  const versionDir = path.join(baseDir, PINNED_RUNTIME_DIR, "versions", version);
  const sentinelPath = path.join(versionDir, ".install-complete");
  if (isArchiveDistributedVersion(version)) {
    return {
      layout: "archive",
      versionDir,
      entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
      sentinelPath,
    };
  }
  return {
    layout: "npm",
    versionDir,
    entryPath: path.join(versionDir, "node_modules", "t3", "dist", "bin.mjs"),
    sentinelPath,
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
 * Installs `t3@<version>` into the pinned runtime directory unless a complete
 * install is already there, and returns its paths. The sentinel is written
 * only after the install step exits 0; checking the entry file alone is not
 * enough. npm extracts files before running native builds (node-pty), and tar
 * writes the executable before the last native package, so a killed install
 * leaves a plausible-looking but broken tree behind.
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
  /** Archive-distributed versions download from here; npm versions never need it. */
  readonly httpClient?: HttpClient.HttpClient | undefined;
  readonly releaseBaseUrl?: string | undefined;
}

const installFromNpm = Effect.fn("cloud.pinned_runtime.install_npm")(function* (
  input: PinnedRuntimeInstallInput,
  stagingDir: string,
) {
  const installStep = "installing the pinned t3 runtime (this can take a few minutes)";
  const installArgs = [
    "install",
    "--prefix",
    stagingDir,
    "--no-fund",
    "--no-audit",
    `t3@${input.version}`,
  ];
  yield* input.runner
    .run({
      command: "npm",
      args: installArgs,
      // Native dependencies may compile from source on slower machines.
      timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
    })
    .pipe(
      Effect.catchTags({
        ProcessSpawnError: (error) =>
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? // pnpm-managed Node installations do not include npm. Keep npm
              // installation semantics for the pinned runtime and native builds.
              input.runner.run({
                command: "pnpm",
                args: ["--package=npm@11", "dlx", "npm", ...installArgs],
                timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
              })
            : Effect.fail(error),
      }),
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: installStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PinnedRuntimeInstallError({
            step: installStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
    );
});

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
  if (httpClient === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: "downloading the t3 release archive (no HTTP client available)",
    });
  }
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
      command: "tar",
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
    layout: paths.layout,
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, input.path.relative(paths.versionDir, paths.entryPath)),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };

  return yield* Effect.gen(function* () {
    if (paths.layout === "archive") {
      yield* installFromArchive(input, stagingDir);
    } else {
      yield* installFromNpm(input, stagingDir);
    }

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
