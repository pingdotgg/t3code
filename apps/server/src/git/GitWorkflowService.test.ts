import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { assert, describe, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import {
  ExternalIntegrationRepository,
  type ExternalIntegrationRepositoryShape,
} from "../persistence/Services/ExternalIntegrations.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: { readonly detect: VcsDriverRegistry.VcsDriverRegistryShape["detect"] }) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(Layer.mock(ProjectionThreadRepository)({})),
    Layer.provide(Layer.mock(ExternalIntegrationRepository)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(ProjectionThreadRepository)({})),
      Layer.provide(Layer.mock(ExternalIntegrationRepository)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("records a GitHub pull request artifact for a thread worktree after a git action opens a PR", () => {
    const artifactLinks: Array<
      Parameters<ExternalIntegrationRepositoryShape["upsertArtifactLink"]>[0]
    > = [];
    const result = {
      action: "create_pr",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_not_requested" },
      push: { status: "skipped_not_requested" },
      pr: {
        status: "created",
        url: "https://github.com/acme/app/pull/42",
        number: 42,
        baseBranch: "main",
        headBranch: "feature/slack-merge-reaction",
        title: "Add Slack merge reaction",
      },
      toast: {
        title: "Created PR #42",
        cta: {
          kind: "open_pr",
          label: "Open PR",
          url: "https://github.com/acme/app/pull/42",
        },
      },
    } satisfies GitRunStackedActionResult;

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () =>
            Effect.succeed({
              kind: "git",
              repository: {
                kind: "git",
                rootPath: "/repo/worktree",
                metadataPath: "/repo/worktree/.git",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriver.VcsDriverShape,
            } satisfies VcsDriverRegistry.VcsDriverHandle),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          runStackedAction: () => Effect.succeed(result),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionThreadRepository)({
          getByWorktreePath: ({ worktreePath }) => {
            assert.equal(worktreePath, "/repo/worktree/src");
            return Effect.succeed(
              Option.some({
                threadId: ThreadId.make("thread-slack-task"),
                projectId: ProjectId.make("project-slack-task"),
                title: "Slack task",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "feature/slack-merge-reaction",
                worktreePath: "/repo/worktree",
                latestTurnId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                archivedAt: null,
                latestUserMessageAt: null,
                pendingApprovalCount: 0,
                pendingUserInputCount: 0,
                hasActionableProposedPlan: 0,
                deletedAt: null,
              }),
            );
          },
        }),
      ),
      Layer.provide(
        Layer.mock(ExternalIntegrationRepository)({
          upsertArtifactLink: (artifact) =>
            Effect.sync(() => {
              artifactLinks.push(artifact);
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const actual = yield* workflow.runStackedAction({
        actionId: "git-action-1",
        cwd: "/repo/worktree/src",
        action: "create_pr",
      });

      assert.deepStrictEqual(actual, result);
      assert.equal(artifactLinks.length, 1);
      assert.deepStrictEqual(
        artifactLinks.map((artifact) => ({
          kind: artifact.kind,
          externalId: artifact.externalId,
          t3ThreadId: artifact.t3ThreadId,
          url: artifact.url,
        })),
        [
          {
            kind: "github_pr",
            externalId: "acme/app#42",
            t3ThreadId: ThreadId.make("thread-slack-task"),
            url: "https://github.com/acme/app/pull/42",
          },
        ],
      );
    }).pipe(Effect.provide(testLayer));
  });
});
