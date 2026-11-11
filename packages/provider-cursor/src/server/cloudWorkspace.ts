import type { AgentOptions } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";
import { CURSOR_PROVIDER } from "./CursorAgentSdk.ts";

export const resolveCursorCloudWorkspace = Effect.fn("CursorCloud.resolveWorkspace")(function* (
  cwd: string | null,
) {
  const invalid = () =>
    new ProviderAdapterProtocolError({
      driver: CURSOR_PROVIDER,
      detail:
        "Cursor Cloud needs a GitHub repository with an origin remote and a pushed commit. Push your branch before sending. Local uncommitted changes are not uploaded.",
    });
  if (cwd === null) return yield* invalid();
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = Effect.fn("CursorCloud.git")(function* (args: ReadonlyArray<string>) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
        const [output, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            child.exitCode,
            Stream.runDrain(child.stderr),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return yield* invalid();
        return output.trim();
      }),
    ).pipe(Effect.mapError(() => invalid()));
  });
  const origin = yield* git(["remote", "get-url", "origin"]);
  const url = origin
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url)) return yield* invalid();
  const startingRef = yield* git(["rev-parse", "HEAD"]);
  const published = yield* git(["branch", "-r", "--contains", startingRef]);
  if (!published.split("\n").some((line) => line.trim().startsWith("origin/")))
    return yield* invalid();
  return {
    env: { type: "cloud" },
    repos: [{ url, startingRef }],
    autoCreatePR: false,
    workOnCurrentBranch: false,
  } satisfies NonNullable<AgentOptions["cloud"]>;
});
