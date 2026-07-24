import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  BOOT_SERVICE_UNIT_ENV,
  BOOT_SERVICE_UNIT_FILE,
  renderBootServiceUnit,
  renderS6RunScript,
  S6_SERVICE_DIR_ENV,
  SERVICE_SUPERVISOR_ENV,
  type ServiceSupervisor,
} from "./bootService.ts";
import { serviceUpdateCoordinator } from "./serviceUpdateCoordinator.ts";

const POLL_INTERVAL = Duration.minutes(15);
const DRAIN_POLL_INTERVAL = Duration.seconds(1);
const PREFLIGHT_TIMEOUT = Duration.seconds(30);
const GITHUB_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export class ServiceAutoUpdateError extends Schema.TaggedErrorClass<ServiceAutoUpdateError>()(
  "ServiceAutoUpdateError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly browserDownloadUrl: string;
}

export interface GitHubRelease {
  readonly version: string;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

export interface ServiceUpdateCandidate {
  readonly version: string;
  readonly binaryUrl: string;
  readonly checksumUrl: string;
  readonly assetName: string;
}

export interface ManagedService {
  readonly supervisor: ServiceSupervisor;
  readonly definitionPath: string;
  readonly serviceDir?: string;
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepository | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) {
      return null;
    }
    const segments = url.pathname.replace(/\/+$/u, "").split("/").filter(Boolean);
    if (segments.length !== 2) return null;
    const [owner, rawRepo] = segments;
    const repo = rawRepo?.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
    if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
      return null;
    }
    return { owner, repo };
  } catch {
    return null;
  }
}

function parseVersion(version: string): ReadonlyArray<number | string> | null {
  const match = GITHUB_VERSION_PATTERN.exec(version);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    ...(match[4]?.split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part)) ?? []),
  ];
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return 0;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index];
    const bv = b[index];
    // f8y treats the suffix as a build iteration layered on top of the
    // upstream numeric version, not as a SemVer prerelease. This deliberately
    // makes 0.0.28-f8y.<build> newer than the unsuffixed upstream 0.0.28.
    if (av === undefined) return typeof bv === "undefined" ? 0 : -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av < bv ? -1 : 1;
    if (typeof av === "number") return -1;
    if (typeof bv === "number") return 1;
    return av.localeCompare(bv);
  }
  return 0;
}

export function resolveServiceUpdateCandidate(input: {
  readonly currentVersion: string;
  readonly platformAsset: "darwin-arm64" | "linux-x64";
  readonly releases: ReadonlyArray<GitHubRelease>;
}): ServiceUpdateCandidate | null {
  for (const release of input.releases) {
    if (compareVersions(release.version, input.currentVersion) <= 0) continue;
    const assetName = `t3-${release.version}-${input.platformAsset}`;
    const binary = release.assets.find((asset) => asset.name === assetName);
    const checksum = release.assets.find((asset) => asset.name === `${assetName}.sha256`);
    if (binary && checksum) {
      return {
        version: release.version,
        assetName,
        binaryUrl: binary.browserDownloadUrl,
        checksumUrl: checksum.browserDownloadUrl,
      };
    }
  }
  return null;
}

function decodeGitHubReleases(value: unknown): ReadonlyArray<GitHubRelease> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((release): ReadonlyArray<GitHubRelease> => {
    if (
      typeof release !== "object" ||
      release === null ||
      release["draft"] === true ||
      typeof release["tag_name"] !== "string" ||
      !Array.isArray(release["assets"])
    ) {
      return [];
    }
    const version = release["tag_name"].replace(/^v/u, "");
    if (parseVersion(version) === null) return [];
    const assets = release["assets"].flatMap(
      (asset): ReadonlyArray<GitHubReleaseAsset> =>
        typeof asset === "object" &&
        asset !== null &&
        typeof asset["name"] === "string" &&
        typeof asset["browser_download_url"] === "string"
          ? [{ name: asset["name"], browserDownloadUrl: asset["browser_download_url"] }]
          : [],
    );
    return [{ version, assets }];
  });
}

export function resolveManagedService(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly path: Path.Path;
}): ManagedService | null {
  const declaredSupervisor = input.env[SERVICE_SUPERVISOR_ENV];
  if (
    declaredSupervisor === "s6" &&
    input.env[S6_SERVICE_DIR_ENV] &&
    input.path.isAbsolute(input.env[S6_SERVICE_DIR_ENV])
  ) {
    const serviceDir = input.env[S6_SERVICE_DIR_ENV];
    return {
      supervisor: "s6",
      serviceDir,
      definitionPath: input.path.join(serviceDir, "run"),
    };
  }
  if (
    declaredSupervisor === "systemd" ||
    (input.env.INVOCATION_ID && input.env[BOOT_SERVICE_UNIT_ENV] === BOOT_SERVICE_UNIT_FILE)
  ) {
    if (input.homeDir === "") return null;
    return {
      supervisor: "systemd",
      definitionPath: input.path.join(
        input.homeDir,
        ".config",
        "systemd",
        "user",
        BOOT_SERVICE_UNIT_FILE,
      ),
    };
  }
  return null;
}

export const pruneSupersededStagedBinaries = Effect.fn(
  "cloud.service_auto_update.prune_staged_binaries",
)(function* (input: { readonly repositoryRuntimeDir: string; readonly currentVersion: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(input.repositoryRuntimeDir)
    .pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    entries.filter((entry) => entry !== input.currentVersion && parseVersion(entry) !== null),
    (entry) =>
      fs.remove(path.join(input.repositoryRuntimeDir, entry), {
        recursive: true,
        force: true,
      }),
    { discard: true },
  );
});

const request = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    },
    catch: (cause) => new ServiceAutoUpdateError({ message: `Request failed: ${url}`, cause }),
  });

const sha256Hex = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
    catch: (cause) =>
      new ServiceAutoUpdateError({ message: "Could not hash the downloaded update.", cause }),
  });

export class ServiceAutoUpdate extends Context.Service<
  ServiceAutoUpdate,
  {
    readonly checkNow: Effect.Effect<void, ServiceAutoUpdateError>;
  }
>()("t3/cloud/ServiceAutoUpdate") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerService = yield* ProviderService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const coordinator = serviceUpdateCoordinator;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const managedService = resolveManagedService({
    env,
    homeDir: env.HOME ?? "",
    path,
  });
  const platformAsset =
    platform === "linux" && architecture === "x64"
      ? ("linux-x64" as const)
      : platform === "darwin" && architecture === "arm64"
        ? ("darwin-arm64" as const)
        : null;

  const fail = (message: string, cause?: unknown) =>
    cause === undefined
      ? new ServiceAutoUpdateError({ message })
      : new ServiceAutoUpdateError({ message, cause });

  const writeDefinition = (definitionPath: string, contents: string) =>
    writeFileStringAtomically({ filePath: definitionPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const runSupervisor = Effect.fn("cloud.service_auto_update.supervisor")(function* (
    command: string,
    args: ReadonlyArray<string>,
    description: string,
  ) {
    const result = yield* runner
      .run({ command, args })
      .pipe(Effect.mapError((cause) => fail(`Could not ${description}.`, cause)));
    if (result.code !== 0) {
      return yield* fail(`Could not ${description} (exit code ${String(result.code)}).`);
    }
  });

  const waitForNoActiveTasks: Effect.Effect<void> = Effect.suspend(() =>
    providerService
      .listSessions()
      .pipe(
        Effect.flatMap((sessions) =>
          sessions.some(
            (session) =>
              session.status === "connecting" ||
              session.status === "running" ||
              session.activeTurnId !== undefined,
          )
            ? Effect.sleep(DRAIN_POLL_INTERVAL).pipe(Effect.andThen(waitForNoActiveTasks))
            : Effect.void,
        ),
      ),
  );

  const checkNow: ServiceAutoUpdate["Service"]["checkNow"] = Effect.gen(function* () {
    if (managedService === null || platformAsset === null) return;
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => fail("Could not read service update settings.", cause)),
    );
    const repository = parseGitHubRepositoryUrl(currentSettings.serviceUpdateRepository);
    if (repository === null) return;
    const repositoryRuntimeDir = path.join(
      config.baseDir,
      "runtime",
      "github",
      repository.owner,
      repository.repo,
    );
    yield* pruneSupersededStagedBinaries({
      repositoryRuntimeDir,
      currentVersion: packageJson.version,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not prune superseded staged service binaries.", {
          repositoryRuntimeDir,
          cause,
        }),
      ),
    );

    const releasesResponse = yield* request(
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases?per_page=30`,
      { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } },
    );
    const releasesJson = yield* Effect.tryPromise({
      try: () => releasesResponse.json(),
      catch: (cause) => fail("Could not decode GitHub releases.", cause),
    });
    const candidate = resolveServiceUpdateCandidate({
      currentVersion: packageJson.version,
      platformAsset,
      releases: decodeGitHubReleases(releasesJson),
    });
    if (candidate === null) return;

    const versionDir = path.join(repositoryRuntimeDir, candidate.version);
    const stagedBinary = path.join(versionDir, "t3");
    const [binaryResponse, checksumResponse] = yield* Effect.all(
      [request(candidate.binaryUrl), request(candidate.checksumUrl)],
      { concurrency: 2 },
    );
    const [binaryBuffer, checksumText] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () => binaryResponse.arrayBuffer(),
          catch: (cause) => fail("Could not read the downloaded update.", cause),
        }),
        Effect.tryPromise({
          try: () => checksumResponse.text(),
          catch: (cause) => fail("Could not read the update checksum.", cause),
        }),
      ],
      { concurrency: 2 },
    );
    const binaryBytes = new Uint8Array(binaryBuffer);
    const expectedChecksum = checksumText.trim().split(/\s+/u)[0]?.toLowerCase();
    const actualChecksum = yield* sha256Hex(binaryBytes);
    if (!expectedChecksum || !/^[0-9a-f]{64}$/u.test(expectedChecksum)) {
      return yield* fail("The release checksum file is invalid.");
    }
    if (actualChecksum !== expectedChecksum) {
      return yield* fail("The downloaded update did not match its SHA-256 checksum.");
    }

    yield* fs.makeDirectory(versionDir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFile(stagedBinary, binaryBytes)),
      Effect.andThen(fs.chmod(stagedBinary, 0o755)),
      Effect.mapError((cause) => fail("Could not stage the downloaded update.", cause)),
    );
    const preflight = yield* runner
      .run({ command: stagedBinary, args: ["--version"], timeout: PREFLIGHT_TIMEOUT })
      .pipe(Effect.mapError((cause) => fail("Could not run the staged update.", cause)));
    if (preflight.code !== 0 || preflight.stdout.trim() !== `t3 v${candidate.version}`) {
      return yield* fail("The staged update failed its version preflight.");
    }

    yield* Effect.gen(function* () {
      yield* coordinator.beginDrain;
      yield* providerCommandReactor.drain;
      yield* Effect.logInfo("T3 Code service update pending; waiting for active tasks.", {
        targetVersion: candidate.version,
      });
      yield* waitForNoActiveTasks;

      yield* coordinator.withActivationHandoff(
        Effect.gen(function* () {
          yield* providerCommandReactor.drain;
          const previousDefinition = yield* fs
            .readFileString(managedService.definitionPath)
            .pipe(
              Effect.mapError((cause) => fail("Could not read the service definition.", cause)),
            );
          const plan = {
            supervisor: managedService.supervisor,
            nodePath: stagedBinary,
            t3EntryPath: "",
            baseDir: config.baseDir,
            logPath: path.join(config.logsDir, "boot-service.log"),
            unitPath: managedService.definitionPath,
          } as const;
          const nextDefinition =
            managedService.supervisor === "systemd"
              ? renderBootServiceUnit(plan)
              : renderS6RunScript(plan);

          yield* writeDefinition(managedService.definitionPath, nextDefinition).pipe(
            Effect.andThen(
              managedService.supervisor === "s6"
                ? fs.chmod(managedService.definitionPath, 0o755)
                : Effect.void,
            ),
            Effect.mapError((cause) =>
              fail("Could not activate the staged service definition.", cause),
            ),
          );

          const activate =
            managedService.supervisor === "systemd"
              ? runSupervisor("systemctl", ["--user", "daemon-reload"], "reload systemd").pipe(
                  Effect.andThen(
                    runSupervisor(
                      "systemctl",
                      ["--user", "restart", BOOT_SERVICE_UNIT_FILE],
                      "restart the systemd service",
                    ),
                  ),
                )
              : runSupervisor(
                  "s6-svc",
                  ["-r", managedService.serviceDir ?? path.dirname(managedService.definitionPath)],
                  "restart the s6 service",
                );
          yield* activate.pipe(
            Effect.catch((activationError) =>
              writeDefinition(managedService.definitionPath, previousDefinition).pipe(
                Effect.mapError((cause) =>
                  fail("Could not restore the previous service definition.", cause),
                ),
                Effect.andThen(
                  managedService.supervisor === "systemd"
                    ? runSupervisor("systemctl", ["--user", "daemon-reload"], "restore systemd")
                    : fs
                        .chmod(managedService.definitionPath, 0o755)
                        .pipe(
                          Effect.mapError((cause) =>
                            fail("Could not restore the s6 service definition.", cause),
                          ),
                        ),
                ),
                Effect.andThen(Effect.fail(activationError)),
              ),
            ),
          );
        }),
      );
    }).pipe(
      Effect.onError(() =>
        coordinator.cancelDrain.pipe(Effect.andThen(providerCommandReactor.replayPendingStarts)),
      ),
    );
  });

  yield* checkNow.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Automatic T3 Code service update check failed.", {
        detail: error.message,
      }),
    ),
    Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
    Effect.forkScoped,
  );

  return ServiceAutoUpdate.of({ checkNow });
});

export const layer = Layer.effect(ServiceAutoUpdate, make);
