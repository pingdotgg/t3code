import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

export class ResourceMonitorBinaryUnsupported extends Schema.TaggedError<ResourceMonitorBinaryUnsupported>()(
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

export class ResourceMonitorBinaryNotFound extends Schema.TaggedError<ResourceMonitorBinaryNotFound>()(
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

export class ResourceMonitorBinaryNotExecutable extends Schema.TaggedError<ResourceMonitorBinaryNotExecutable>()(
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

export class ResourceMonitorBinaryInvalidPath extends Schema.TaggedError<ResourceMonitorBinaryInvalidPath>()(
  "ResourceMonitorBinaryInvalidPath",
  {
    path: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Resource monitor binary path '${this.path}' is invalid: ${this.reason}.`;
  }
}

export type ResourceMonitorBinaryError =
  | ResourceMonitorBinaryUnsupported
  | ResourceMonitorBinaryNotFound
  | ResourceMonitorBinaryNotExecutable
  | ResourceMonitorBinaryInvalidPath;

export class ResourceMonitorBinary extends Context.Service<
  ResourceMonitorBinary,
  {
    readonly resolve: Effect.Effect<string, ResourceMonitorBinaryError>;
  }
>()("t3/resourceTelemetry/ResourceMonitorBinary") {}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

export type ResourceMonitorLinuxLibc = "gnu" | "musl";

function detectResourceMonitorLinuxLibc(): ResourceMonitorLinuxLibc {
  try {
    const report = process.report?.getReport() as
      | {
          readonly header?: {
            readonly glibcVersionRuntime?: unknown;
          };
        }
      | undefined;
    return typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
  } catch {
    return "musl";
  }
}

export const ResourceMonitorHostLinuxLibc = Context.Reference<ResourceMonitorLinuxLibc>(
  "t3/resourceTelemetry/ResourceMonitorHostLinuxLibc",
  {
    defaultValue: detectResourceMonitorLinuxLibc,
  },
);

function resourceMonitorPlatformKey(
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
  linuxLibc?: ResourceMonitorLinuxLibc,
): string | undefined {
  if (platform === "darwin") {
    return architecture === "arm64"
      ? "aarch64-apple-darwin"
      : architecture === "x64"
        ? "x86_64-apple-darwin"
        : undefined;
  }
  if (platform === "linux") {
    if (linuxLibc !== "gnu") {
      return undefined;
    }
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

export const isResourceMonitorPathAbsolute = (
  candidate: string,
  platform: NodeJS.Platform,
  path: Path.Path,
): boolean => {
  if (
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    candidate.includes("\0") ||
    candidate.includes("\r") ||
    candidate.includes("\n")
  ) {
    return false;
  }
  if (platform === "win32") {
    return (
      path.isAbsolute(candidate) &&
      (/^[A-Za-z]:[\\/]/u.test(candidate) || candidate.startsWith("\\\\"))
    );
  }
  return path.isAbsolute(candidate);
};

export const validateResourceMonitorOverride = Effect.fn(
  "resourceTelemetry.resourceMonitorBinary.validateOverride",
)(function* (candidate: string, platform: NodeJS.Platform, architecture: NodeJS.Architecture) {
  const path = yield* Path.Path;
  if (!isResourceMonitorPathAbsolute(candidate, platform, path)) {
    return yield* new ResourceMonitorBinaryInvalidPath({
      path: candidate,
      reason: "expected an absolute path",
    });
  }
  if (platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
    return yield* new ResourceMonitorBinaryInvalidPath({
      path: candidate,
      reason: "Windows overrides must use a .exe file",
    });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* fileSystem.stat(candidate).pipe(Effect.option);
  if (Option.isNone(stat)) {
    return yield* new ResourceMonitorBinaryNotFound({
      platform,
      architecture,
      candidates: [candidate],
    });
  }
  if (stat.value.type !== "File" || (platform !== "win32" && (stat.value.mode & 0o111) === 0)) {
    return yield* new ResourceMonitorBinaryNotExecutable({
      path: candidate,
      mode: stat.value.mode,
    });
  }
});

export const make = Effect.fn("resourceTelemetry.resourceMonitorBinary.make")(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const linuxLibc = platform === "linux" ? yield* ResourceMonitorHostLinuxLibc : undefined;
  const executableName = binaryName(platform);
  const platformKey = resourceMonitorPlatformKey(platform, architecture);
  const rustTarget = resourceMonitorRustTarget(platform, architecture, linuxLibc);
  if (config.resourceMonitorPath !== undefined) {
    const override = config.resourceMonitorPath;
    const resolve: ResourceMonitorBinary["Service"]["resolve"] = Effect.gen(function* () {
      yield* validateResourceMonitorOverride(override, platform, architecture).pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      return override;
    });
    return ResourceMonitorBinary.of({ resolve });
  }
  const bundledCandidates =
    platformKey === undefined || rustTarget === undefined
      ? []
      : [
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
        ];
  if (bundledCandidates.length === 0) {
    return ResourceMonitorBinary.of({
      resolve: Effect.fail(
        new ResourceMonitorBinaryUnsupported({
          platform,
          architecture,
        }),
      ),
    });
  }

  const candidates = bundledCandidates;

  const resolve: ResourceMonitorBinary["Service"]["resolve"] = Effect.gen(function* () {
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
