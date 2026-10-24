import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  describeJj,
  withJjRepo,
  stubSourceControlProviders,
} from "../vcs/testing/JjTestSupport.ts";
import { makeJjStatus } from "./JjStatus.ts";

const makeStatus = (
  driver: JjVcsDriver.JjVcsDriverShape,
  process: VcsProcess.VcsProcess["Service"],
) =>
  Effect.gen(function* () {
    return yield* makeJjStatus({
      driver,
      process,
      gitManager: yield* GitManager.GitManager.pipe(
        Effect.provide(
          Layer.mock(GitManager.GitManager)({ branchPullRequest: () => Effect.succeed(null) }),
        ),
      ),
      sourceControlProviders: yield* stubSourceControlProviders,
    });
  });

describeJj("JjStatus enabled broadcaster refresh reads", () => {
  it.effect.each(["getStatus", "refreshStatus"] as const)(
    "shares real jj reads in broadcaster $0",
    (method) =>
      withJjRepo({ prefix: "t3-jj-broadcast-dedup-", seed: true }, (repo) =>
        Effect.gen(function* () {
          let segments = 0;
          let workspaces = 0;
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
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
                detect: ({ cwd }) =>
                  repo.driver
                    .detectRepository(cwd)
                    .pipe(
                      Effect.map((repository) =>
                        repository === null
                          ? null
                          : { kind: "jj" as const, repository, driver: repo.driver },
                      ),
                    ),
              }),
            ),
            Layer.provide(
              Layer.mock(GitWorkflowService.GitWorkflowService)({
                localStatus: status.localStatus,
                remoteStatus: status.remoteStatus,
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
                isEnabled: () => Effect.succeed(false),
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
            yield* method === "getStatus"
              ? broadcaster.getStatus({ cwd: repo.root })
              : broadcaster.refreshStatus(repo.root);
            assert.equal(segments, 1);
            assert.equal(workspaces, 1);
            yield* broadcaster.refreshStatus(repo.root);
            assert.equal(segments, 2);
            assert.equal(workspaces, 2);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );
});
