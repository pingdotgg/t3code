import type { DeviceToolVersions } from "@t3tools/contracts";
// npm exposes entry files before extraction completes; their presence does not prove a usable tree.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import DEVICE_TOOL_VERSIONS from "./deviceToolVersions.json" with { type: "json" };

const DEVICE_HUB_PACKAGE = "expo-device-hub";
export const DEVICE_HUB_VERSION = DEVICE_TOOL_VERSIONS[DEVICE_HUB_PACKAGE];
const AGENT_DEVICE_PACKAGE = "agent-device";
export const AGENT_DEVICE_VERSION = DEVICE_TOOL_VERSIONS[AGENT_DEVICE_PACKAGE];

const INSTALL_TIMEOUT = Duration.minutes(10);
const installLock = Semaphore.makeUnsafe(1);

export interface DeviceToolPaths {
  readonly installDir: string;
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
}

const HUB_SPEC: ToolSpec = {
  name: DEVICE_HUB_PACKAGE,
  version: DEVICE_HUB_VERSION,
  entry: ["dist", "server", "cli.mjs"],
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

const deviceToolchainPaths = (path: Path.Path, baseDir: string): DeviceToolchainPaths => ({
  hub: toolPaths(path, baseDir, HUB_SPEC),
  agentDevice: toolPaths(path, baseDir, AGENT_DEVICE_SPEC),
});

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
      `${spec.name}@${spec.version}`,
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
    yield* fs
      .writeFileString(path.join(stagingDir, ".install-complete"), `${spec.version}\n`)
      .pipe(Effect.mapError(fail("recording the completed install")));
    yield* fs
      .rename(stagingDir, paths.installDir)
      .pipe(
        Effect.catch((cause) =>
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
  const paths = deviceToolchainPaths(path, baseDir);
  return yield* installLock.withPermit(installTool(spec, select(paths)));
});

export const ensureDeviceHub = (baseDir: string) =>
  ensureTool(baseDir, HUB_SPEC, (paths) => paths.hub);

export const ensureAgentDevice = (baseDir: string) =>
  ensureTool(baseDir, AGENT_DEVICE_SPEC, (paths) => paths.agentDevice);

const isToolInstalled = Effect.fn("DeviceToolchain.isToolInstalled")(function* (
  baseDir: string,
  spec: ToolSpec,
  select: (paths: DeviceToolchainPaths) => DeviceToolPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = deviceToolchainPaths(path, baseDir);
  return yield* isInstalled(fs, select(paths), spec.version);
});

export const isDeviceHubInstalled = (baseDir: string) =>
  isToolInstalled(baseDir, HUB_SPEC, (paths) => paths.hub);

export const isAgentDeviceInstalled = (baseDir: string) =>
  isToolInstalled(baseDir, AGENT_DEVICE_SPEC, (paths) => paths.agentDevice);

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
      hub: yield* inspect(HUB_SPEC),
      agent: yield* inspect(AGENT_DEVICE_SPEC),
    } satisfies DeviceToolVersions;
  }).pipe(Effect.orElseSucceed(() => undefined));
});
