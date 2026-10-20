import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import type * as JjRepo from "../vcs/JjRepo.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import { describeJj, runJj, withJjRepo, stubSourceControlProviders } from "../vcs/testing/JjTestSupport.ts";
import { makeJjStatus } from "./JjStatus.ts";

vi.mock("../vcs/JjRepo.ts", async (importOriginal) => ({
  ...await importOriginal<typeof JjRepo>(),
  JJ_REPOSITORY_DETECTION_ENABLED: true,
}));

const makeStatus = (driver: JjVcsDriver.JjVcsDriverShape, process: VcsProcess.VcsProcess["Service"]) =>
  Effect.gen(function* () {
    return yield* makeJjStatus({ driver, process,
      gitManager: yield* GitManager.GitManager.pipe(Effect.provide(Layer.mock(GitManager.GitManager)({ branchPullRequest: () => Effect.succeed(null) }))),
      sourceControlProviders: yield* stubSourceControlProviders,
    });
  });

describeJj("JjStatus enabled broadcaster refresh reads", () => {
  for (const method of ["getStatus", "refreshStatus", "post-pull"] as const) {
    it.effect(`shares real jj reads in broadcaster ${method}`, () =>
      withJjRepo({ prefix: "t3-jj-broadcast-dedup-", seed: true }, (repo) =>
        Effect.gen(function* () {
          let segments = 0;
          let workspaces = 0;
          let pulled = false;
          const status = yield* makeStatus(
            {
              ...repo.driver,
              currentSegment: (cwd) =>
                Effect.sync(() => {
                  segments += 1;
                }).pipe(Effect.andThen(repo.driver.currentSegment(cwd))),
              listWorkspaces: (cwd) =>
                Effect.sync(() => {
                  workspaces += 1;
                }).pipe(Effect.andThen(repo.driver.listWorkspaces(cwd))),
            },
            repo.process,
          );
          const layer = VcsStatusBroadcaster.layer.pipe(
            Layer.provide(
              Layer.mock(GitWorkflowService.GitWorkflowService)({
                // jj is deliberately not auto-pulled in production. Advertise Git only at this
                // test seam to exercise the shared broadcaster's mutation boundary with real reads.
                localStatus: (input) =>
                  status
                    .localStatus(input)
                    .pipe(
                      Effect.map((local) =>
                        method === "post-pull" ? { ...local, vcs: undefined } : local,
                      ),
                    ),
                remoteStatus: (input, options) =>
                  status
                    .remoteStatus(input, options)
                    .pipe(
                      Effect.map((remote) =>
                        method === "post-pull" && remote
                          ? { ...remote, hasUpstream: true, behindCount: pulled ? 0 : 1 }
                          : remote,
                      ),
                    ),
                pullCurrentBranch: () =>
                  Effect.gen(function* () {
                    yield* repo.fileSystem.writeFileString(
                      repo.path.join(repo.root, "pulled.txt"),
                      "incoming\n",
                    );
                    // Move @ and its segment, not just the filesystem, across the read scope.
                    yield* runJj(repo.root, ["new", "-m", "after pull"]);
                    pulled = true;
                    return {
                      status: "pulled" as const,
                      refName: "main",
                      upstreamRef: "origin/main",
                    };
                  }).pipe(Effect.orDie),
                invalidateStatus: repo.driver.invalidateRepoCaches,
                invalidateLocalStatus: repo.driver.invalidateRepoCaches,
              }),
            ),
            Layer.provide(
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                shouldRunScopeWork: () => Effect.succeed(false),
              }),
            ),
            Layer.provide(
              Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
                isEnabled: () => Effect.succeed(method === "post-pull"),
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
            yield* method === "getStatus"
              ? broadcaster.getStatus({ cwd: repo.root })
              : broadcaster.refreshStatus(repo.root);
            const firstReads = method === "post-pull" ? 2 : 1;
            assert.equal(pulled, method === "post-pull");
            assert.equal(segments, firstReads);
            assert.equal(workspaces, firstReads);
            yield* broadcaster.refreshStatus(repo.root);
            assert.equal(segments, firstReads + 1);
            assert.equal(workspaces, firstReads + 1);
          }).pipe(Effect.provide(layer));
        }),
      ),
    );
  }

});
