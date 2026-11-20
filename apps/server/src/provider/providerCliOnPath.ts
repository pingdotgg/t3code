import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  parseCliVersionResult,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";

const VERSION_TIMEOUT = "10 seconds";

export interface ProviderCliOnPath {
  readonly executablePath: string;
  readonly version: string | null;
}

/**
 * Orbit installs and updates provider CLIs and owns PATH, so the server only looks there.
 * The version is read from the binary on every call, so an update on PATH shows at once.
 */
export const resolveProviderCliOnPath = Effect.fn("resolveProviderCliOnPath")(function* (
  command: string,
  environment?: NodeJS.ProcessEnv,
) {
  const env = environment ?? (yield* HostProcess.Environment);
  const expanded = expandHomePath(command.trim(), yield* HostProcess.HomeDirectory);
  const executablePath = yield* resolveCommandPath(expanded, { env });
  if (executablePath === null) return null;
  const version = yield* spawnAndCollect(
    expanded,
    ChildProcess.make(executablePath, ["--version"], { env, shell: false }),
  ).pipe(
    Effect.map((result) => parseCliVersionResult(result)),
    Effect.timeoutOption(VERSION_TIMEOUT),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  return { executablePath, version } satisfies ProviderCliOnPath;
});
