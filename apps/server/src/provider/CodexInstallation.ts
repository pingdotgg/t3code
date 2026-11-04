// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  ProviderDriverKind,
  type ProviderInstallState,
  type ServerProviderCompatibilityAdvisory,
} from "@t3tools/contracts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
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
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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
const STAGING_STALE_AFTER_MS = 24 * 60 * 60_000;
const RELEASE_CHECK_SUCCESS_TTL_MS = 3_600_000;
const RELEASE_CHECK_FAILURE_COOLDOWN_MS = 30_000;
const RELEASE_CHECK_RATE_LIMIT_MESSAGE =
  "GitHub rate-limited Codex release checks. Sign in to GitHub in Settings → Source Control or try again after the rate limit resets.";
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
const TARGETS: Readonly<Record<string, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      digest: Schema.NullOr(Schema.String),
      browser_download_url: Schema.String,
    }),
  ),
});
const hasGitHubRateLimitHeaders = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
) =>
  status === 429 ||
  (status === 403 &&
    (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined));
const retryAtFromGitHubHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
) => {
  const deadlines: Array<number> = [];
  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    const retryAfterAt = Number.isFinite(seconds)
      ? now + Math.max(seconds, 0) * 1_000
      : Date.parse(retryAfter);
    if (Number.isFinite(retryAfterAt) && retryAfterAt > now) deadlines.push(retryAfterAt);
  }
  const reset = headers["x-ratelimit-reset"];
  if (reset !== undefined) {
    const resetAt = Number(reset) * 1_000;
    if (Number.isFinite(resetAt) && resetAt > now) deadlines.push(resetAt);
  }
  return deadlines.length === 0 ? undefined : Math.max(...deadlines);
};
export const resolveCodexReleaseAsset = (
  platform: NodeJS.Platform,
  arch: string,
  release: typeof Release.Type,
): CodexReleaseAsset | null => {
  const target = TARGETS[`${platform}-${arch}`];
  const version = /^rust-v(\d+\.\d+\.\d+)$/u.exec(release.tag_name)?.[1];
  if (!target || !version || release.draft || release.prerelease) return null;
  const name = `codex-package-${target}.tar.gz`;
  const asset = release.assets.find((candidate) => candidate.name === name);
  const sha256 = /^sha256:([a-fA-F0-9]{64})$/u.exec(asset?.digest ?? "")?.[1];
  const url = `https://github.com/openai/codex/releases/download/${release.tag_name}/${name}`;
  if (
    !asset ||
    !sha256 ||
    asset.browser_download_url !== url ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  )
    return null;
  return { version, target, url, sha256: sha256.toLowerCase(), archiveBytes: asset.size };
};
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
  readonly refresh: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<void, CodexInstallationError>;
  readonly resolve: () => Effect.Effect<CodexExecutable, CodexInstallationError>;
  readonly acquire: (
    options?: CodexRuntimeOptions,
  ) => Effect.Effect<CodexExecutable, CodexInstallationError, Scope.Scope>;
  readonly start: (
    options?: CodexRuntimeOptions,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly compatibility: (
    version: string,
  ) => Effect.Effect<ServerProviderCompatibilityAdvisory | undefined>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, CodexInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, CodexInstallationError>;
}
interface CodexRuntimeOptions {
  readonly managedOnly?: boolean;
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
  ).pipe(Layer.provide(GitHubCredentials.layer));
}
export interface CodexInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: CodexReleaseAsset | null | undefined;
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
  const random = yield* SecureRandom.SecureRandom;
  const http = yield* HttpClient.HttpClient;
  const githubCredentials = yield* GitHubCredentials.GitHubCredentials;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const arch = yield* HostProcess.Architecture;
  let asset = options.releaseAsset ?? null;
  let checkedAt: number | undefined;
  let retryAt: number | undefined;
  let lastDiscoveryFailure: CodexInstallationError | undefined;
  let lastDiscoveryFailureCredentialFingerprint: string | null | undefined;
  let currentDiscoveryCredentialFingerprint: string | null = null;
  // Settings-backed tokens can return after cache invalidation, so skip a rejected token until credentials change.
  let rejectedCredentialFingerprint: string | undefined;
  const discoveryGate = yield* Semaphore.make(1);
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
  const refresh: CodexInstallationService["refresh"] = Effect.fn("CodexInstallation.refresh")(
    function* (input?: { readonly fresh?: boolean }) {
      if (options.releaseAsset !== undefined) return;
      const current = yield* SubscriptionRef.get(state);
      if (isRunning(current)) return;
      currentDiscoveryCredentialFingerprint = null;
      const now = yield* Clock.currentTimeMillis;
      let credential: Option.Option<GitHubCredentials.GitHubCredential> | undefined;
      if (retryAt !== undefined && lastDiscoveryFailure !== undefined) {
        credential = yield* Effect.option(githubCredentials.get("github.com"));
        currentDiscoveryCredentialFingerprint = Option.match(credential, {
          onNone: () => null,
          onSome: (value) => value.fingerprint,
        });
        if (
          now < retryAt &&
          lastDiscoveryFailureCredentialFingerprint === currentDiscoveryCredentialFingerprint
        )
          return yield* lastDiscoveryFailure;
        retryAt = undefined;
        lastDiscoveryFailure = undefined;
        lastDiscoveryFailureCredentialFingerprint = undefined;
      } else if (
        !input?.fresh &&
        checkedAt !== undefined &&
        now - checkedAt < RELEASE_CHECK_SUCCESS_TTL_MS
      )
        return;
      credential ??= yield* Effect.option(githubCredentials.get("github.com"));
      currentDiscoveryCredentialFingerprint = Option.match(credential, {
        onNone: () => null,
        onSome: (value) => value.fingerprint,
      });
      const baseRequest = HttpClientRequest.get(
        "https://api.github.com/repos/openai/codex/releases/latest",
      ).pipe(HttpClientRequest.setHeader("Accept", "application/vnd.github+json"));
      const authenticatedCredential = Option.filter(
        credential,
        (value) => value.fingerprint !== rejectedCredentialFingerprint,
      );
      const request = Option.match(authenticatedCredential, {
        onNone: () => baseRequest,
        onSome: (value) =>
          HttpClientRequest.setHeader(
            baseRequest,
            "Authorization",
            `Bearer ${Redacted.value(value.token)}`,
          ),
      });
      let response = yield* http.execute(request).pipe(Effect.timeout("5 seconds"));
      if (response.status === 401 && Option.isSome(authenticatedCredential)) {
        rejectedCredentialFingerprint = authenticatedCredential.value.fingerprint;
        yield* githubCredentials.invalidate("github.com");
        response = yield* http.execute(baseRequest).pipe(Effect.timeout("5 seconds"));
      }
      const responseAt = yield* Clock.currentTimeMillis;
      if (response.status < 200 || response.status >= 300) {
        let rateLimited = hasGitHubRateLimitHeaders(response.status, response.headers);
        if (!rateLimited && response.status === 403) {
          const body = yield* response.text.pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => ""),
          );
          rateLimited = /rate limit/i.test(body);
        }
        if (rateLimited) {
          retryAt =
            retryAtFromGitHubHeaders(response.headers, responseAt) ??
            responseAt + RELEASE_CHECK_FAILURE_COOLDOWN_MS;
          return yield* installationError("refresh", RELEASE_CHECK_RATE_LIMIT_MESSAGE);
        }
        yield* HttpClientResponse.filterStatusOk(response);
      }
      const release = yield* HttpClientResponse.schemaBodyJson(Release)(response).pipe(
        Effect.timeout("5 seconds"),
      );
      const discovered = resolveCodexReleaseAsset(platform, arch, release);
      if (!discovered)
        return yield* installationError(
          "refresh",
          "The latest Codex release has no verified package for this platform.",
        );
      asset = discovered;
      checkedAt = yield* Clock.currentTimeMillis;
      yield* SubscriptionRef.update(state, (value) =>
        isRunning(value)
          ? value
          : {
              ...value,
              version: discovered.version,
              totalBytes: discovered.archiveBytes,
            },
      );
    },
    Effect.mapError(wrapFailure("refresh", "Could not check for Codex updates. Try again.")),
    Effect.tapError((failure) =>
      Effect.gen(function* () {
        lastDiscoveryFailure = failure;
        lastDiscoveryFailureCredentialFingerprint = currentDiscoveryCredentialFingerprint;
        retryAt ??= (yield* Clock.currentTimeMillis) + RELEASE_CHECK_FAILURE_COOLDOWN_MS;
      }),
    ),
    discoveryGate.withPermit,
  );
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
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
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
  const acquire = Effect.fn("CodexInstallation.acquire")(function* (options?: CodexRuntimeOptions) {
    return yield* Effect.acquireRelease(
      gate.withPermit(
        (options?.managedOnly === true ? resolveManaged() : resolve()).pipe(
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
      Effect.provideService(HostProcess.Platform, platform),
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
  // Native Codex needs its adjacent host; launchers resolve their own payloads.
  const hasCodeModeHost = Effect.fn("CodexInstallation.hasCodeModeHost")(
    function* (realExecutablePath: string) {
      if (/^(?:volta-shim|mise|aqua-proxy)(?:\.exe)?$/iu.test(path.basename(realExecutablePath)))
        return true;
      if (platform === "win32") {
        if (path.extname(realExecutablePath).toLowerCase() !== ".exe") return true;
        for (const extension of [".bunx", ".shim"]) {
          const marker = yield* fs
            .stat(realExecutablePath.slice(0, -4) + extension)
            .pipe(Effect.option);
          if (
            Option.isSome(marker) &&
            marker.value.type === "File" &&
            Number(marker.value.size) > 0
          )
            return true;
        }
      } else {
        const header = yield* fs.open(realExecutablePath, { flag: "r" }).pipe(
          Effect.flatMap((file) => file.readAlloc(2)),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isSome(header) && header.value[0] === 0x23 && header.value[1] === 0x21)
          return true;
      }
      const info = yield* fs.stat(
        path.join(
          path.dirname(realExecutablePath),
          `codex-code-mode-host${platform === "win32" ? ".exe" : ""}`,
        ),
      );
      return (
        info.type === "File" &&
        Number(info.size) > 0 &&
        (platform === "win32" || (info.mode & 0o111) !== 0)
      );
    },
    Effect.scoped,
    Effect.orElseSucceed(() => false),
  );
  const localCache = new Map<string, { fingerprint: string; executable: CodexExecutable | null }>();
  const resolveLocal = Effect.fn("CodexInstallation.resolveLocal")(
    function* () {
      const executablePath = yield* resolveCommandPath("codex", { env: environment }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      if (executablePath === null) return null;
      // Keep launcher symlinks intact: version-manager shims dispatch by their invoked name.
      const realExecutablePath = yield* fs.realPath(executablePath);
      const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
      if (
        realExecutablePath.startsWith(
          `${Option.getOrElse(realManaged, () => managedDirectory)}${path.sep}`,
        )
      )
        return null;
      if (!(yield* hasCodeModeHost(realExecutablePath))) return null;
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
        Effect.catchTags({
          TimeoutError: (cause) =>
            installationError(
              "download",
              "The Codex download timed out. Retry installation.",
              cause,
            ),
        }),
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
      // Bare `tar` on Windows can resolve to Git's MSYS tar, which reads `C:\...` as a remote host.
      const tarCommand = cliArchiveTarCommand(platform, environment);
      const entries = (yield* runCommand(tarCommand, ["-tzf", archivePath])).trim().split(/\r?\n/u);
      const types = (yield* runCommand(tarCommand, ["-tvzf", archivePath])).trim().split(/\r?\n/u);
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
      yield* runCommand(tarCommand, ["-xzf", archivePath, "-C", runtime]);
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
      // Windows Defender or process rundown may retain codex.exe handles briefly after --version exits.
      const renameRuntime = fs.rename(runtime, destination);
      yield* platform === "win32"
        ? renameRuntime.pipe(Effect.retry({ times: 10, schedule: Schedule.spaced("100 millis") }))
        : renameRuntime;
      yield* activate();
    },
    Effect.scoped,
    Effect.catchTags({
      HttpClientError: (cause) => {
        const httpStatus =
          cause.reason._tag === "StatusCodeError" ? cause.reason.response.status : undefined;
        return new CodexInstallationError({
          operation: "download",
          detail:
            httpStatus === undefined
              ? "The Codex download was interrupted. Check your internet connection, then retry installation."
              : `The Codex download server returned HTTP ${httpStatus}. Try again later.`,
          cause,
        });
      },
    }),
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Codex. Check disk space and directory access, then try again.",
      ),
    ),
  );
  const start = (options?: CodexRuntimeOptions) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (isRunning(current)) return current;
          if (!options?.managedOnly && (yield* reuseLocal()))
            return yield* SubscriptionRef.get(state);
          if (!asset) yield* refresh({ fresh: true });
          if (!asset) {
            return yield* installationError(
              "start",
              `OpenAI does not publish a Codex runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
            );
          }
          const release = asset;
          if (
            current.installedVersion &&
            compareSemverVersions(current.installedVersion, release.version) > 0
          ) {
            return yield* SubscriptionRef.get(state);
          }
          const operationId = yield* random.uuidV4();
          const next: ProviderInstallState = {
            driver: DRIVER,
            operationId,
            phase: "downloading",
            downloadedBytes: 0,
            totalBytes: release.archiveBytes,
            version: release.version,
            installedVersion: current.installedVersion,
            canRemove: current.canRemove,
            message: "Downloading Codex.",
          };
          yield* SubscriptionRef.set(state, next);
          const work = install(release).pipe(
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
    // Shared-home installs do not refresh parent mtimes; remove only staging directories far older than the 45-minute download cap.
    let canRemove = false;
    if (yield* fs.exists(managedDirectory)) {
      const entries = yield* fs
        .readDirectory(managedDirectory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const now = yield* Clock.currentTimeMillis;
      for (const entry of entries) {
        if (!entry.startsWith(".install-") && !entry.startsWith(".active-")) continue;
        const target = path.join(managedDirectory, entry);
        const info = yield* fs.stat(target).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const modifiedAt = Option.match(info.value.mtime, {
          onNone: () => now,
          onSome: (date) => date.getTime(),
        });
        if (now - modifiedAt < STAGING_STALE_AFTER_MS) continue;
        yield* fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
      }
      // Keep the empty root to avoid racing new staging directories; unreadable roots remain removable.
      const remaining = yield* fs.readDirectory(managedDirectory).pipe(Effect.option);
      canRemove = Option.isNone(remaining) || remaining.value.length > 0;
    }
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
    refresh,
    resolve,
    acquire,
    compatibility,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  });
});
