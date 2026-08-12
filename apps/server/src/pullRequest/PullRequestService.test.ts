import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { type ProviderChangeRequest, type PullRequestProviderApi } from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

const project: OrchestrationProjectShell = {
  id: "project-1" as ProjectId,
  title: "Web",
  workspaceRoot: "/workspace/web",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    provider: "github",
    displayName: "acme/web",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T00:00:00Z",
};

const teamRequestedChange: ProviderChangeRequest = {
  number: 42,
  title: "Review me",
  url: "https://github.com/acme/web/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feature/review",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-08-10T00:00:00Z",
  updatedAt: "2026-08-10T01:00:00Z",
  reviewRequestLogins: [],
  hasTeamReviewRequest: true,
  labels: [],
};

function provider(): PullRequestProviderApi {
  return providerWith();
}

function providerWith(overrides: Partial<PullRequestProviderApi> = {}): PullRequestProviderApi {
  return {
    kind: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge", "squash", "rebase"],
      search: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
    },
    getViewer: () => Effect.succeed("bilal"),
    listChangeRequests: () =>
      Effect.succeed({ items: [teamRequestedChange], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    comment: () => Effect.void,
    submitReview: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    ...overrides,
  };
}

function makeService(
  input: {
    readonly project?: OrchestrationProjectShell;
    readonly provider?: PullRequestProviderApi;
  } = {},
) {
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders([input.provider ?? provider()])),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [input.project ?? project],
              threads: [],
              updatedAt: "2026-08-10T00:00:00Z",
            }),
        }),
      ),
    ),
  );
}

it.effect("marks a team request only on a server-selected Reviewing result", () =>
  Effect.gen(function* () {
    const service = yield* makeService();

    const all = yield* service.list({ state: "open", involvement: "all" });
    const reviewing = yield* service.list({ state: "open", involvement: "reviewing" });

    assert.strictEqual(all.entries[0]?.viewerReviewRequested, false);
    assert.strictEqual(reviewing.entries[0]?.viewerReviewRequested, true);
  }),
);

it.effect("refuses a mutation that names a repository outside the selected project", () =>
  Effect.gen(function* () {
    const service = yield* makeService();

    const error = yield* service
      .comment({
        projectId: project.id,
        repository: "attacker/repository",
        number: 42,
        body: "Please merge this.",
      })
      .pipe(Effect.flip);

    if (error._tag !== "PullRequestOperationError") {
      assert.fail(`Expected PullRequestOperationError, got ${error._tag}`);
    }
    assert.strictEqual(error.operation, "resolveRepository");
  }),
);

it.effect("scopes viewer discovery to the project's GitHub host", () =>
  Effect.gen(function* () {
    const viewerInputs: Array<{ readonly cwd: string; readonly host: string }> = [];
    const enterpriseProject: OrchestrationProjectShell = {
      ...project,
      workspaceRoot: "/workspace/enterprise",
      repositoryIdentity: {
        ...project.repositoryIdentity!,
        canonicalKey: "github.example.test/acme/web",
      },
    };
    const service = yield* makeService({
      project: enterpriseProject,
      provider: providerWith({
        getViewer: (input) => {
          viewerInputs.push(input);
          return Effect.succeed("enterprise-user");
        },
      }),
    });

    yield* service.list({ state: "open" });

    assert.deepStrictEqual(viewerInputs, [
      { cwd: "/workspace/enterprise", host: "github.example.test" },
    ]);
  }),
);

it.effect("keeps listings cached for mutations that only change one pull request", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    let activityCalls = 0;
    const reference = { projectId: project.id, repository: "acme/web", number: 42 };
    const service = yield* makeService({
      provider: providerWith({
        listChangeRequests: () => {
          listCalls += 1;
          return Effect.succeed({
            items: [teamRequestedChange],
            truncated: false,
            continues: true,
          });
        },
        getChangeRequestActivity: () => {
          activityCalls += 1;
          return Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [
              {
                id: "thread-on-pr",
                path: "src/file.ts",
                line: 1,
                side: "right",
                isResolved: false,
                isOutdated: false,
                comments: [],
              },
            ],
            commits: [],
          });
        },
      }),
    });

    const assertReferenceInvalidated = (expectedActivityCalls: number) =>
      Effect.gen(function* () {
        yield* service.list({ state: "open" });
        assert.strictEqual(listCalls, 1);
        yield* service.activity(reference);
        assert.strictEqual(activityCalls, expectedActivityCalls);
      });

    yield* service.list({ state: "open" });
    yield* service.activity(reference);
    assert.strictEqual(listCalls, 1);
    assert.strictEqual(activityCalls, 1);

    yield* service.comment({ ...reference, body: "Please update this." });
    yield* assertReferenceInvalidated(2);

    yield* service.submitReview({
      ...reference,
      verdict: "comment",
      body: "Please update this.",
      comments: [],
    });
    yield* assertReferenceInvalidated(3);

    yield* service.replyToThread({
      ...reference,
      threadId: "thread-on-pr",
      body: "Resolved in the latest commit.",
    });
    yield* assertReferenceInvalidated(4);

    yield* service.setThreadResolution({
      ...reference,
      threadId: "thread-on-pr",
      resolved: true,
    });
    yield* assertReferenceInvalidated(5);

    yield* service.requestReviewers({
      ...reference,
      reviewers: [{ id: "reviewer", kind: "user" }],
      requested: true,
    });
    yield* assertReferenceInvalidated(6);

    yield* service.runAction({ ...reference, action: "close" });
    yield* service.list({ state: "open" });
    yield* service.activity(reference);
    assert.strictEqual(listCalls, 2);
    assert.strictEqual(activityCalls, 7);
  }),
);

it.effect("mutates only review threads proven to belong to the selected pull request", () =>
  Effect.gen(function* () {
    const replies: string[] = [];
    const resolutions: string[] = [];
    const service = yield* makeService({
      provider: providerWith({
        getChangeRequestActivity: () =>
          Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            reviewThreads: [
              {
                id: "thread-on-pr",
                path: "src/file.ts",
                line: 1,
                side: "right",
                isResolved: false,
                isOutdated: false,
                comments: [],
              },
            ],
            commits: [],
          }),
        replyToThread: (input) => {
          replies.push(input.threadId);
          return Effect.void;
        },
        setThreadResolution: (input) => {
          resolutions.push(input.threadId);
          return Effect.void;
        },
      }),
    });

    yield* service.replyToThread({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      threadId: "thread-on-pr",
      body: "Resolved in the latest commit.",
    });
    yield* service.setThreadResolution({
      projectId: project.id,
      repository: "acme/web",
      number: 42,
      threadId: "thread-on-pr",
      resolved: true,
    });

    const replyError = yield* service
      .replyToThread({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        threadId: "thread-on-another-pr",
        body: "This must not be sent.",
      })
      .pipe(Effect.flip);
    const resolutionError = yield* service
      .setThreadResolution({
        projectId: project.id,
        repository: "acme/web",
        number: 42,
        threadId: "thread-on-another-pr",
        resolved: true,
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(replies, ["thread-on-pr"]);
    assert.deepStrictEqual(resolutions, ["thread-on-pr"]);
    assert.strictEqual(replyError._tag, "PullRequestOperationError");
    assert.strictEqual(resolutionError._tag, "PullRequestOperationError");
  }),
);
