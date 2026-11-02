// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import { openZipArchive } from "../zipArchive.ts";

// Update the version, sizes and hashes from each chrome-headless-shell zip listed at
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
// Never pin below 156.0.8078.70: the shell has no CRLSet and older SPKI blocklists trust
// compromised eMudhra intermediates (crrev.com/c/8627687).
const VERSION = "156.0.8078.80";
const ARCHIVES = {
  linux64: {
    bytes: 126_922_702,
    sha256: "547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4",
  },
  "linux-arm64": {
    bytes: 126_679_292,
    sha256: "5bb6a00a4285c13303d3f72c5afdb70f144ea7a93eed462365a52b69631c9607",
  },
  "mac-arm64": {
    bytes: 103_982_159,
    sha256: "ea615baa2e9caf0d02d1898a6562b5f8fa9c35239707dae0f592178df5b986ac",
  },
  "mac-x64": {
    bytes: 109_493_298,
    sha256: "535d417d9034cbd11e7dacd1a71aa3d6e1b525e6d5dcd2671eb2532f01481228",
  },
  win32: {
    bytes: 119_036_038,
    sha256: "8d7472c5c60215a24c42e31d0e9567f1fbf41365e46c8d36c59b2a8b8b2b3a65",
  },
  win64: {
    bytes: 125_772_546,
    sha256: "10a77466005e7f64e00f1a75fd1ea81f4a38a60093c65fea6895843b26e60a9a",
  },
} as const;

const chromePlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  switch (platform) {
    case "linux":
      return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
    case "darwin":
      return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
    case "win32":
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === "ia32" ? "win32" : arch === "x64" || arch === "arm64" ? "win64" : null;
    default:
      return null;
  }
};

export interface PreviewBrowserRelease {
  readonly version: string;
  readonly platform: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

const previewBrowserRelease = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): PreviewBrowserRelease | null => {
  const chrome = chromePlatform(platform, arch);
  return chrome === null
    ? null
    : {
        version: VERSION,
        platform: chrome,
        url: `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip`,
        ...ARCHIVES[chrome],
      };
};

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

export class PreviewBrowserInstallError extends Schema.TaggedError<PreviewBrowserInstallError>()(
  "PreviewBrowserInstallError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `T3 could not install its headless browser: ${this.detail} Try again.`;
  }
}
const isInstallError = Schema.is(PreviewBrowserInstallError);

export class PreviewBrowserInstallingError extends Schema.TaggedError<PreviewBrowserInstallingError>()(
  "PreviewBrowserInstallingError",
  { downloadedBytes: Schema.Number, totalBytes: Schema.Number, unpacking: Schema.Boolean },
) {
  override get message(): string {
    const progress = this.unpacking
      ? "unpacking"
      : `${megabytes(this.downloadedBytes)} of ${megabytes(this.totalBytes)} MB downloaded`;
    return `T3 is installing its headless browser (${progress}). Try again in a minute.`;
  }
}

export class PreviewBrowserUnsupportedError extends Schema.TaggedError<PreviewBrowserUnsupportedError>()(
  "PreviewBrowserUnsupportedError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message(): string {
    return `T3's headless browser is not available on ${this.platform}-${this.arch}: Chrome for Testing has no headless shell for it.`;
  }
}

export class PreviewBrowser extends Context.Service<
  PreviewBrowser,
  {
    /** Starts installation on first call; returns progress after a bounded wait while installation continues. */
    readonly executable: Effect.Effect<
      string,
      PreviewBrowserInstallError | PreviewBrowserInstallingError | PreviewBrowserUnsupportedError
    >;
    readonly installed: Effect.Effect<Option.Option<string>>;
  }
>()("t3/preview/PreviewBrowser") {}

export interface PreviewBrowserOptions {
  readonly baseDir: string;
  readonly release?: PreviewBrowserRelease | null;
  /** How long a caller waits on an install in progress. Provider tool calls time out near 60s. */
  readonly wait?: Duration.Input;
}

const DOWNLOAD_TIMEOUT = "15 minutes";
const STAGING_STALE_AFTER_MS = 60 * 60_000;

const wrapFailure = (detail: string) => (cause: unknown) =>
  isInstallError(cause) ? cause : new PreviewBrowserInstallError({ detail, cause });

type InstallState =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "installing";
      readonly done: Deferred.Deferred<string, PreviewBrowserInstallError>;
    }
  | { readonly _tag: "installed"; readonly executable: string }
  | { readonly _tag: "failed"; readonly error: PreviewBrowserInstallError };

export const makePreviewBrowser = Effect.fn("PreviewBrowser.make")(function* (
  options: PreviewBrowserOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  // Installs belong to the service, so they finish even when no caller is still waiting.
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const release =
    options.release === undefined ? previewBrowserRelease(platform, arch) : options.release;
  const wait = options.wait ?? "45 seconds";
  const installRoot = path.join(
    options.baseDir,
    "tools",
    "chrome-headless-shell",
    release?.platform ?? `${platform}-${arch}`,
  );
  const executableName =
    platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const gate = yield* Semaphore.make(1);
  let state: InstallState = { _tag: "idle" };
  const progress = { downloadedBytes: 0, unpacking: false };

  const installedExecutable = (release: PreviewBrowserRelease) => {
    const executable = path.join(installRoot, release.version, executableName);
    return fs.stat(executable).pipe(
      Effect.map((info) =>
        info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0)
          ? Option.some(executable)
          : Option.none<string>(),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  };

  const download = Effect.fn("PreviewBrowser.download")(
    function* (release: PreviewBrowserRelease, archivePath: string) {
      const response = yield* http
        .execute(HttpClientRequest.get(release.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const contentLength = response.headers["content-length"];
      const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (
        (contentEncoding === undefined || contentEncoding === "identity") &&
        contentLength !== undefined &&
        Number(contentLength) !== release.bytes
      ) {
        return yield* new PreviewBrowserInstallError({
          detail: "The download size did not match the pinned release.",
        });
      }
      const hash = NodeCrypto.createHash("sha256");
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.suspend(() => {
            progress.downloadedBytes += chunk.byteLength;
            if (progress.downloadedBytes > release.bytes) {
              return Effect.fail(
                new PreviewBrowserInstallError({
                  detail: "The download was larger than the pinned release.",
                }),
              );
            }
            hash.update(chunk);
            return Effect.void;
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
      );
      if (progress.downloadedBytes !== release.bytes || hash.digest("hex") !== release.sha256) {
        return yield* new PreviewBrowserInstallError({
          detail: "The download failed its size or SHA-256 check. Nothing was installed.",
        });
      }
    },
    Effect.timeout(DOWNLOAD_TIMEOUT),
    Effect.mapError(
      wrapFailure(
        "The download from storage.googleapis.com failed. Check this machine's network access.",
      ),
    ),
  );

  const extract = Effect.fn("PreviewBrowser.extract")(
    function* (release: PreviewBrowserRelease, archivePath: string, destination: string) {
      const archive = yield* openZipArchive(
        archivePath,
        (detail, cause) => new PreviewBrowserInstallError({ detail, cause }),
      );
      const unsafe = new PreviewBrowserInstallError({
        detail: "The archive contains an unexpected or unsafe entry.",
      });
      const root = `chrome-headless-shell-${release.platform}/`;
      yield* fs.makeDirectory(destination);
      let foundExecutable = false;
      for (;;) {
        const entry = yield* archive.next;
        if (!entry) break;
        const unixMode = entry.externalFileAttributes >>> 16;
        const unixType = unixMode & 0o170000;
        const isDirectory = entry.fileName.endsWith("/");
        const relative = entry.fileName.startsWith(root) ? entry.fileName.slice(root.length) : null;
        const target = relative === null ? null : path.resolve(destination, relative);
        if (
          relative === null ||
          target === null ||
          (relative !== "" && !target.startsWith(`${destination}${path.sep}`)) ||
          relative.split("/").includes("..") ||
          (unixType !== 0 && unixType !== (isDirectory ? 0o040000 : 0o100000)) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          ![0, 8].includes(entry.compressionMethod)
        ) {
          return yield* unsafe;
        }
        if (isDirectory) {
          yield* fs.makeDirectory(target, { recursive: true });
          continue;
        }
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* Effect.gen(function* () {
          const readable = yield* archive.streamEntry(entry);
          yield* EffectNodeStream.fromReadable<Uint8Array, PreviewBrowserInstallError>({
            evaluate: () => readable,
            onError: wrapFailure("Could not unpack the browser."),
          }).pipe(Stream.run(fs.sink(target, { flag: "wx" })));
        }).pipe(Effect.scoped);
        // The binary and its shared libraries carry exec bits in the archive.
        if (platform !== "win32" && (unixMode & 0o777) !== 0) {
          yield* fs.chmod(target, unixMode & 0o777);
        }
        if (relative === executableName) foundExecutable = true;
      }
      if (!foundExecutable) {
        return yield* new PreviewBrowserInstallError({
          detail: "The archive does not contain chrome-headless-shell.",
        });
      }
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure("Could not unpack the browser. Check free disk space in T3's home directory."),
    ),
  );

  const install = Effect.fn("PreviewBrowser.install")(
    function* (release: PreviewBrowserRelease) {
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(installRoot, { recursive: true });
        // Staging shares the install root's filesystem so publishing is one rename.
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: installRoot,
          prefix: ".install-",
        });
        const archivePath = path.join(staging, "download.zip");
        const unpacked = path.join(staging, "browser");
        yield* download(release, archivePath);
        progress.unpacking = true;
        yield* extract(release, archivePath, unpacked);
        const destination = path.join(installRoot, release.version);
        yield* fs.remove(destination, { recursive: true, force: true });
        yield* fs.rename(unpacked, destination);
      }).pipe(Effect.scoped);
      // Shared homes may still use the newest other version or staging directories touched within the last hour.
      const entries = yield* fs.readDirectory(installRoot);
      const previous = entries
        .filter((name) => name !== release.version && !name.startsWith("."))
        .toSorted((left, right) => right.localeCompare(left, "en", { numeric: true }))[0];
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        entries.filter((name) => name !== release.version && name !== previous),
        (name) =>
          Effect.gen(function* () {
            const target = path.join(installRoot, name);
            if (name.startsWith(".install-")) {
              const info = yield* fs.stat(target);
              const modifiedAt = Option.match(info.mtime, {
                onNone: () => now,
                onSome: (date) => date.getTime(),
              });
              if (now - modifiedAt < STAGING_STALE_AFTER_MS) return;
            }
            yield* fs.remove(target, { recursive: true, force: true });
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove an old preview browser.", { name, cause }),
            ),
          ),
        { discard: true },
      );
      return path.join(installRoot, release.version, executableName);
    },
    Effect.mapError(wrapFailure("Could not save the browser in T3's home directory.")),
  );

  const join = (release: PreviewBrowserRelease) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (state._tag === "installing") return state;
        if (state._tag === "failed") {
          const failed = state;
          state = { _tag: "idle" };
          return failed;
        }
        const installed = yield* installedExecutable(release);
        if (Option.isSome(installed)) {
          state = { _tag: "installed", executable: installed.value };
          return state;
        }
        const done = yield* Deferred.make<string, PreviewBrowserInstallError>();
        progress.downloadedBytes = 0;
        progress.unpacking = false;
        const installing: InstallState = { _tag: "installing", done };
        state = installing;
        yield* install(release).pipe(
          Effect.onExit((exit) =>
            gate
              .withPermit(
                Effect.sync(() => {
                  state = Exit.isSuccess(exit)
                    ? { _tag: "installed", executable: exit.value }
                    : {
                        _tag: "failed",
                        error: Option.getOrElse(
                          Cause.findErrorOption(exit.cause),
                          () => new PreviewBrowserInstallError({ detail: "The install stopped." }),
                        ),
                      };
                }),
              )
              .pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.ignoreCause,
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
        return installing;
      }),
    );

  const clearFailure = (error: PreviewBrowserInstallError) =>
    gate.withPermit(
      Effect.sync(() => {
        if (state._tag === "failed" && state.error === error) state = { _tag: "idle" };
      }),
    );

  const executable = Effect.gen(function* () {
    if (release === null) {
      return yield* new PreviewBrowserUnsupportedError({ platform, arch });
    }
    const current = yield* join(release);
    switch (current._tag) {
      case "installed":
        return current.executable;
      case "failed":
        return yield* current.error;
      case "installing":
        return yield* Deferred.await(current.done).pipe(
          Effect.tapError(clearFailure),
          Effect.timeoutOrElse({
            duration: wait,
            orElse: () =>
              Effect.fail(
                new PreviewBrowserInstallingError({
                  downloadedBytes: progress.downloadedBytes,
                  totalBytes: release.bytes,
                  unpacking: progress.unpacking,
                }),
              ),
          }),
        );
    }
  }).pipe(Effect.withSpan("PreviewBrowser.executable"));

  const installed = release === null ? Effect.succeedNone : installedExecutable(release);

  return PreviewBrowser.of({ executable, installed });
});

export const layer = Layer.effect(
  PreviewBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makePreviewBrowser({ baseDir: config.baseDir });
  }),
);
