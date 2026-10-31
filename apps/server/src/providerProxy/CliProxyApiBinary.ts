/** The pinned CLIProxyAPI release T3 downloads into T3 home, following the cloudflared pattern. */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsRenameLock } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";

const CLIPROXYAPI_VERSION = "8.0.47";
const CLIPROXYAPI_PATH_ENV_NAME = "T3CODE_CLIPROXYAPI_PATH";
const DOWNLOAD_TIMEOUT = "10 minutes";
const VERSION_PROBE_TIMEOUT = "10 seconds";
const ACTIVATE_RETRY_COUNT = 40;
const ACTIVATE_RETRY_DELAY = "250 millis";

interface ReleaseAsset {
  readonly url: string;
  readonly sha256: string;
  readonly archive: "tgz" | "zip";
}

const releaseAsset = (name: string, sha256: string): ReleaseAsset => ({
  url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXYAPI_VERSION}/CLIProxyAPI_${CLIPROXYAPI_VERSION}_${name}`,
  sha256,
  archive: name.endsWith(".zip") ? "zip" : "tgz",
});

// From the release's checksums.txt, which matches GitHub's asset digests.
const RELEASE_ASSETS: Readonly<Partial<Record<`${NodeJS.Platform}-${string}`, ReleaseAsset>>> = {
  "darwin-arm64": releaseAsset(
    "darwin_aarch64.tar.gz",
    "a5b260ec0f843d2291488acd76e5595232da8f3b8ec2d334154f1570f5f3ca08",
  ),
  "darwin-x64": releaseAsset(
    "darwin_amd64.tar.gz",
    "2e72cb7b28905b9135563e4fc01af00009ce72a444729eb95bdb634543ce7d41",
  ),
  "linux-arm64": releaseAsset(
    "linux_aarch64.tar.gz",
    "da1326ed4434fb6c9609927f317c093f9a4bb482a61e5451e9bea99a0dc7c4bf",
  ),
  "linux-x64": releaseAsset(
    "linux_amd64.tar.gz",
    "2b5111dc6a0dfe0d607457787f794330d1b477bc9daa6337c26b0cd032a7827e",
  ),
  "win32-arm64": releaseAsset(
    "windows_aarch64.zip",
    "9a947eec7234e5a2e2ce57a9fe55c82328fc823ffd2f41cca85f9da41d11eae0",
  ),
  "win32-x64": releaseAsset(
    "windows_amd64.zip",
    "8e23cbb2f9f695411b7df46320855820b352fb886c3c3bdf45ab4634f2f14632",
  ),
};

export type CliProxyApiBinaryStatus =
  | {
      readonly status: "available";
      readonly executablePath: string;
      readonly source: "override" | "managed";
      readonly version: string;
    }
  | { readonly status: "missing" }
  | { readonly status: "unsupported"; readonly platform: string; readonly arch: string };
export type AvailableCliProxyApiBinary = Extract<
  CliProxyApiBinaryStatus,
  { readonly status: "available" }
>;

export class CliProxyApiInstallError extends Schema.TaggedError<CliProxyApiInstallError>()(
  "CliProxyApiInstallError",
  {
    reason: Schema.Literals([
      "download_failed",
      "invalid_checksum",
      "override_invalid",
      "unsupported_platform",
      "validation_failed",
      "write_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "download_failed":
        return "Could not download CLIProxyAPI.";
      case "invalid_checksum":
        return "The CLIProxyAPI download did not match the pinned checksum.";
      case "override_invalid":
        return `${CLIPROXYAPI_PATH_ENV_NAME} does not point to a working CLIProxyAPI.`;
      case "unsupported_platform":
        return "CLIProxyAPI has no build for this platform.";
      case "validation_failed":
        return `The downloaded CLIProxyAPI did not report version ${CLIPROXYAPI_VERSION}.`;
      case "write_failed":
        return "Could not install CLIProxyAPI into T3 home.";
    }
  }
}

/** `-help` prints `CLIProxyAPI Version: 8.0.47, Commit: ...` before the usage text. */
export function parseCliProxyApiVersionOutput(output: string): string | null {
  return /\bCLIProxyAPI Version: v?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1] ?? null;
}

/** T3 writes v8's config layout; v7 and older read top-level host, port, and auth fields. */
export const isCompatibleCliProxyApiVersion = (version: string): boolean =>
  version.split(".")[0] === CLIPROXYAPI_VERSION.split(".")[0];

export class CliProxyApiBinary extends Context.Service<
  CliProxyApiBinary,
  {
    readonly resolve: Effect.Effect<CliProxyApiBinaryStatus>;
    /** Downloads the pinned release. Callers own consent: only a user choosing a managed proxy. */
    readonly install: Effect.Effect<AvailableCliProxyApiBinary, CliProxyApiInstallError>;
  }
>()("t3/providerProxy/CliProxyApiBinary") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const installSemaphore = yield* Semaphore.make(1);
  const asset = RELEASE_ASSETS[`${platform}-${arch}`];
  const executableName = platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  const managedPath = path.join(
    config.baseDir,
    "tools",
    "cliproxyapi",
    CLIPROXYAPI_VERSION,
    `${platform}-${arch}`,
    executableName,
  );

  const probeVersion = Effect.fn("CliProxyApiBinary.probeVersion")(function* (
    executablePath: string,
  ) {
    const info = yield* fileSystem.stat(executablePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return null;
    if (platform !== "win32" && (info.value.mode & 0o111) === 0) return null;
    return yield* spawner
      .string(ChildProcess.make(executablePath, ["-help"], { stdin: "ignore", stderr: "ignore" }))
      .pipe(
        Effect.map(parseCliProxyApiVersionOutput),
        Effect.timeoutOption(VERSION_PROBE_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
  });

  const override = Effect.gen(function* () {
    const value = (yield* HostProcess.Environment)[CLIPROXYAPI_PATH_ENV_NAME]?.trim();
    return value === undefined || value === "" ? null : value;
  });

  const resolve: CliProxyApiBinary["Service"]["resolve"] = Effect.gen(function* () {
    const overridePath = yield* override;
    if (overridePath !== null) {
      const version = yield* probeVersion(overridePath);
      if (version !== null && isCompatibleCliProxyApiVersion(version)) {
        return {
          status: "available",
          executablePath: overridePath,
          source: "override",
          version,
        } satisfies CliProxyApiBinaryStatus;
      }
      yield* Effect.logWarning(
        version === null
          ? `${CLIPROXYAPI_PATH_ENV_NAME} does not point to CLIProxyAPI`
          : `${CLIPROXYAPI_PATH_ENV_NAME} points to CLIProxyAPI ${version}; T3 Code needs ${CLIPROXYAPI_VERSION.split(".")[0]}.x`,
      );
      return { status: "missing" } satisfies CliProxyApiBinaryStatus;
    }
    if ((yield* probeVersion(managedPath)) === CLIPROXYAPI_VERSION) {
      return {
        status: "available",
        executablePath: managedPath,
        source: "managed",
        version: CLIPROXYAPI_VERSION,
      } satisfies CliProxyApiBinaryStatus;
    }
    return asset === undefined
      ? ({ status: "unsupported", platform, arch } satisfies CliProxyApiBinaryStatus)
      : ({ status: "missing" } satisfies CliProxyApiBinaryStatus);
  }).pipe(Effect.withSpan("CliProxyApiBinary.resolve"));

  const failWith =
    (reason: CliProxyApiInstallError["reason"]) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new CliProxyApiInstallError({ reason, cause })));

  const download = Effect.fn("CliProxyApiBinary.download")(function* (release: ReleaseAsset) {
    const bytes = yield* httpClient.execute(HttpClientRequest.get(release.url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.timeout(DOWNLOAD_TIMEOUT),
      failWith("download_failed"),
    );
    const data = new Uint8Array(bytes);
    const digest = yield* crypto.digest("SHA-256", data).pipe(failWith("validation_failed"));
    if (Hex.encode(digest) !== release.sha256) {
      return yield* new CliProxyApiInstallError({ reason: "invalid_checksum" });
    }
    return data;
  });

  const extract = Effect.fn("CliProxyApiBinary.extract")(function* (
    archivePath: string,
    directory: string,
    archive: ReleaseAsset["archive"],
  ) {
    // bsdtar, which Windows ships, also reads zip archives.
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "tar",
        [archive === "tgz" ? "-xzf" : "-xf", archivePath, "-C", directory, executableName],
        { shell: false, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      ),
    );
    const exitCode = Number(yield* child.exitCode);
    if (exitCode !== 0) {
      return yield* new CliProxyApiInstallError({ reason: "write_failed" });
    }
  });

  const renameWhenUnlocked = (from: string, to: string) =>
    fileSystem.rename(from, to).pipe(
      Effect.retry({
        times: ACTIVATE_RETRY_COUNT,
        schedule: Schedule.spaced(ACTIVATE_RETRY_DELAY),
        while: (error) => platform === "win32" && isWindowsRenameLock(error),
      }),
    );

  const installUnlocked = Effect.gen(function* () {
    const current = yield* resolve;
    if (current.status === "available") return current;
    if ((yield* override) !== null) {
      return yield* new CliProxyApiInstallError({ reason: "override_invalid" });
    }
    if (asset === undefined) {
      return yield* new CliProxyApiInstallError({ reason: "unsupported_platform" });
    }
    const managedDirectory = path.dirname(managedPath);
    yield* fileSystem
      .makeDirectory(managedDirectory, { recursive: true })
      .pipe(failWith("write_failed"));
    const staging = yield* fileSystem
      .makeTempDirectoryScoped({ directory: managedDirectory, prefix: ".install-" })
      .pipe(failWith("write_failed"));
    const archivePath = path.join(staging, asset.archive === "tgz" ? "release.tgz" : "release.zip");
    yield* Effect.logInfo("Downloading CLIProxyAPI", { version: CLIPROXYAPI_VERSION });
    const bytes = yield* download(asset);
    yield* fileSystem.writeFile(archivePath, bytes).pipe(failWith("write_failed"));
    yield* extract(archivePath, staging, asset.archive).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new CliProxyApiInstallError({ reason: "write_failed", cause })),
      }),
    );
    const stagedExecutable = path.join(staging, executableName);
    if (platform !== "win32") {
      yield* fileSystem.chmod(stagedExecutable, 0o755).pipe(failWith("write_failed"));
    }
    // A mislabeled asset would otherwise be redownloaded on every start.
    if ((yield* probeVersion(stagedExecutable)) !== CLIPROXYAPI_VERSION) {
      return yield* new CliProxyApiInstallError({ reason: "validation_failed" });
    }
    yield* renameWhenUnlocked(stagedExecutable, managedPath).pipe(failWith("write_failed"));
    return {
      status: "available",
      executablePath: managedPath,
      source: "managed",
      version: CLIPROXYAPI_VERSION,
    } satisfies AvailableCliProxyApiBinary;
  }).pipe(Effect.scoped);

  const install: CliProxyApiBinary["Service"]["install"] = installSemaphore
    .withPermit(installUnlocked)
    .pipe(Effect.withSpan("CliProxyApiBinary.install"));

  return CliProxyApiBinary.of({ resolve, install });
});

export const layer = Layer.effect(CliProxyApiBinary, make);
