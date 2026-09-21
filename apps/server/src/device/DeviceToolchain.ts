import type { DeviceToolVersions } from "@t3tools/contracts";
/**
 * Pinned installs of the two external tools device support is built on.
 *
 * `expo-device-hub` streams simulator and emulator screens and `agent-device`
 * drives them. Each is npm-installed separately after its matching consent
 * step into `<baseDir>/tools/<name>/<version>` and executed from there with the
 * resolved Node runtime, never `npx`: an ephemeral
 * npx cache would make every first `device_open` after a reboot depend on the
 * registry, and the pinned versions are part of the contract the injected
 * agent instructions describe.
 *
 * Install follows the pinned-runtime recipe: stage into a temp sibling, write a
 * sentinel only after npm exits 0, then rename into place. npm extracts files
 * before it finishes, so an entry file alone does not prove a usable tree.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

const DEVICE_HUB_PACKAGE = "expo-device-hub";
export const DEVICE_HUB_VERSION = "0.10.1";
const DEVICE_HUB_DUO_BASE_VERSION = "0.9.0";
export const DEVICE_HUB_DUO_COMMIT = "bb265b11c13b395e5302d121458e2d42224a2e9f";
export const DEVICE_HUB_DUO_PATCH =
  "ed67a0803952b7554dae0466125c915850013d9042470d87e3d25cbb9827f01a";
export const DEVICE_HUB_DUO_VERSION = `${DEVICE_HUB_DUO_BASE_VERSION}-duo.${DEVICE_HUB_DUO_COMMIT.slice(0, 12)}.physical.${DEVICE_HUB_DUO_PATCH.slice(0, 8)}`;
const AGENT_DEVICE_PACKAGE = "agent-device";
export const AGENT_DEVICE_VERSION = "0.21.12";

const INSTALL_TIMEOUT = Duration.minutes(10);
const installLock = Semaphore.makeUnsafe(1);

export interface DeviceToolPaths {
  readonly installDir: string;
  /** Absolute path of the tool's entry script, run with a resolved Node runtime. */
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export interface DeviceToolchainPaths {
  readonly hub: DeviceToolPaths;
  readonly agentDevice: DeviceToolPaths;
}

export class DeviceToolchainInstallError extends Schema.TaggedError<DeviceToolchainInstallError>()(
  "DeviceToolchainInstallError",
  {
    tool: Schema.String,
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const suffix = this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`;
    return `Installing ${this.tool} failed while ${this.step}${suffix}.`;
  }
}

interface ToolSpec {
  readonly name: string;
  readonly version: string;
  readonly entry: ReadonlyArray<string>;
  readonly archive?: string;
}

const hubSpec = (): ToolSpec => {
  const archive = process.env.T3CODE_DEVICE_HUB_ARCHIVE;
  return {
    name: DEVICE_HUB_PACKAGE,
    version: archive ? DEVICE_HUB_DUO_VERSION : DEVICE_HUB_VERSION,
    ...(archive ? { archive } : {}),
    entry: ["dist", "server", "cli.mjs"],
  };
};

const AGENT_DEVICE_SPEC: ToolSpec = {
  name: AGENT_DEVICE_PACKAGE,
  version: AGENT_DEVICE_VERSION,
  entry: ["bin", "agent-device.mjs"],
};

const toolPaths = (path: Path.Path, baseDir: string, spec: ToolSpec): DeviceToolPaths => {
  const installDir = path.join(baseDir, "tools", spec.name, spec.version);
  return {
    installDir,
    entryPath: path.join(installDir, "node_modules", spec.name, ...spec.entry),
    sentinelPath: path.join(installDir, ".install-complete"),
  };
};

const deviceToolchainPaths = (
  path: Path.Path,
  baseDir: string,
  hub = hubSpec(),
): DeviceToolchainPaths => ({
  hub: toolPaths(path, baseDir, hub),
  agentDevice: toolPaths(path, baseDir, AGENT_DEVICE_SPEC),
});

/** Keep daemon state (daemon.json, sessions) in userdata, separate from tool installs. */
export const agentDeviceStateDir = (path: Path.Path, stateDir: string): string =>
  path.join(stateDir, "device", "agent-device");

const isInstalled = Effect.fn("DeviceToolchain.isInstalled")(function* (
  fs: FileSystem.FileSystem,
  paths: DeviceToolPaths,
  version: string,
) {
  const [entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(Effect.orElseSucceed(() => [false, Option.none<string>()] as const));
  return entryExists && Option.isSome(sentinel) && sentinel.value.trim() === version;
});

const installTool = Effect.fn("DeviceToolchain.installTool")(function* (
  spec: ToolSpec,
  paths: DeviceToolPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fail = (step: string) => (cause: unknown) =>
    new DeviceToolchainInstallError({ tool: spec.name, step, cause });

  if (spec.archive && !path.isAbsolute(spec.archive))
    return yield* fail("validating the Duo archive path")(
      new Error("An absolute archive path is required"),
    );
  if (yield* isInstalled(fs, paths, spec.version)) return paths;

  const parentDir = path.dirname(paths.installDir);
  yield* fs
    .remove(paths.installDir, { recursive: true, force: true })
    .pipe(Effect.mapError(fail("removing an incomplete install")));
  yield* fs
    .makeDirectory(parentDir, { recursive: true })
    .pipe(Effect.mapError(fail("preparing the install directory")));
  const stagingDir = yield* fs
    .makeTempDirectory({ directory: parentDir, prefix: ".staging-" })
    .pipe(Effect.mapError(fail("preparing the install directory")));

  return yield* Effect.gen(function* () {
    const installArgs = [
      "install",
      "--prefix",
      stagingDir,
      "--no-fund",
      "--no-audit",
      spec.archive ?? `${spec.name}@${spec.version}`,
    ];
    const result = yield* runner
      .run({ command: "npm", args: installArgs, timeout: INSTALL_TIMEOUT })
      .pipe(
        Effect.catchTags({
          ProcessSpawnError: (error) =>
            error.cause instanceof PlatformError.PlatformError &&
            error.cause.reason._tag === "NotFound"
              ? runner.run({
                  command: "pnpm",
                  args: ["--package=npm@11", "dlx", "npm", ...installArgs],
                  timeout: INSTALL_TIMEOUT,
                })
              : Effect.fail(error),
        }),
        Effect.mapError(fail("running npm install")),
      );
    if (result.code !== 0) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "running npm install",
        exitCode: Number(result.code),
        cause: result,
      });
    }
    const stagedEntry = path.join(stagingDir, "node_modules", spec.name, ...spec.entry);
    if (!(yield* fs.exists(stagedEntry).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "verifying the installed entry point",
      });
    }
    if (spec.archive) {
      const manifest = yield* fs
        .readFileString(path.join(stagingDir, "node_modules", spec.name, "package.json"))
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Struct({
                  version: Schema.Literal(DEVICE_HUB_DUO_VERSION),
                  t3DeviceHubBuild: Schema.Struct({
                    serveSimCommit: Schema.Literal(DEVICE_HUB_DUO_COMMIT),
                    physicalOrientationPatchSha256: Schema.Literal(DEVICE_HUB_DUO_PATCH),
                  }),
                }),
              ),
            ),
          ),
          Effect.mapError(fail("verifying the pinned Duo build")),
        );
      if (manifest.version !== spec.version)
        return yield* fail("verifying the pinned Duo build")(manifest);
    }
    yield* fs
      .writeFileString(path.join(stagingDir, ".install-complete"), `${spec.version}\n`)
      .pipe(Effect.mapError(fail("recording the completed install")));
    yield* fs.rename(stagingDir, paths.installDir).pipe(
      Effect.catch((cause) =>
        // A concurrent server may have published the same version first.
        isInstalled(fs, paths, spec.version).pipe(
          Effect.flatMap((published) =>
            published ? Effect.void : Effect.fail(fail("publishing the install")(cause)),
          ),
        ),
      ),
    );
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

const ensureTool = Effect.fn("DeviceToolchain.ensureTool")(function* (
  baseDir: string,
  spec: ToolSpec,
  select: (paths: DeviceToolchainPaths) => DeviceToolPaths,
) {
  const path = yield* Path.Path;
  const paths = deviceToolchainPaths(
    path,
    baseDir,
    spec.name === DEVICE_HUB_PACKAGE ? spec : hubSpec(),
  );
  return yield* installLock.withPermit(installTool(spec, select(paths)));
});

export const ensureDeviceHub = (baseDir: string) =>
  ensureTool(baseDir, hubSpec(), (paths) => paths.hub);

export const ensureAgentDevice = (baseDir: string) =>
  ensureTool(baseDir, AGENT_DEVICE_SPEC, (paths) => paths.agentDevice);

const isToolInstalled = Effect.fn("DeviceToolchain.isToolInstalled")(function* (
  baseDir: string,
  spec: ToolSpec,
  select: (paths: DeviceToolchainPaths) => DeviceToolPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = deviceToolchainPaths(
    path,
    baseDir,
    spec.name === DEVICE_HUB_PACKAGE ? spec : hubSpec(),
  );
  return yield* isInstalled(fs, select(paths), spec.version);
});

export const isDeviceHubInstalled = (baseDir: string) =>
  isToolInstalled(baseDir, hubSpec(), (paths) => paths.hub);

export const isAgentDeviceInstalled = (baseDir: string) =>
  isToolInstalled(baseDir, AGENT_DEVICE_SPEC, (paths) => paths.agentDevice);

/** Read completed installs without downloading or starting either tool. */
export const deviceToolVersions = Effect.fn("DeviceToolchain.versions")(function* (
  baseDir: string,
  running: { hub?: string; agent?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspect = Effect.fn("DeviceToolchain.inspect")(function* (spec: ToolSpec) {
    const directory = path.join(baseDir, "tools", spec.name);
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    const versions = yield* Effect.filter(names, (version) =>
      /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
        ? Effect.gen(function* () {
            const paths = toolPaths(path, baseDir, { ...spec, version });
            const sentinel = yield* fs.readFileString(paths.sentinelPath).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(null),
              ),
            );
            return sentinel?.trim() === version && (yield* fs.exists(paths.entryPath));
          })
        : Effect.succeed(false),
    );
    return {
      requiredVersion: spec.version,
      installedVersions: versions.sort(),
      runningVersion: (spec.name === DEVICE_HUB_PACKAGE ? running.hub : running.agent) ?? null,
    };
  });
  return yield* Effect.gen(function* () {
    return {
      hub: yield* inspect(hubSpec()),
      agent: yield* inspect(AGENT_DEVICE_SPEC),
    } satisfies DeviceToolVersions;
  }).pipe(Effect.orElseSucceed(() => undefined));
});
