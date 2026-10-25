import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Where SSH hosts download the T3 server release matching the app's version.
 * The fork publishes its own releases (.github/workflows/fork-release.yml), so
 * its server changes reach Sandboxes; upstream's releases would not have them.
 */
const FORK_RELEASE_BASE_URL = "https://github.com/martinothamar/t3code/releases/download";

/**
 * Lets a build choose which T3 server release SSH hosts install, instead of the
 * fork's release matching the app's own version.
 */
export const remoteServerOverrides = Effect.gen(function* () {
  const version = yield* Config.String("T3CODE_REMOTE_SERVER_VERSION").pipe(Config.option);
  const releaseBaseUrl = yield* Config.String("T3CODE_REMOTE_SERVER_RELEASE_BASE_URL").pipe(
    Config.option,
  );
  const overrides: { -readonly [K in keyof RemoteT3RunnerOptions]: RemoteT3RunnerOptions[K] } = {};
  const trimmedVersion = Option.getOrUndefined(version)?.trim().replace(/^v/, "");
  if (trimmedVersion) overrides.archiveVersion = trimmedVersion;
  const trimmedReleaseBaseUrl = Option.getOrUndefined(releaseBaseUrl)?.trim();
  if (trimmedReleaseBaseUrl) overrides.releaseBaseUrl = trimmedReleaseBaseUrl;
  return overrides;
}).pipe(Effect.orElseSucceed((): RemoteT3RunnerOptions => ({})));

/**
 * Applies the overrides to a release runner; a source-checkout runner is left alone. A release
 * URL the runner already has, from upstream's T3CODE_RELEASE_BASE_URL, wins over the fork's.
 */
export function withRemoteServerOverrides(
  runner: RemoteT3RunnerOptions,
  overrides: RemoteT3RunnerOptions,
): RemoteT3RunnerOptions {
  return runner.nodeScriptPath
    ? runner
    : { ...runner, releaseBaseUrl: runner.releaseBaseUrl ?? FORK_RELEASE_BASE_URL, ...overrides };
}
