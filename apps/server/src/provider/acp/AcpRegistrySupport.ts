import {
  type AcpRegistryDistributionPreference,
  type AcpRegistrySettings,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

const AcpRegistryPackageDistribution = Schema.Struct({
  package: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const AcpRegistryBinaryTarget = Schema.Struct({
  archive: Schema.String,
  cmd: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const AcpRegistryAgent = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  distribution: Schema.Struct({
    binary: Schema.optionalKey(Schema.Record(Schema.String, AcpRegistryBinaryTarget)),
    npx: Schema.optionalKey(AcpRegistryPackageDistribution),
    uvx: Schema.optionalKey(AcpRegistryPackageDistribution),
  }),
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;

const AcpRegistryIndex = Schema.Struct({
  version: Schema.String,
  agents: Schema.Array(AcpRegistryAgent),
});
export type AcpRegistryIndex = typeof AcpRegistryIndex.Type;

const decodeRegistryIndex = Schema.decodeUnknownEffect(AcpRegistryIndex);
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

export const AcpRegistryErrorReason = Schema.Literals([
  "agent_not_configured",
  "agent_not_found",
  "archive_invalid",
  "download_failed",
  "install_failed",
  "registry_unavailable",
  "unsupported_distribution",
  "unsupported_platform",
]);
export type AcpRegistryErrorReason = typeof AcpRegistryErrorReason.Type;

export class AcpRegistryError extends Schema.TaggedErrorClass<AcpRegistryError>()(
  "AcpRegistryError",
  {
    reason: AcpRegistryErrorReason,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isAcpRegistryError = Schema.is(AcpRegistryError);

export type AcpRegistryPlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export function resolveAcpRegistryPlatformTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): AcpRegistryPlatformTarget | undefined {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
  return os && arch ? (`${os}-${arch}` as AcpRegistryPlatformTarget) : undefined;
}

export type AcpRegistryDistributionKind = "binary" | "npx" | "uvx";

export interface ResolvedAcpRegistryDistribution {
  readonly kind: AcpRegistryDistributionKind;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly binaryTarget?: typeof AcpRegistryBinaryTarget.Type;
  readonly packageName?: string;
}

export function resolveAcpRegistryDistribution(input: {
  readonly agent: AcpRegistryAgent;
  readonly preference: AcpRegistryDistributionPreference;
  readonly platformTarget: AcpRegistryPlatformTarget | undefined;
}): ResolvedAcpRegistryDistribution | undefined {
  const { agent, platformTarget } = input;
  const binary = platformTarget ? agent.distribution.binary?.[platformTarget] : undefined;
  const candidates: ReadonlyArray<AcpRegistryDistributionKind> =
    input.preference === "auto" ? ["binary", "npx", "uvx"] : [input.preference];

  for (const kind of candidates) {
    if (kind === "binary" && binary) {
      return {
        kind,
        args: binary.args ?? [],
        env: binary.env ?? {},
        binaryTarget: binary,
      };
    }
    if (kind === "npx" && agent.distribution.npx) {
      return {
        kind,
        args: agent.distribution.npx.args ?? [],
        env: agent.distribution.npx.env ?? {},
        packageName: agent.distribution.npx.package,
      };
    }
    if (kind === "uvx" && agent.distribution.uvx) {
      return {
        kind,
        args: agent.distribution.uvx.args ?? [],
        env: agent.distribution.uvx.env ?? {},
        packageName: agent.distribution.uvx.package,
      };
    }
  }
  return undefined;
}

export interface ResolvedAcpRegistryAgent {
  readonly agent: AcpRegistryAgent;
  readonly distribution: AcpRegistryDistributionKind;
  readonly spawn: AcpSpawnInput;
}

export interface AcpRegistryResolverShape {
  readonly resolve: (
    settings: AcpRegistrySettings,
    cwd: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError>;
}

const INSTALL_LOCK_RETRY_COUNT = 300;
const INSTALL_LOCK_RETRY_DELAY = "100 millis";
const INSTALL_LOCK_STALE_MS = 5 * 60 * 1_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function isAlreadyExists(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "AlreadyExists";
}

function normalizeRegistryCommandPath(command: string): ReadonlyArray<string> | undefined {
  const normalized = command.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments;
}

function validateArchiveEntries(output: string): boolean {
  return output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .every((entry) => normalizeRegistryCommandPath(entry) !== undefined);
}

type ArchiveKind = "raw" | "tar_bz2" | "tar_gz" | "zip";

function archiveKind(url: string): ArchiveKind {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar_gz";
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar_bz2";
  if (pathname.endsWith(".zip")) return "zip";
  return "raw";
}

function archiveFileName(kind: ArchiveKind): string {
  switch (kind) {
    case "tar_gz":
      return "agent.tar.gz";
    case "tar_bz2":
      return "agent.tar.bz2";
    case "zip":
      return "agent.zip";
    case "raw":
      return "agent.bin";
  }
}

export const makeAcpRegistryResolver = Effect.fn("AcpRegistryResolver.make")(function* (input: {
  readonly cacheDir: string;
  readonly registryUrl?: string;
}): Effect.fn.Return<
  AcpRegistryResolverShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const platformTarget = resolveAcpRegistryPlatformTarget(platform, architecture);
  const registryUrl = input.registryUrl ?? ACP_REGISTRY_URL;
  const registryDirectory = path.join(input.cacheDir, "acp-registry");
  const registryCachePath = path.join(registryDirectory, "registry.json");
  const installsDirectory = path.join(registryDirectory, "agents");
  const registryRef = yield* Ref.make<AcpRegistryIndex | undefined>(undefined);
  const registrySemaphore = yield* Semaphore.make(1);
  const installSemaphore = yield* Semaphore.make(1);

  const decodeRegistryText = Effect.fn("AcpRegistryResolver.decodeRegistryText")(function* (
    text: string,
  ) {
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned invalid JSON.",
            cause,
          }),
      ),
    );
    return yield* decodeRegistryIndex(decoded).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "ACP Registry returned an invalid index.",
            cause,
          }),
      ),
    );
  });

  const readCachedRegistry = fileSystem
    .readFileString(registryCachePath)
    .pipe(Effect.flatMap(decodeRegistryText), Effect.option);

  const writeRegistryCache = (text: string) =>
    fileSystem
      .makeDirectory(registryDirectory, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(`${registryCachePath}.${process.pid}.tmp`, text)),
        Effect.andThen(
          fileSystem.rename(`${registryCachePath}.${process.pid}.tmp`, registryCachePath),
        ),
        Effect.ignore,
      );

  const fetchRegistry = Effect.gen(function* () {
    const response = yield* httpClient.execute(HttpClientRequest.get(registryUrl)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: `Could not fetch ACP Registry index from ${registryUrl}.`,
            cause,
          }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "registry_unavailable",
            detail: "Could not read ACP Registry response body.",
            cause,
          }),
      ),
    );
    const registry = yield* decodeRegistryText(text);
    yield* writeRegistryCache(text);
    return registry;
  });

  const loadRegistry = registrySemaphore.withPermits(1)(
    Effect.gen(function* () {
      const memoized = yield* Ref.get(registryRef);
      if (memoized !== undefined) return memoized;
      const registry = yield* fetchRegistry.pipe(
        Effect.catch((networkError) =>
          readCachedRegistry.pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(networkError),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),
      );
      yield* Ref.set(registryRef, registry);
      return registry;
    }),
  );

  const runCommand = Effect.fn("AcpRegistryResolver.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd?: string,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        ...(cwd ? { cwd } : {}),
        shell: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout }),
        collectUint8StreamText({ stream: child.stderr }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: `ACP Registry install command '${command}' exited with code ${Number(exitCode)}: ${stderr.text.trim()}`,
      });
    }
    return stdout.text;
  });

  const acquireInstallLock = Effect.fn("AcpRegistryResolver.acquireInstallLock")(function* (
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
    return yield* new AcpRegistryError({
      reason: "install_failed",
      detail: `Timed out waiting for ACP Registry install lock ${lockPath}.`,
    });
  });

  const assertExecutableInRoot = Effect.fn("AcpRegistryResolver.assertExecutableInRoot")(function* (
    root: string,
    executablePath: string,
  ) {
    const rootRealPath = yield* fileSystem.realPath(root);
    const executableRealPath = yield* fileSystem.realPath(executablePath);
    const relative = path.relative(rootRealPath, executableRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command resolves outside its installation directory.",
      });
    }
    return executableRealPath;
  });

  const installBinary = Effect.fn("AcpRegistryResolver.installBinary")(function* (
    agent: AcpRegistryAgent,
    target: typeof AcpRegistryBinaryTarget.Type,
  ) {
    if (platformTarget === undefined) {
      return yield* new AcpRegistryError({
        reason: "unsupported_platform",
        detail: `ACP Registry does not support platform ${platform}-${architecture}.`,
      });
    }
    const commandSegments = normalizeRegistryCommandPath(target.cmd);
    if (commandSegments === undefined) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: `ACP Registry agent ${agent.id} declares an unsafe command path '${target.cmd}'.`,
      });
    }
    const installRoot = path.join(installsDirectory, agent.id, agent.version, platformTarget);
    const executablePath = path.join(installRoot, ...commandSegments);
    if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
      return yield* assertExecutableInRoot(installRoot, executablePath).pipe(
        Effect.mapError((cause) =>
          isAcpRegistryError(cause)
            ? cause
            : new AcpRegistryError({
                reason: "install_failed",
                detail: `Could not validate cached ACP Registry agent ${agent.id}.`,
                cause,
              }),
        ),
      );
    }

    yield* fileSystem.makeDirectory(path.dirname(installRoot), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not create ACP Registry cache for ${agent.id}.`,
            cause,
          }),
      ),
    );
    const lockPath = `${installRoot}.lock`;
    yield* acquireInstallLock(lockPath).pipe(
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not acquire install lock for ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );

    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
        return yield* assertExecutableInRoot(installRoot, executablePath);
      }
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(installRoot),
        prefix: `.${agent.id}-install-`,
      });
      const extractionRoot = path.join(temporaryRoot, "extracted");
      yield* fileSystem.makeDirectory(extractionRoot, { recursive: true });
      const kind = archiveKind(target.archive);
      const archivePath = path.join(temporaryRoot, archiveFileName(kind));
      const response = yield* httpClient.execute(HttpClientRequest.get(target.archive)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(
          (cause) =>
            new AcpRegistryError({
              reason: "download_failed",
              detail: `Could not download ACP Registry agent ${agent.id} ${agent.version}.`,
              cause,
            }),
        ),
      );
      const bytes = new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError(
            (cause) =>
              new AcpRegistryError({
                reason: "download_failed",
                detail: `Could not read ACP Registry agent ${agent.id} download.`,
                cause,
              }),
          ),
        ),
      );
      if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
        return yield* new AcpRegistryError({
          reason: "archive_invalid",
          detail: `ACP Registry agent ${agent.id} archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`,
        });
      }
      yield* fileSystem.writeFile(archivePath, bytes);

      if (kind === "raw") {
        const targetPath = path.join(extractionRoot, ...commandSegments);
        yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
        yield* fileSystem.rename(archivePath, targetPath);
      } else {
        const listArgs =
          kind === "tar_gz"
            ? ["-tzf", archivePath]
            : kind === "tar_bz2"
              ? ["-tjf", archivePath]
              : platform === "win32"
                ? ["-tf", archivePath]
                : undefined;
        const entries =
          listArgs === undefined
            ? yield* runCommand("unzip", ["-Z1", archivePath])
            : yield* runCommand("tar", listArgs);
        if (!validateArchiveEntries(entries)) {
          return yield* new AcpRegistryError({
            reason: "archive_invalid",
            detail: `ACP Registry agent ${agent.id} archive contains an unsafe path.`,
          });
        }
        if (kind === "zip" && platform !== "win32") {
          yield* runCommand("unzip", ["-q", archivePath, "-d", extractionRoot]);
        } else {
          const extractFlag = kind === "tar_gz" ? "-xzf" : kind === "tar_bz2" ? "-xjf" : "-xf";
          yield* runCommand("tar", [extractFlag, archivePath, "-C", extractionRoot]);
        }
      }

      const stagedExecutable = path.join(extractionRoot, ...commandSegments);
      if (!(yield* fileSystem.exists(stagedExecutable).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new AcpRegistryError({
          reason: "archive_invalid",
          detail: `ACP Registry archive for ${agent.id} did not contain '${target.cmd}'.`,
        });
      }
      if (platform !== "win32") yield* fileSystem.chmod(stagedExecutable, 0o755);
      yield* assertExecutableInRoot(extractionRoot, stagedExecutable);
      yield* fileSystem.remove(installRoot, { recursive: true, force: true });
      yield* fileSystem.rename(extractionRoot, installRoot);
      return yield* assertExecutableInRoot(installRoot, executablePath);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not install ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );
  });

  const resolve: AcpRegistryResolverShape["resolve"] = (settings, cwd, environment) =>
    Effect.gen(function* () {
      const agentId = settings.agentId.trim();
      if (agentId.length === 0) {
        return yield* new AcpRegistryError({
          reason: "agent_not_configured",
          detail: "ACP Registry provider requires a registry agent ID.",
        });
      }
      const registry = yield* loadRegistry;
      const agent = registry.agents.find((candidate) => candidate.id === agentId);
      if (agent === undefined) {
        return yield* new AcpRegistryError({
          reason: "agent_not_found",
          detail: `ACP Registry does not contain agent '${agentId}'.`,
        });
      }
      const distribution = resolveAcpRegistryDistribution({
        agent,
        preference: settings.distribution,
        platformTarget,
      });
      if (distribution === undefined) {
        return yield* new AcpRegistryError({
          reason:
            platformTarget === undefined ? "unsupported_platform" : "unsupported_distribution",
          detail: `ACP Registry agent ${agent.id} has no ${settings.distribution === "auto" ? "compatible" : settings.distribution} distribution for ${platform}-${architecture}.`,
        });
      }

      let command: string;
      let args: ReadonlyArray<string>;
      const commandOverride = settings.commandPath.trim();
      if (commandOverride.length > 0) {
        command = commandOverride;
        args = distribution.args;
      } else if (distribution.kind === "npx") {
        command = "npx";
        args = ["--yes", distribution.packageName!, ...distribution.args];
      } else if (distribution.kind === "uvx") {
        command = "uvx";
        args = [distribution.packageName!, ...distribution.args];
      } else {
        command = yield* installSemaphore.withPermits(1)(
          installBinary(agent, distribution.binaryTarget!),
        );
        args = distribution.args;
      }

      return {
        agent,
        distribution: distribution.kind,
        spawn: {
          command,
          args,
          cwd,
          env: {
            ...environment,
            ...distribution.env,
          },
        },
      } satisfies ResolvedAcpRegistryAgent;
    });

  return { resolve };
});
