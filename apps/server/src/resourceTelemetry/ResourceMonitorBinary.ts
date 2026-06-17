import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

export class ResourceMonitorBinaryUnsupported extends Schema.TaggedErrorClass<ResourceMonitorBinaryUnsupported>()(
  "ResourceMonitorBinaryUnsupported",
  {
    platform: Schema.String,
    architecture: Schema.String,
  },
) {
  override get message(): string {
    return `Resource monitoring is unsupported on ${this.platform}/${this.architecture}.`;
  }
}

export class ResourceMonitorBinaryNotFound extends Schema.TaggedErrorClass<ResourceMonitorBinaryNotFound>()(
  "ResourceMonitorBinaryNotFound",
  {
    platform: Schema.String,
    architecture: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Resource monitor binary was not found for ${this.platform}/${this.architecture}.`;
  }
}

export class ResourceMonitorBinaryNotExecutable extends Schema.TaggedErrorClass<ResourceMonitorBinaryNotExecutable>()(
  "ResourceMonitorBinaryNotExecutable",
  {
    path: Schema.String,
    mode: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor binary at '${this.path}' is not executable.`;
  }
}

export type ResourceMonitorBinaryError =
  | ResourceMonitorBinaryUnsupported
  | ResourceMonitorBinaryNotFound
  | ResourceMonitorBinaryNotExecutable;

export interface ResourceMonitorBinaryShape {
  readonly resolve: Effect.Effect<string, ResourceMonitorBinaryError>;
}

export class ResourceMonitorBinary extends Context.Service<
  ResourceMonitorBinary,
  ResourceMonitorBinaryShape
>()("t3/resourceTelemetry/ResourceMonitorBinary") {}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

export function resourceMonitorPlatformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32") ||
    (architecture !== "arm64" && architecture !== "x64")
  ) {
    return undefined;
  }
  return `${platform}-${architecture}`;
}

function resourceMonitorRustTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  if (platform === "darwin") {
    return architecture === "arm64"
      ? "aarch64-apple-darwin"
      : architecture === "x64"
        ? "x86_64-apple-darwin"
        : undefined;
  }
  if (platform === "linux") {
    return architecture === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : architecture === "x64"
        ? "x86_64-unknown-linux-gnu"
        : undefined;
  }
  if (platform === "win32") {
    return architecture === "arm64"
      ? "aarch64-pc-windows-msvc"
      : architecture === "x64"
        ? "x86_64-pc-windows-msvc"
        : undefined;
  }
  return undefined;
}

export const make = Effect.fn("resourceTelemetry.resourceMonitorBinary.make")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const executableName = binaryName(platform);
  const platformKey = resourceMonitorPlatformKey(platform, architecture);
  const rustTarget = resourceMonitorRustTarget(platform, architecture);
  if (platformKey === undefined || rustTarget === undefined) {
    return ResourceMonitorBinary.of({
      resolve: Effect.fail(
        new ResourceMonitorBinaryUnsupported({
          platform,
          architecture,
        }),
      ),
    });
  }

  const candidates = [
    environment.T3CODE_RESOURCE_MONITOR_PATH,
    config.resourceMonitorPath,
    path.resolve(import.meta.dirname, "resource-monitor", platformKey, executableName),
    path.resolve(import.meta.dirname, "resource-monitor", executableName),
    path.resolve(import.meta.dirname, "../resource-monitor", executableName),
    path.resolve(
      import.meta.dirname,
      "../../../../native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    ),
    path.resolve(
      import.meta.dirname,
      "../../../native/resource-monitor/target",
      rustTarget,
      "release",
      executableName,
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../native/resource-monitor/target/release",
      executableName,
    ),
    path.resolve(
      import.meta.dirname,
      "../../../../native/resource-monitor/target/debug",
      executableName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const resolve: ResourceMonitorBinaryShape["resolve"] = Effect.gen(function* () {
    for (const candidate of candidates) {
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;

      if (platform !== "win32") {
        const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
        if (Option.isSome(stat) && (stat.value.mode & 0o111) === 0) {
          return yield* new ResourceMonitorBinaryNotExecutable({
            path: candidate,
            mode: stat.value.mode,
          });
        }
      }

      return candidate;
    }

    return yield* new ResourceMonitorBinaryNotFound({
      platform,
      architecture,
      candidates,
    });
  });

  return ResourceMonitorBinary.of({ resolve });
});

export const layer = Layer.effect(ResourceMonitorBinary, make());
