import { Effect, Layer } from "effect";

import { GitManager } from "../../git/Services/GitManager.ts";
import { JjManager } from "../../jj/Services/JjManager.ts";
import { VcsManager, type VcsManagerShape } from "../Services/VcsManager.ts";
import { detectRepoKind } from "../Utils.ts";

export const VcsManagerLive = Layer.effect(
  VcsManager,
  Effect.gen(function* () {
    const gitManager = yield* GitManager;
    const jjManager = yield* JjManager;

    const selectManager = (cwd: string) => (detectRepoKind(cwd) === "jj" ? jjManager : gitManager);

    const routed = {
      status: (input) => selectManager(input.cwd).status(input),
      resolvePullRequest: (input) => selectManager(input.cwd).resolvePullRequest(input),
      preparePullRequestThread: (input) => selectManager(input.cwd).preparePullRequestThread(input),
      runStackedAction: (input, options) =>
        selectManager(input.cwd).runStackedAction(input, options),
    } satisfies VcsManagerShape;

    return routed;
  }),
);

export const VcsManagerFromGitLive = Layer.effect(
  VcsManager,
  Effect.gen(function* () {
    return yield* GitManager;
  }),
);
