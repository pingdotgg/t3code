// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";

const DRIVER = ProviderDriverKind.make("codex");
const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u));
const ActiveRelease = Schema.Struct({ version: Version });
const InstalledRelease = Schema.Struct({
  version: Version,
  target: Schema.String,
  sha256: Schema.String,
});
const PackageManifest = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  version: Version,
  target: Schema.String,
  entrypoint: Schema.String,
});
const decodeVersion = Schema.decodeUnknownEffect(Version);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));
const encodeActive = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
export interface CodexReleaseAsset {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
}
// Official complete packages retain the code-mode, search, and resource companions.
const RELEASES: Readonly<Record<string, CodexReleaseAsset>> = {
  "darwin-arm64": {
    version: "0.156.1",
    target: "aarch64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-package-aarch64-apple-darwin.tar.gz",
    sha256: "fea42f9625091f011e38f059da974d52e57ba31831648bb1c7f0b1a385fde547",
    archiveBytes: 127394863,
  },
  "darwin-x64": {
    version: "0.156.1",
    target: "x86_64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-package-x86_64-apple-darwin.tar.gz",
    sha256: "618dbcd55419fa041871f777a14b107ceb3fe2d339ef81e21e6ab5374420dc71",
    archiveBytes: 138670455,
  },
  "linux-arm64": {
    version: "0.156.1",
    target: "aarch64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-package-aarch64-unknown-linux-musl.tar.gz",
    sha256: "fdd47ed6aade0360796fd3f6f95a45096f327c15e19e8c7339f9dc5633041786",
    archiveBytes: 136933361,
  },
  "linux-x64": {
    version: "0.156.1",
    target: "x86_64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "8b711520beddf385467b8da4d2c93736637c6ba1e46811cf0d8606b7c490b6f6",
    archiveBytes: 145976992,
  },
  "win32-arm64": {
    version: "0.156.1",
    target: "aarch64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-package-aarch64-pc-windows-msvc.tar.gz",
    sha256: "85994caecdc7609c49fd585c1cdb5677fa9d0acbf789650cff23a13afc9505db",
    archiveBytes: 142037952,
  },
  "win32-x64": {
    version: "0.156.1",
    target: "x86_64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.156.1/codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: "a2e017db9807e6a2269a26fea0e1d9546469cef4d472a33016bc9f3ad7d3b733",
    archiveBytes: 153839991,
  },
};
export const resolveCodexReleaseAsset = (platform: NodeJS.Platform, arch: string) =>
  RELEASES[`${platform}-${arch}`] ?? null;
export class CodexInstallationError extends Schema.TaggedError<CodexInstallationError>()(
  "CodexInstallationError",
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
const isInstallationError = Schema.is(CodexInstallationError);
const installationError = (operation: string, detail: string, cause?: unknown) =>
  new CodexInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);
export interface CodexExecutable {
  readonly executablePath: string;
  readonly source: "managed" | "local";
  readonly version: string;
  readonly managedVersionDirectory: string | null;
}
interface CodexInstallationService {
  readonly managedDirectory: string;
  readonly resolve: () => Effect.Effect<CodexExecutable, CodexInstallationError>;
  readonly acquire: () => Effect.Effect<CodexExecutable, CodexInstallationError, Scope.Scope>;
  readonly start: Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, CodexInstallationError>;
}
export class CodexInstallation extends Context.Service<
  CodexInstallation,
  CodexInstallationService
>()("t3/provider/CodexInstallation") {
  static readonly layer = Layer.effect(
    CodexInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* makeCodexInstallation({ baseDir: config.baseDir });
    }),
  );
}
export interface CodexInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CodexReleaseAsset | null;
  readonly validate?: (
    executable: CodexExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, CodexInstallationError, Scope.Scope>;
}
const isRunning = (state: ProviderInstallState) =>
  ["downloading", "extracting", "verifying"].includes(state.phase);
export const makeCodexInstallation = Effect.fn("makeCodexInstallation")(function* (
  options: CodexInstallationOptions,
) {
  const manifestService = yield* ModelManifest.ModelManifest;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const arch = yield* HostProcessArchitecture;
  const asset =
    options.releaseAsset === undefined
      ? resolveCodexReleaseAsset(platform, arch)
      : options.releaseAsset;
  const managedDirectory = path.join(options.baseDir, "tools", "codex");
  const activePath = path.join(managedDirectory, "active.json");
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const gate = yield* Semaphore.make(1);
  let leases = 0;
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: asset?.archiveBytes ?? null,
    version: asset?.version ?? null,
    installedVersion: null,
    executablePath: null,
    canRemove: false,
    message: null,
  });
  const readRecord = Effect.fn("CodexInstallation.readRecord")(function* <A>(
    file: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(file);
    if (info.type !== "File" || Number(info.size) > 8192)
      return yield* installationError(
        "resolve",
        "The managed Codex installation record is invalid. Reinstall Codex.",
      );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
      yield* fs.readFileString(file),
    );
  });
  const fromDirectory = Effect.fn("CodexInstallation.fromDirectory")(function* (
    directory: string,
    version: string,
    target: string,
  ) {
    const manifest = yield* readRecord(path.join(directory, "codex-package.json"), PackageManifest);
    if (
      manifest.version !== version ||
      manifest.target !== target ||
      manifest.entrypoint !== `bin/${executableName}`
    )
      return yield* installationError(
        "verify",
        "The downloaded Codex package does not match the expected release.",
      );
    for (const name of [
      `bin/${executableName}`,
      `bin/codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
      `codex-path/rg${platform === "win32" ? ".exe" : ""}`,
    ]) {
      const info = yield* fs.stat(path.join(directory, name));
      if (
        info.type !== "File" ||
        Number(info.size) === 0 ||
        (platform !== "win32" && (info.mode & 0o111) === 0)
      )
        return yield* installationError(
          "verify",
          "The managed Codex package is incomplete. Reinstall Codex.",
        );
    }
    return {
      executablePath: path.join(directory, "bin", executableName),
      source: "managed",
      version,
      managedVersionDirectory: directory,
    } satisfies CodexExecutable;
  });
  const completedRelease = Effect.fn("CodexInstallation.completedRelease")(function* (
    version: string,
  ) {
    yield* decodeVersion(version);
    const directory = path.join(managedDirectory, version);
    const record = yield* readRecord(
      path.join(directory, ".install-complete.json"),
      InstalledRelease,
    );
    if (record.version !== version)
      return yield* installationError(
        "resolve",
        "The managed Codex installation record has the wrong version.",
      );
    return yield* fromDirectory(directory, version, record.target);
  });
  const compatibility = Effect.fn("CodexInstallation.compatibility")(function* (version: string) {
    const manifest = yield* manifestService.current;
    return (
      resolveProviderCompatibility(manifest.compatibility, DRIVER, version) ??
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        DRIVER,
        version,
      )
    );
  });
  const resolveManaged = Effect.fn("CodexInstallation.resolveManaged")(
    function* () {
      const active = yield* readRecord(activePath, ActiveRelease);
      const executable = yield* completedRelease(active.version);
      const advisory = yield* compatibility(executable.version);
      if (advisory?.status !== "supported")
        return yield* installationError(
          "resolve",
          advisory?.message ?? "Update the managed Codex installation to continue.",
        );
      return executable;
    },
    Effect.mapError(
      wrapFailure("resolve", "Codex is not installed in T3 Code. Install it to continue."),
    ),
  );
  const acquire = Effect.fn("CodexInstallation.acquire")(function* () {
    return yield* Effect.acquireRelease(
      gate.withPermit(
        resolve().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              leases += 1;
            }),
          ),
        ),
      ),
      () =>
        Effect.sync(() => {
          leases -= 1;
        }),
    );
  });
  const runCommand = Effect.fn("CodexInstallation.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const resolved = yield* resolveSpawnCommand(command, args).pipe(
      Effect.provideService(HostProcessPlatform, platform),
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, { shell: resolved.shell }),
    );
    const [output, , exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.runDrain),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* installationError(
        "verify",
        "Could not unpack or start the downloaded Codex package.",
      );
    return output;
  }, Effect.scoped);
  const localCache = new Map<string, { fingerprint: string; executable: CodexExecutable | null }>();
  const resolveLocal = Effect.fn("CodexInstallation.resolveLocal")(
    function* () {
      const executablePath = yield* resolveCommandPath("codex", { env: environment }).pipe(
        Effect.provideService(HostProcessPlatform, platform),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      // Keep launcher symlinks intact: version-manager shims dispatch by their invoked name.
      const realExecutablePath = yield* fs.realPath(executablePath);
      // A PATH entry pointing into T3's download remains a managed installation.
      const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
      if (
        realExecutablePath.startsWith(
          `${Option.getOrElse(realManaged, () => managedDirectory)}${path.sep}`,
        )
      )
        return null;
      const info = yield* fs.stat(executablePath);
      const fingerprint = `${realExecutablePath}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Option.getOrUndefined(info.ino)}`;
      const cached = localCache.get(executablePath);
      const executable =
        cached?.fingerprint === fingerprint
          ? cached.executable
          : yield* Effect.gen(function* () {
              const output = yield* runCommand(executablePath, ["--version"]);
              const version = /^codex-cli (\d+\.\d+\.\d+)$/u.exec(output.trim())?.[1];
              if (!version) return null;
              yield* runCommand(executablePath, ["app-server", "--help"]);
              return {
                executablePath,
                source: "local",
                version,
                managedVersionDirectory: null,
              } satisfies CodexExecutable;
            }).pipe(
              Effect.timeout("5 seconds"),
              Effect.orElseSucceed(() => null),
            );
      localCache.set(executablePath, { fingerprint, executable });
      if (!executable) return null;
      // Cache executable probes, but reclassify against the current manifest on every resolve.
      const advisory = yield* compatibility(executable.version);
      return advisory?.status === "supported" ? executable : null;
    },
    Effect.orElseSucceed(() => null),
  );
  const resolve = Effect.fn("CodexInstallation.resolve")(function* () {
    const local = yield* resolveLocal();
    return local ?? (yield* resolveManaged());
  });
  const reuseLocal = Effect.fn("CodexInstallation.reuseLocal")(function* () {
    const local = yield* resolveLocal();
    if (!local) return false;
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          phase: "succeeded",
          source: "local",
          operationId: null,
          installedVersion: local.version,
          executablePath: local.executablePath,
          downloadedBytes: 0,
          totalBytes: null,
          message: null,
        }) satisfies ProviderInstallState,
    );
    return true;
  });
  const validate =
    options.validate ??
    Effect.fn("CodexInstallation.validate")(
      function* (executable: CodexExecutable, version: string) {
        const output = yield* runCommand(executable.executablePath, ["--version"]);
        if (output.trim() !== `codex-cli ${version}`)
          return yield* installationError(
            "verify",
            "The downloaded Codex executable has the wrong version.",
          );
      },
      Effect.mapError(wrapFailure("verify", "The downloaded Codex runtime could not start.")),
    );
  const install = Effect.fn("CodexInstallation.install")(
    function* (release: CodexReleaseAsset) {
      yield* decodeVersion(release.version);
      yield* fs.makeDirectory(managedDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(managedDirectory, release.version);
      const activate = Effect.fn("CodexInstallation.activate")(
        function* () {
          const executable = yield* completedRelease(release.version);
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: ".active-",
          });
          const pointer = path.join(temporary, "active.json");
          yield* fs.writeFileString(pointer, yield* encodeActive({ version: release.version }), {
            mode: 0o600,
            flag: "wx",
          });
          yield* fs.rename(pointer, activePath);
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                phase: "succeeded",
                source: "managed",
                installedVersion: release.version,
                executablePath: executable.executablePath,
                message: null,
              }) satisfies ProviderInstallState,
          );
        },
        Effect.scoped,
        Effect.uninterruptible,
      );
      if (yield* fs.exists(destination)) {
        const existing = yield* completedRelease(release.version);
        const record = yield* readRecord(
          path.join(destination, ".install-complete.json"),
          InstalledRelease,
        );
        if (record.sha256 !== release.sha256 || record.target !== release.target)
          return yield* installationError(
            "verify",
            "The existing managed Codex release differs from the official package. Remove it and reinstall.",
          );
        yield* validate(existing, release.version).pipe(
          Effect.scoped,
          Effect.timeout("90 seconds"),
        );
        yield* activate();
        return;
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: managedDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.tar.gz");
      const runtime = path.join(staging, "runtime");
      yield* fs.makeDirectory(runtime);
      const hash = NodeCrypto.createHash("sha256");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      const response = yield* http
        .execute(HttpClientRequest.get(release.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > release.archiveBytes)
              return yield* installationError(
                "download",
                "The Codex download exceeded the expected release size.",
              );
            hash.update(chunk);
            const now = yield* Clock.currentTimeMillis;
            if (now - lastProgressAt >= 250 || downloadedBytes === release.archiveBytes) {
              lastProgressAt = now;
              yield* SubscriptionRef.update(state, (current) => ({ ...current, downloadedBytes }));
            }
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        Effect.timeout("45 minutes"),
      );
      if (downloadedBytes !== release.archiveBytes || hash.digest("hex") !== release.sha256)
        return yield* installationError(
          "download",
          "The Codex download failed its size or SHA-256 check. Nothing was installed.",
        );
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "extracting",
            message: "Extracting Codex.",
          }) satisfies ProviderInstallState,
      );
      const entries = (yield* runCommand("tar", ["-tzf", archivePath])).trim().split("\n");
      const types = (yield* runCommand("tar", ["-tvzf", archivePath])).trim().split("\n");
      if (
        entries.length > 10000 ||
        entries.length !== types.length ||
        types.some((line) => !["-", "d"].includes(line[0] ?? "")) ||
        entries.some((entry) => {
          const parts = entry.replace(/\/$/u, "").split("/");
          return (
            !entry ||
            entry.includes("\\") ||
            entry.startsWith("/") ||
            parts.some((part) => part === ".." || part === "." || part === "" || part.includes(":"))
          );
        })
      )
        return yield* installationError("extract", "The Codex archive contains unsafe entries.");
      yield* runCommand("tar", ["-xzf", archivePath, "-C", runtime]);
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "verifying",
            message: "Checking Codex.",
          }) satisfies ProviderInstallState,
      );
      const executable = yield* fromDirectory(runtime, release.version, release.target);
      yield* validate(executable, release.version).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
      );
      yield* fs.writeFileString(
        path.join(runtime, ".install-complete.json"),
        yield* encodeRecord({
          version: release.version,
          target: release.target,
          sha256: release.sha256,
        }),
        { flag: "wx", mode: 0o600 },
      );
      yield* fs.rename(runtime, destination);
      yield* activate();
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Codex. Check disk space and directory access, then try again.",
      ),
    ),
  );
  const start = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        if (yield* reuseLocal()) return yield* SubscriptionRef.get(state);
        if (!asset) {
          return yield* installationError(
            "start",
            `OpenAI does not publish a Codex runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
          );
        }
        const operationId = yield* crypto.randomUUIDv4;
        const next: ProviderInstallState = {
          driver: DRIVER,
          operationId,
          phase: "downloading",
          downloadedBytes: 0,
          totalBytes: asset.archiveBytes,
          version: asset.version,
          installedVersion: current.installedVersion,
          canRemove: current.canRemove,
          message: "Downloading Codex.",
        };
        yield* SubscriptionRef.set(state, next);
        const work = install(asset).pipe(
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
                        : "Could not finish the Codex installation. Check disk space and directory access.",
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
    )
    .pipe(Effect.mapError(wrapFailure("start", "Could not start the Codex installation.")));

  const cancel = Effect.fn("CodexInstallation.cancel")(function* (operationId: string) {
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

  const remove = Effect.fn("CodexInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases > 0) {
            return yield* installationError(
              "remove",
              "Stop Codex sessions and sign-in flows before removing its managed runtime.",
            );
          }
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binary of protectedBinaryPaths) {
              const resolved = yield* fs.realPath(binary).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binary));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`))
                return yield* installationError(
                  "remove",
                  "A provider instance uses a custom path inside managed Codex. Clear that path before removing it.",
                );
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                executablePath: null,
                source: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
          yield* reuseLocal();
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Codex runtime. Check for open processes and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    const canRemove = yield* fs.exists(managedDirectory);
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (yield* reuseLocal()) return;
    if (!(yield* fs.exists(activePath))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    const installed = yield* completedRelease(active.version);
    yield* SubscriptionRef.update(
      state,
      (current) =>
        ({
          ...current,
          installedVersion: installed.version,
          executablePath: installed.executablePath,
          source: "managed",
        }) satisfies ProviderInstallState,
    );
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: "The managed Codex runtime is incomplete. Remove it and reinstall.",
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  return CodexInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  });
});
