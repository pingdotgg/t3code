import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type BuildArch = "arm64" | "x64" | "universal";
export type BuildPlatform = "mac" | "linux" | "win";

interface PlatformConfig {
  readonly archChoices: ReadonlyArray<BuildArch>;
}

export { HostProcessArchitecture, HostProcessPlatform };

const WindowsProcessorArchitectureConfig = Config.all({
  processorArchitecture: Config.string("PROCESSOR_ARCHITECTURE").pipe(Config.option),
  processorArchitectureW6432: Config.string("PROCESSOR_ARCHITEW6432").pipe(Config.option),
});

function normalizeWindowsArch(value: string | undefined): BuildArch | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("arm64") || normalized === "aarch64") return "arm64";
  if (normalized.includes("amd64") || normalized.includes("x64")) return "x64";
  return undefined;
}

const optionToUndefined = <A>(value: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(value);

export const resolveHostProcessArch = Effect.fn("resolveHostProcessArch")(function* () {
  const platform = yield* HostProcessPlatform;
  const processArch = yield* HostProcessArchitecture;
  if (processArch === "arm64") return "arm64";
  if (processArch === "x64") {
    if (platform !== "win32") return "x64";

    // On Windows-on-Arm, x64 Node/Bun can run under emulation while the host
    // still reports ARM64 via the processor environment variables.
    const env = yield* WindowsProcessorArchitectureConfig;
    return (
      normalizeWindowsArch(optionToUndefined(env.processorArchitectureW6432)) ??
      normalizeWindowsArch(optionToUndefined(env.processorArchitecture)) ??
      "x64"
    );
  }
  return undefined;
});

export const getDefaultBuildArch = Effect.fn("getDefaultBuildArch")(function* (
  platform: BuildPlatform,
  platformConfig: PlatformConfig,
) {
  const hostArch = yield* resolveHostProcessArch();
  if (hostArch && platformConfig.archChoices.includes(hostArch)) {
    return hostArch;
  }

  return platformConfig.archChoices[0] ?? "x64";
});
