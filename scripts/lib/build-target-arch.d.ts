import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
export type BuildArch = "arm64" | "x64" | "universal";
export type BuildPlatform = "mac" | "linux" | "win";
interface PlatformConfig {
  readonly archChoices: ReadonlyArray<BuildArch>;
}
export declare const getDefaultBuildArch: (
  platform: BuildPlatform,
  platformConfig: PlatformConfig,
) => Effect.Effect<BuildArch, Config.ConfigError, never>;
export {};
