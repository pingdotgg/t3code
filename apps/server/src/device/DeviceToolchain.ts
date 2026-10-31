import type { DeviceToolVersions } from "@t3tools/contracts";
/**
 * Pinned installs of `expo-device-hub` and `agent-device` under `<baseDir>/tools/<name>/<version>`,
 * counted only with both the entry file and a sentinel naming the version.
 * [fork:lockdown] Upstream npm-installs each tool after its consent step; see `installTool`.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import DEVICE_TOOL_VERSIONS from "./deviceToolVersions.json" with { type: "json" };

const DEVICE_HUB_PACKAGE = "expo-device-hub";
export const DEVICE_HUB_VERSION = DEVICE_TOOL_VERSIONS[DEVICE_HUB_PACKAGE];
const AGENT_DEVICE_PACKAGE = "agent-device";
export const AGENT_DEVICE_VERSION = DEVICE_TOOL_VERSIONS[AGENT_DEVICE_PACKAGE];

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
  if (yield* isInstalled(fs, paths, spec.version)) return paths;
  // [fork:lockdown] Upstream npm-installs the pinned tool here, resolving its
  // whole dependency tree from the registry at install time. This fork never
  // runs code fetched at runtime (invariant 2): a complete install already on
  // disk is used, and a missing one is a hard error.
  return yield* new DeviceToolchainInstallError({
    tool: spec.name,
    step: `refusing to download ${spec.name}@${spec.version} from the npm registry: this fork only runs device tools provisioned on this machine; place a complete install at ${paths.installDir} (entry ${paths.entryPath}, "${spec.version}" in ${paths.sentinelPath})`,
  });
});

const ensureTool = Effect.fn("DeviceToolchain.ensureTool")(function* (
  baseDir: string,
  spec: ToolSpec,
  select: (paths: DeviceToolchainPaths) => DeviceToolPaths,
) {
  const path = yield* Path.Path;
  const paths = deviceToolchainPaths(path, baseDir);
  return yield* installTool(spec, select(paths));
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
