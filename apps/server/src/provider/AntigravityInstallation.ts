// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or free-space query.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
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
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as EffectAcpErrors from "effect-acp/errors";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import {
  ACP_REGISTRY_URL,
  MAX_REGISTRY_BYTES,
  resolveAcpRegistryPlatformTarget,
} from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";

import * as ServerConfig from "../config.ts";
import { openZipArchive } from "../zipArchive.ts";
import { makeAntigravityAcpRuntime } from "./acp/AntigravityAcpSupport.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
} from "./antigravityAuthSupport.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityRelease,
  type AntigravityReleaseAsset,
  type AntigravityUpstreamRelease,
} from "./antigravityRelease.ts";
import { selectManagedRelease } from "./managedRelease.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { resolveProviderCompatibility } from "./providerCompatibility.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const DOWNLOAD_TIMEOUT = "45 minutes";
const VALIDATION_TIMEOUT = "90 seconds";
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = ".install-complete.json";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;
const UPDATE_CHECK_TIMEOUT = "20 seconds";
const UPSTREAM_AGENT_ID = "antigravity-acp";
const UPSTREAM_DOWNLOAD_PREFIX = "https://dl.google.com/agy-extensions/releases/";
// An upstream release has no pinned sizes. Current archives are about 340 MB
// and extract to about 1.1 GB.
const UPSTREAM_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const UPSTREAM_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

const decodeRegistryIndex = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ agents: Schema.Array(Schema.Unknown) })),
);
const isUpstreamAgent = Schema.is(Schema.Struct({ id: Schema.Literal(UPSTREAM_AGENT_ID) }));
const decodeRegistryAgent = Schema.decodeUnknownEffect(
  Schema.Struct({
    version: Schema.String,
    distribution: Schema.Struct({
      binary: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Struct({ archive: Schema.String })),
      ),
    }),
  }),
);

const ReleaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ActiveRelease = Schema.Struct({ releaseId: ReleaseId });
const InstalledRelease = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
  harness: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
});
type InstalledRelease = typeof InstalledRelease.Type;
const encodeActiveRelease = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
const encodeInstalledRelease = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));

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
  readonly harnessPath: string;
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
  readonly start: Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  /**
   * Looks up the newest release in the ACP Registry, at most hourly, and
   * offers it through `state.version` when it is newer than the install.
   */
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
      return yield* makeAntigravityInstallation({ baseDir: config.baseDir });
    }),
  );
}

export interface AntigravityInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: AntigravityReleaseAsset | null;
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

function executableNames(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
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
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const releaseAsset =
    options.releaseAsset === undefined
      ? resolveAntigravityReleaseAsset(platform, arch)
      : options.releaseAsset;
  const names = executableNames(platform);
  const managedDirectory = path.join(
    options.baseDir,
    "tools",
    "antigravity-acp",
    `${platform}-${arch}`,
  );
  const versionsDirectory = path.join(managedDirectory, "versions");
  const activePath = path.join(managedDirectory, "active.json");
  const gate = yield* Semaphore.make(1);
  const updateCheckGate = yield* Semaphore.make(1);
  const leases = new Map<string, number>();
  let running: { readonly operationId: string; readonly fiber: Fiber.Fiber<void> } | undefined;
  let upstream: AntigravityUpstreamRelease | null = null;
  let upstreamCheckedAt: number | null = null;

  // What `start` installs next. Clients compare `version` with
  // `installedVersion` to offer an update.
  const offer = (installedVersion: string | null) => {
    const release = selectManagedRelease<AntigravityRelease>(
      installedVersion,
      releaseAsset,
      upstream,
    );
    return {
      version: release?.version ?? installedVersion,
      totalBytes: release && "archiveBytes" in release ? release.archiveBytes : null,
    };
  };

  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    ...offer(null),
    installedVersion: null,
    canRemove: false,
    message: null,
  });

  // The model manifest can withdraw a bad upstream release without a T3 Code release.
  const isWithdrawn = Effect.fn("AntigravityInstallation.isWithdrawn")(function* (version: string) {
    const manifest = yield* manifestService.current;
    const status = (
      resolveProviderCompatibility(manifest.compatibility, DRIVER, version) ??
      resolveProviderCompatibility(
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
        DRIVER,
        version,
      )
    )?.status;
    return status === "broken" || status === "unsupported";
  });

  // Forgets what the manifest withdrew after it was seen. A withdrawn install
  // is not kept either, so the pin replaces it rather than a re-check.
  const keptInstall = Effect.fn("AntigravityInstallation.keptInstall")(function* (
    installedVersion: string | null,
  ) {
    if (upstream && (yield* isWithdrawn(upstream.version))) upstream = null;
    return installedVersion !== null && !(yield* isWithdrawn(installedVersion))
      ? installedVersion
      : null;
  });

  const lookupUpstream = Effect.gen(function* () {
    const target = resolveAcpRegistryPlatformTarget(platform, arch);
    if (!target) return null;
    const response = yield* http
      .execute(HttpClientRequest.get(ACP_REGISTRY_URL))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const body = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: MAX_REGISTRY_BYTES + 1,
    });
    if (body.truncated || body.bytes > MAX_REGISTRY_BYTES || body.invalidUtf8) return null;
    const index = yield* decodeRegistryIndex(body.text);
    const entry = index.agents.find(isUpstreamAgent);
    if (!entry) return null;
    const agent = yield* decodeRegistryAgent(entry);
    // Checked after normalization so an encoded `..` cannot leave the releases path.
    const archive = agent.distribution.binary?.[target]?.archive;
    const url = archive === undefined ? undefined : URL.parse(archive)?.href;
    if (!/^\d+\.\d+\.\d+$/u.test(agent.version) || !url?.startsWith(UPSTREAM_DOWNLOAD_PREFIX)) {
      return null;
    }
    if (yield* isWithdrawn(agent.version)) return null;
    return { version: agent.version, url } satisfies AntigravityUpstreamRelease;
  });

  // A check already in flight covers concurrent subscribers, including when it fails.
  const checkForUpdate = updateCheckGate
    .withPermitsIfAvailable(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (upstreamCheckedAt === null || now - upstreamCheckedAt >= UPDATE_CHECK_INTERVAL_MS) {
          // A failed lookup counts too, and keeps whatever release was offered before.
          upstreamCheckedAt = now;
          upstream = yield* lookupUpstream.pipe(
            Effect.timeout(UPDATE_CHECK_TIMEOUT),
            Effect.orElseSucceed(() => upstream),
          );
        }
        // A running install already published the release it is installing.
        yield* SubscriptionRef.updateEffect(state, (current) =>
          isRunning(current)
            ? Effect.succeed(current)
            : keptInstall(current.installedVersion).pipe(
                Effect.map((kept) => ({ ...current, ...offer(kept) })),
              ),
        );
      }),
    )
    .pipe(Effect.ignore);

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

  const completedRelease = Effect.fn("AntigravityInstallation.completedRelease")(function* (
    releaseId: string,
  ) {
    const directory = path.join(versionsDirectory, releaseId);
    const record = yield* readRecord(path.join(directory, RELEASE_RECORD), InstalledRelease);
    if (
      record.releaseId !== releaseId ||
      record.executable.name !== names.executable ||
      record.harness.name !== names.harness ||
      !Number.isSafeInteger(record.executable.bytes) ||
      record.executable.bytes <= 0 ||
      !Number.isSafeInteger(record.harness.bytes) ||
      record.harness.bytes <= 0 ||
      !record.version.trim() ||
      !(yield* executableFile(path.join(directory, names.executable), record.executable.bytes)) ||
      !(yield* executableFile(path.join(directory, names.harness), record.harness.bytes))
    ) {
      return yield* installationError(
        "resolve",
        "The managed Antigravity runtime is incomplete. Reinstall it.",
      );
    }
    return {
      executablePath: path.join(directory, names.executable),
      harnessPath: path.join(directory, names.harness),
      source: "managed",
      version: record.version,
      managedVersionDirectory: directory,
    } satisfies AntigravityExecutable;
  });

  const fromExternal = Effect.fn("AntigravityInstallation.fromExternal")(function* (
    candidate: string,
    source: "override" | "path",
  ) {
    if (!(yield* executableFile(candidate))) return null;
    const executablePath = yield* fs.realPath(candidate);
    const directory = path.dirname(executablePath);
    const harnessPath = path.join(directory, names.harness);
    if (!(yield* executableFile(harnessPath))) return null;
    const realVersions = yield* fs.realPath(versionsDirectory).pipe(Effect.option);
    if (
      Option.isSome(realVersions) &&
      path.dirname(directory) === realVersions.value &&
      /^[a-f0-9]{64}$/u.test(path.basename(directory))
    ) {
      const installed = yield* completedRelease(path.basename(directory));
      return { ...installed, executablePath, harnessPath, source } satisfies AntigravityExecutable;
    }
    return {
      executablePath,
      harnessPath,
      source,
      version: null,
      managedVersionDirectory: null,
    } satisfies AntigravityExecutable;
  });

  const pathCandidates = (binary: string, processEnvironment = environment) => {
    const pathValue =
      platform === "win32"
        ? Object.entries(processEnvironment).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
        : processEnvironment.PATH;
    return (pathValue ?? "")
      .split(platform === "win32" ? ";" : ":")
      .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
      .filter((directory) => directory.length > 0)
      .map((directory) => path.resolve(directory, binary));
  };

  const resolve: AntigravityInstallationService["resolve"] = Effect.fn(
    "AntigravityInstallation.resolve",
  )(
    function* (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) {
      const override = binaryPath?.trim();
      if (override) {
        const candidates =
          path.isAbsolute(override) || override.includes("/") || override.includes("\\")
            ? [path.resolve(override)]
            : pathCandidates(override, processEnvironment);
        for (const candidate of candidates) {
          const selected = yield* fromExternal(candidate, "override");
          if (selected) return selected;
        }
        return yield* installationError(
          "resolve",
          "The custom Antigravity executable or its localharness_external sibling is missing or not executable.",
        );
      }
      if (yield* fs.exists(activePath)) {
        const active = yield* readRecord(activePath, ActiveRelease);
        const installed = yield* completedRelease(active.releaseId);
        // Without this a withdrawn install keeps launching until its owner updates.
        if (yield* isWithdrawn(installed.version)) {
          return yield* installationError(
            "resolve",
            `Antigravity ${installed.version} no longer works with this T3 Code release. Update it in Antigravity setup.`,
          );
        }
        return installed;
      }
      for (const candidate of pathCandidates(names.executable, processEnvironment)) {
        const selected = yield* fromExternal(candidate, "path");
        if (selected) return selected;
      }
      return yield* installationError(
        "resolve",
        releaseAsset
          ? "Antigravity ACP runtime is not installed. Install it in this environment's provider settings or set a custom ACP executable path. The Antigravity app, IDE, and CLI are separate installations."
          : `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported environment or a custom executable.`,
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

  const validate =
    options.validate ??
    Effect.fn("AntigravityInstallation.validate")(
      function* (executable: AntigravityExecutable, expectedVersion: string) {
        const validationScope = yield* Effect.scope;
        const profileDirectory = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "t3-antigravity-validate-" }),
          (directory) =>
            fs.remove(directory, { recursive: true, force: true }).pipe(
              // Windows may retain DLL handles briefly after taskkill returns.
              Effect.retry({
                times: platform === "win32" ? 10 : 0,
                schedule: Schedule.spaced("100 millis"),
                while: (error) =>
                  error.reason._tag === "PermissionDenied" ||
                  error.reason._tag === "Busy" ||
                  error.reason._tag === "Unknown",
              }),
              Effect.orDie,
            ),
        );
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          platform,
          baseEnv: environment,
          // A shallow scoped profile cleans up unpacked files within Windows' path limit.
          tempDirectory: profileDirectory,
        });
        const runtime = yield* makeAntigravityAcpRuntime({
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
          initialized.agentInfo?.name !== "antigravity-acp" ||
          initialized.agentInfo.version !== expectedVersion ||
          // Antigravity 1.1.1 may report protocol 2 with legacy ACP; choose wire format from the response shape.
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
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) => {
        if (isInstallationError(cause)) return cause;
        const detail =
          isAcpProcessExitedError(cause) &&
          /\b(?:AF_INET6|enforce_kernel_ipv6_support)\b/.test(cause.stderr ?? "")
            ? "Antigravity requires IPv6 socket support. Enable IPv6 in this environment. On WSL, remove ipv6.disable=1 from .wslconfig and run wsl --shutdown."
            : "The downloaded Antigravity runtime could not start in this environment.";
        return installationError("verify", detail, cause);
      }),
    );

  const install = Effect.fn("AntigravityInstallation.install")(
    function* (release: AntigravityRelease) {
      // A pinned release is checked against its recorded hash and sizes. An
      // upstream release is bounded instead and identified by what downloads.
      const pin = "sha256" in release ? release : null;
      const ensureEligible = Effect.fn("AntigravityInstallation.ensureEligible")(function* () {
        if (!pin && (yield* isWithdrawn(release.version))) {
          return yield* installationError(
            "verify",
            "This Antigravity release was withdrawn. Check for updates and try again.",
          );
        }
      });
      const executable = pin?.executable ?? { name: names.executable, bytes: null };
      const harness = pin?.harness ?? { name: names.harness, bytes: null };
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
      yield* fs.makeDirectory(versionsDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const activate = Effect.fn("AntigravityInstallation.activate")(
        function* (releaseId: string) {
          const pointerDirectory = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: "active.json.",
          });
          const pointerPath = path.join(pointerDirectory, "contents.tmp");
          yield* fs.writeFileString(pointerPath, yield* encodeActiveRelease({ releaseId }), {
            flag: "wx",
            mode: 0o600,
          });
          yield* ensureEligible();
          yield* fs.rename(pointerPath, activePath);
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                ...offer(release.version),
                phase: "succeeded",
                installedVersion: release.version,
                message: null,
              }) satisfies ProviderInstallState,
          );
        },
        Effect.scoped,
        Effect.mapError(
          wrapFailure(
            "activate",
            "Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.",
          ),
        ),
        Effect.uninterruptible,
      );
      const reuse = Effect.fn("AntigravityInstallation.reuse")(function* (releaseId: string) {
        const existing = yield* completedRelease(releaseId);
        if (existing.version !== release.version) {
          return yield* installationError(
            "verify",
            "The existing managed release has the wrong version. Remove it before reinstalling.",
          );
        }
        yield* report("verifying", "Checking the installed runtime.");
        yield* ensureEligible();
        yield* validate(existing, release.version).pipe(
          Effect.scoped,
          Effect.timeout(VALIDATION_TIMEOUT),
        );
        yield* activate(releaseId);
      });

      if (pin && (yield* fs.exists(path.join(versionsDirectory, pin.sha256)))) {
        return yield* reuse(pin.sha256);
      }

      const ensureFreeSpace = Effect.fn("AntigravityInstallation.ensureFreeSpace")(function* (
        operation: string,
        bytes: number,
      ) {
        const available = yield* Effect.tryPromise(() =>
          NodeFSP.statfs(versionsDirectory, { bigint: true }),
        ).pipe(Effect.option);
        const required = bytes + FREE_SPACE_MARGIN;
        if (
          Option.isSome(available) &&
          available.value.bavail * available.value.bsize < BigInt(required)
        ) {
          return yield* installationError(
            operation,
            `Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`,
          );
        }
      });
      // An upstream release has no recorded sizes, so each member is checked
      // against free space once the archive declares it.
      if (pin) {
        yield* ensureFreeSpace(
          "download",
          pin.archiveBytes + pin.executable.bytes + pin.harness.bytes,
        );
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: versionsDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.zip");
      const pairDirectory = path.join(staging, "runtime");
      yield* fs.makeDirectory(pairDirectory);
      const maxArchiveBytes = pin?.archiveBytes ?? UPSTREAM_MAX_ARCHIVE_BYTES;
      const hash = NodeCrypto.createHash("sha256");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        const request = http.execute(HttpClientRequest.get(release.url));
        // Only its URL vouches for an upstream release, so a redirect is
        // refused rather than followed somewhere that check never saw.
        const response = yield* (
          pin
            ? request
            : request.pipe(
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
              )
        ).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        // dl.google.com gzips the zip when the client accepts it, so
        // `content-length` is the encoded size. The decoded stream is still
        // checked against the byte limit and, when pinned, the hash below.
        const contentLength = response.headers["content-length"];
        const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
        const identityBody = contentEncoding === undefined || contentEncoding === "identity";
        if (identityBody && contentLength !== undefined) {
          const declaredBytes = Number(contentLength);
          if (pin && declaredBytes !== pin.archiveBytes) {
            return yield* installationError(
              "download",
              "The Antigravity download size did not match the pinned release.",
            );
          }
          if (!pin && Number.isSafeInteger(declaredBytes) && declaredBytes > 0) {
            if (declaredBytes > maxArchiveBytes) {
              return yield* installationError(
                "download",
                "The Antigravity download is larger than T3 Code accepts.",
              );
            }
            yield* SubscriptionRef.update(state, (current) => ({
              ...current,
              totalBytes: declaredBytes,
            }));
          }
        }
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              downloadedBytes += chunk.byteLength;
              if (downloadedBytes > maxArchiveBytes) {
                return yield* installationError(
                  "download",
                  pin
                    ? "The Antigravity download exceeded the pinned release size."
                    : "The Antigravity download is larger than T3 Code accepts.",
                );
              }
              hash.update(chunk);
              const now = yield* Clock.currentTimeMillis;
              if (now - lastProgressAt >= 250 || downloadedBytes === pin?.archiveBytes) {
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
      }).pipe(Effect.timeout(DOWNLOAD_TIMEOUT));
      const releaseId = hash.digest("hex");
      if (pin && (downloadedBytes !== pin.archiveBytes || releaseId !== pin.sha256)) {
        return yield* installationError(
          "download",
          "The Antigravity download failed its size or SHA-256 check. Nothing was installed.",
        );
      }
      const destination = path.join(versionsDirectory, releaseId);
      if (!pin && (yield* fs.exists(destination))) {
        return yield* reuse(releaseId);
      }

      yield* report("extracting", "Extracting the verified runtime.");
      const extracted = new Map<string, number>();
      let extractedTotal = 0;
      yield* Effect.gen(function* () {
        const archive = yield* openZipArchive(archivePath, (detail, cause) =>
          installationError("extract", detail, cause),
        );
        if (archive.entryCount !== 2) {
          return yield* installationError(
            "extract",
            "The archive must contain exactly the Antigravity executable and its harness.",
          );
        }
        for (;;) {
          const entry = yield* archive.next;
          if (!entry) break;
          const expected = [executable, harness].find((file) => file.name === entry.fileName);
          const expectedBytes = expected?.bytes ?? entry.uncompressedSize;
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            !expected ||
            extracted.has(entry.fileName) ||
            entry.fileName.includes("/") ||
            entry.fileName.includes("\\") ||
            (unixType !== 0 && unixType !== 0o100000) ||
            (entry.externalFileAttributes & 0x10) !== 0 ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, 8].includes(entry.compressionMethod) ||
            entry.uncompressedSize !== expectedBytes ||
            expectedBytes <= 0 ||
            extractedTotal + expectedBytes > UPSTREAM_MAX_EXTRACTED_BYTES
          ) {
            return yield* installationError(
              "extract",
              "The archive contains an unexpected, unsafe, or incorrectly sized member.",
            );
          }
          if (!pin) yield* ensureFreeSpace("extract", expectedBytes);
          extracted.set(entry.fileName, expectedBytes);
          extractedTotal += expectedBytes;
          yield* Effect.gen(function* () {
            const readable = yield* archive.streamEntry(entry);
            let extractedBytes = 0;
            yield* EffectNodeStream.fromReadable<Uint8Array, AntigravityInstallationError>({
              evaluate: () => readable,
              onError: wrapFailure("extract", "Could not extract the Antigravity runtime."),
            }).pipe(
              Stream.tap((chunk) =>
                Effect.gen(function* () {
                  extractedBytes += chunk.byteLength;
                  if (extractedBytes > expectedBytes) {
                    return yield* installationError(
                      "extract",
                      "An archive member exceeded its expected size.",
                    );
                  }
                }),
              ),
              Stream.run(
                fs.sink(path.join(pairDirectory, entry.fileName), { flag: "wx", mode: 0o700 }),
              ),
            );
            if (extractedBytes !== expectedBytes) {
              return yield* installationError("extract", "An archive member was truncated.");
            }
          }).pipe(Effect.scoped);
        }
      }).pipe(Effect.scoped);
      const executableBytes = extracted.get(executable.name);
      const harnessBytes = extracted.get(harness.name);
      if (executableBytes === undefined || harnessBytes === undefined) {
        return yield* installationError(
          "extract",
          "The archive is missing the Antigravity executable or its harness.",
        );
      }
      yield* fs.remove(archivePath);
      if (platform !== "win32") {
        yield* fs.chmod(path.join(pairDirectory, executable.name), 0o755);
        yield* fs.chmod(path.join(pairDirectory, harness.name), 0o755);
      }
      yield* report("verifying", "Checking the downloaded runtime.");
      yield* ensureEligible();
      yield* validate(
        {
          executablePath: path.join(pairDirectory, executable.name),
          harnessPath: path.join(pairDirectory, harness.name),
          source: "managed",
          version: release.version,
          managedVersionDirectory: pairDirectory,
        },
        release.version,
      ).pipe(Effect.scoped, Effect.timeout(VALIDATION_TIMEOUT));
      const record: InstalledRelease = {
        releaseId,
        version: release.version,
        executable: { name: executable.name, bytes: executableBytes },
        harness: { name: harness.name, bytes: harnessBytes },
      };
      yield* fs.writeFileString(
        path.join(pairDirectory, RELEASE_RECORD),
        yield* encodeInstalledRelease(record),
        { flag: "wx", mode: 0o600 },
      );
      yield* fs.rename(pairDirectory, destination).pipe(
        Effect.catch((cause) =>
          completedRelease(releaseId).pipe(
            Effect.flatMap((existing) =>
              existing.version === release.version
                ? ensureEligible().pipe(
                    Effect.andThen(validate(existing, release.version)),
                    Effect.scoped,
                    Effect.timeout(VALIDATION_TIMEOUT),
                  )
                : Effect.fail(
                    installationError(
                      "activate",
                      "Another installation published a different Antigravity release.",
                    ),
                  ),
            ),
            Effect.mapError(() =>
              installationError(
                "activate",
                "Could not publish the Antigravity runtime. The previous release is unchanged. Try again.",
                cause,
              ),
            ),
          ),
        ),
      );
      yield* activate(releaseId);
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Antigravity. Check free disk space and directory access, then try again.",
      ),
    ),
  );

  // Nothing newer is known, so "reinstall" re-checks the active runtime rather
  // than replacing it with an older pinned release.
  const reverify = Effect.fn("AntigravityInstallation.reverify")(
    function* () {
      const active = yield* readRecord(activePath, ActiveRelease);
      const installed = yield* completedRelease(active.releaseId);
      yield* validate(installed, installed.version).pipe(
        Effect.scoped,
        Effect.timeout(VALIDATION_TIMEOUT),
      );
      yield* SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            ...offer(installed.version),
            phase: "succeeded",
            installedVersion: installed.version,
            message: null,
          }) satisfies ProviderInstallState,
      );
    },
    Effect.mapError(
      wrapFailure(
        "verify",
        "The installed Antigravity runtime could not start. Remove it and reinstall.",
      ),
    ),
  );

  const start = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (isRunning(current)) return current;
        const installedVersion = yield* keptInstall(current.installedVersion);
        const release = selectManagedRelease<AntigravityRelease>(
          installedVersion,
          releaseAsset,
          upstream,
        );
        if (!release && installedVersion === null) {
          return yield* installationError(
            "start",
            `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
          );
        }
        const operationId = yield* crypto.randomUUIDv4();
        const next: ProviderInstallState = {
          driver: DRIVER,
          operationId,
          phase: release ? "downloading" : "verifying",
          downloadedBytes: 0,
          ...offer(installedVersion),
          installedVersion: current.installedVersion,
          canRemove: current.canRemove,
          message: release
            ? "Downloading Google's official Antigravity runtime."
            : "Checking the installed runtime.",
        };
        yield* SubscriptionRef.set(state, next);
        const work = (release ? install(release) : reverify()).pipe(
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
    )
    .pipe(Effect.mapError(wrapFailure("start", "Could not start the Antigravity installation.")));

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
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binaryPath of protectedBinaryPaths) {
              if (!binaryPath.trim()) continue;
              const selected = yield* resolve(binaryPath).pipe(Effect.option);
              if (Option.isSome(selected) && selected.value.managedVersionDirectory) {
                return yield* installationError(
                  "remove",
                  "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                );
              }
              const resolved = yield* fs.realPath(binaryPath).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binaryPath));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`)) {
                return yield* installationError(
                  "remove",
                  "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                );
              }
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                ...offer(null),
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
    const canRemove = yield* fs.exists(managedDirectory);
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (!(yield* fs.exists(activePath))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    const installed = yield* completedRelease(active.releaseId);
    const kept = yield* keptInstall(installed.version);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      ...offer(kept),
      installedVersion: installed.version,
    }));
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: "The managed Antigravity runtime is incomplete. Remove it and reinstall.",
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  return AntigravityInstallation.of({
    managedDirectory,
    resolve,
    acquire,
    start,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    checkForUpdate,
    remove,
  });
});
