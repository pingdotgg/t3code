import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  OrchestrationProjectShell,
  ProjectId,
  PullRequestReviewCapabilities,
  PullRequestReviewerCapabilities,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import type { ServerSettings } from "@t3tools/contracts";
import * as ServerSettingsService from "../serverSettings.ts";
import { PullRequestOperationError } from "@t3tools/contracts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";

import {
  project,
  changeRequest,
  unusable,
  requestFailed,
  FULL_REVIEW,
  FULL_REVIEWERS,
  makeService,
} from "./PullRequestService-fixtures.testkit.ts";

it.effect("offers each label once across repositories, despite one that cannot be read", () =>
  Effect.gen(function* () {
    const reads: Array<string> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p5",
          title: "t3code worktree",
          workspaceRoot: "/e",
          repository: "pingdotgg/t3code",
        }),
        project({
          id: "p2",
          title: "uploadthing",
          workspaceRoot: "/b",
          repository: "pingdotgg/ut",
        }),
        project({ id: "p3", title: "broken", workspaceRoot: "/c", repository: "pingdotgg/broken" }),
        project({
          id: "p4",
          title: "elsewhere",
          workspaceRoot: "/d",
          repository: "group/app",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listRepositoryLabels: (input) => {
            reads.push(input.repository);
            return input.repository === "pingdotgg/broken"
              ? Effect.fail(requestFailed)
              : Effect.succeed({
                  items:
                    input.repository === "pingdotgg/t3code"
                      ? [
                          { name: "size:XL", color: "d93f0b" },
                          { name: "bug", color: "d73a4a" },
                        ]
                      : [{ name: "Bug", color: "ee0701" }],
                  truncated: false,
                });
          },
        }),
        // A host with no repository labels is left out rather than failing the answer.
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab")),
      ],
    });

    const result = yield* service.filterOptions({ kind: "labels" });

    assert.deepStrictEqual(
      result.labels.map((label) => label.name),
      ["bug", "size:XL"],
    );
    assert.strictEqual(reads.filter((repository) => repository === "pingdotgg/t3code").length, 1);
    assert.strictEqual(result.truncated, false);
  }),
);
it.effect("puts the author a query names exactly ahead of those it only begins", () =>
  Effect.gen(function* () {
    const queries: Array<string | undefined> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          searchRepositoryAuthors: (input) => {
            queries.push(input.query);
            return Effect.succeed({
              items: [
                { login: "theo-browne", name: null, avatarUrl: null },
                { login: "octocat", name: "Theo", avatarUrl: null },
                { login: "julius", name: "Julius", avatarUrl: null },
                { login: "t3dotgg", name: "theo", avatarUrl: null },
              ],
              truncated: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.filterOptions({ kind: "authors", query: "theo" });

    assert.deepStrictEqual(queries, ["theo"]);
    assert.deepStrictEqual(
      result.authors.map((author) => author.login),
      ["octocat", "t3dotgg", "theo-browne"],
    );
    assert.strictEqual(result.truncated, true);
  }),
);
it.effect("tries another workspace on the same host for the viewer", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "broken", workspaceRoot: "/broken", repository: "acme/one" }),
        project({ id: "p2", title: "healthy", workspaceRoot: "/healthy", repository: "acme/two" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getViewer: (input) =>
            input.cwd === "/healthy"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable(SourceControlProviderKind.make("github"), "missing-tool")),
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.viewers["github.com"], "bilal");
  }),
);
it.effect("routing verifies the current account on the requested host without caching it", () =>
  Effect.gen(function* () {
    let viewer = "first-account";
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/a",
          repository: "acme/web",
          host: "github.example.test",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getRoutingIdentity: (input) => {
            assert.deepStrictEqual(input, { cwd: "/a", host: "github.example.test" });
            return Effect.succeed({
              viewer,
              accountId: viewer === "first-account" ? "123" : "456",
            });
          },
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    assert.deepStrictEqual(yield* service.routing(ref), {
      host: "github.example.test",
      provider: SourceControlProviderKind.make("github"),
      viewer: "first-account",
      accountId: "123",
      projectTitle: "web",
      workspaceRoot: "/a",
    });
    viewer = "second-account";
    assert.strictEqual((yield* service.routing(ref)).viewer, "second-account");
    viewer = " ";
    const failure = yield* service.routing(ref).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "PullRequestOperationError");
    if (failure._tag === "PullRequestOperationError") {
      assert.strictEqual(failure.operation, "routeIdentity");
    }
  }),
);
it.effect("refuses an action the host never claimed it could run", () =>
  Effect.gen(function* () {
    let ran = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "close"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          runAction: () => {
            ran = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.runAction({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        action: "reopen",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(ran);
  }),
);
it.effect(
  "asks to remove agent credits on merge only from a host that rewrites merge messages",
  () =>
    Effect.gen(function* () {
      const asked: Array<boolean | undefined> = [];
      const runAction: PullRequestProviderApi["runAction"] = (input) =>
        Effect.sync(() => {
          asked.push(input.removeAgentCreditsOnMerge);
        });
      for (const rewrites of [true, false]) {
        const service = yield* makeService({
          settings: { ...DEFAULT_SERVER_SETTINGS, removeAgentCreditsOnMerge: true },
          projects: [
            project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
          ],
          providers: [
            fakePullRequestProvider(SourceControlProviderKind.make("github"), {
              runAction,
              getChangeRequestSummary: () =>
                Effect.succeed(changeRequest(1, "2026-09-03T00:00:00Z")),
              ...(rewrites ? { mergeMessageRewrite: (message: string) => message } : {}),
            }),
          ],
        });
        yield* service.runAction({
          projectId: "p1" as ProjectId,
          repository: "acme/web",
          number: 1,
          action: "merge",
        });
      }
      assert.deepStrictEqual(asked, [true, undefined]);
    }),
);
it.effect("publishes a merge for immediate settlement only after host confirmation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mergedAt = "2026-09-03T02:00:00.000Z";
      let state: "open" | "merged" = "open";
      let confirmationFails = false;
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequestSummary: () =>
              confirmationFails
                ? Effect.fail(
                    new PullRequestProviderError({
                      provider: SourceControlProviderKind.make("github"),
                      operation: "getChangeRequestSummary",
                      reason: "failed",
                      detail: "HTTP 504",
                    }),
                  )
                : Effect.succeed({ ...changeRequest(1, mergedAt), state }),
          }),
        ],
      });
      const merges = yield* service.subscribeMerges;
      const observedMerge = yield* Stream.runHead(merges).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* service.runAction({ ...reference, action: "merge" });
      const queuedRefresh = Option.getOrThrow(yield* Stream.runHead(service.subscribeRefreshes));
      confirmationFails = true;
      yield* service.runAction({ ...reference, action: "merge" });
      assert.isAbove(
        Option.getOrThrow(yield* Stream.runHead(service.subscribeRefreshes)),
        queuedRefresh,
      );
      confirmationFails = false;
      state = "merged";
      yield* TestClock.setTime(Date.parse(mergedAt));
      yield* service.runAction({
        ...reference,
        repository: " ACME/WEB ",
        action: "merge",
        mergeMethod: "merge",
      });

      assert.deepStrictEqual(Option.getOrThrow(yield* Fiber.join(observedMerge)), {
        ...reference,
        mergedAt,
      });
    }),
  ),
);
it.effect("refreshes every reader before a queued merge confirmation finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const confirmationStarted = yield* Deferred.make<void>();
      const confirm = yield* Deferred.make<void>();
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequestSummary: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(confirmationStarted, undefined);
                yield* Deferred.await(confirm);
                return changeRequest(1, "2026-09-16T00:00:00.000Z");
              }),
          }),
        ],
      });
      const merges = yield* service.subscribeMerges;
      const observedMerge = yield* Stream.runHead(merges).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const readers = yield* Effect.forEach([0, 1], () =>
        Stream.runHead(service.subscribeRefreshes).pipe(
          Effect.forkChild({ startImmediately: true }),
        ),
      );
      const action = yield* service
        .runAction({ ...reference, action: "merge" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(confirmationStarted);
      const revisions = yield* Effect.forEach(readers, (reader) =>
        Fiber.join(reader).pipe(Effect.map(Option.getOrThrow)),
      );
      assert.isAbove(revisions[0]!, 0);
      assert.strictEqual(revisions[0], revisions[1]);
      assert.isUndefined(action.pollUnsafe());
      yield* Deferred.succeed(confirm, undefined);
      yield* Fiber.join(action);
      assert.isUndefined(observedMerge.pollUnsafe());
    }),
  ),
);
it.effect("runs branch deletion only when the host and viewer support it, never for a stack", () =>
  Effect.gen(function* () {
    let actions = 0;
    let supported = false;
    let allowed = true;
    const base = fakePullRequestProvider(SourceControlProviderKind.make("github"));
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        {
          ...base,
          capabilities: {
            ...base.capabilities,
            actions: ["delete-branch"],
            stackActions: true,
            get deleteBranch() {
              return supported;
            },
          },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: allowed ? ["delete-branch"] : [],
              comment: true,
              resolve: true,
              verdicts: [],
              requestReviewers: false,
            }),
          runAction: (input) =>
            Effect.sync(() => {
              assert.strictEqual(input.action, "delete-branch");
              actions++;
            }),
        },
      ],
    });
    const input = {
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      action: "delete-branch" as const,
    };
    assert.strictEqual(
      (yield* Effect.flip(service.runAction(input)))._tag,
      "PullRequestOperationError",
    );
    assert.strictEqual(actions, 0);
    supported = true;
    assert.strictEqual(
      (yield* Effect.flip(
        service.runAction({
          ...input,
          stackNumber: 2,
          expectedStackHeads: [{ number: 1, headSha: "abc123" }],
        }),
      ))._tag,
      "PullRequestOperationError",
    );
    assert.strictEqual(actions, 0);
    allowed = false;
    assert.strictEqual(
      (yield* Effect.flip(service.runAction(input)))._tag,
      "PullRequestOperationError",
    );
    assert.strictEqual(actions, 0);
    allowed = true;
    yield* service.runAction(input);
    assert.strictEqual(actions, 1);
  }),
);
it.effect("checks and deletes a branch inside one verified credential", () =>
  Effect.gen(function* () {
    let pinned = false;
    const calls: Array<string> = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            ...fakePullRequestProvider("github").capabilities,
            actions: ["delete-branch"],
            deleteBranch: true,
          },
          withVerifiedCredential: (_, use) =>
            Effect.suspend(() => {
              pinned = true;
              return use({ accountId: "101", viewer: "bilal", credentialFingerprint: "a" });
            }).pipe(Effect.ensuring(Effect.sync(() => (pinned = false)))),
          getViewerPermissions: () =>
            Effect.sync(() => {
              calls.push(`permissions pinned=${pinned}`);
              return {
                actions: ["delete-branch"],
                comment: true,
                resolve: true,
                verdicts: [],
                requestReviewers: false,
              };
            }),
          runAction: (input) =>
            Effect.sync(() => {
              calls.push(`${input.action} pinned=${pinned}`);
            }),
        }),
      ],
    });
    yield* service.runAction({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      action: "delete-branch",
    });
    assert.deepStrictEqual(calls, ["permissions pinned=true", "delete-branch pinned=true"]);
  }),
);
it.effect("refuses an action this viewer may not take, and says what access it takes", () =>
  Effect.gen(function* () {
    let ran: string | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["ready", "draft", "close", "reopen"],
              comment: true,
              resolve: true,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: false,
            }),
          runAction: (input) => {
            ran = input.action;
            return Effect.void;
          },
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    const error = yield* Effect.flip(service.runAction({ ...reference, action: "merge" }));
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "You need write access on this repository to merge.");
    assert.strictEqual(ran, null);

    yield* service.runAction({ ...reference, action: "close" });
    assert.strictEqual(ran, "close");
  }),
);
it.effect("gates arming a merge for later exactly as it gates merging now", () =>
  Effect.gen(function* () {
    let ranWith: { readonly action: string; readonly mergeMethod?: string } | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "close", "enable-auto-merge", "disable-auto-merge"],
            mergeMethods: ["merge", "squash"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["close"],
              comment: true,
              resolve: true,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: false,
            }),
          runAction: (input) => {
            ranWith = {
              action: input.action,
              ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
            };
            return Effect.void;
          },
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    const refused = yield* Effect.flip(
      service.runAction({ ...reference, action: "enable-auto-merge", mergeMethod: "squash" }),
    );
    assert.strictEqual(refused._tag, "PullRequestOperationError");
    assert.include(refused.message, "the repository has to allow it");
    assert.strictEqual(ranWith, null);

    const wrongStrategy = yield* Effect.flip(
      service.runAction({ ...reference, action: "enable-auto-merge", mergeMethod: "rebase" }),
    );
    assert.strictEqual(wrongStrategy._tag, "PullRequestOperationError");
    assert.strictEqual(ranWith, null);
  }),
);
it.effect("keeps two hosts of one provider kind as two accounts", () =>
  Effect.gen(function* () {
    const viewerFor: Record<string, string> = { "/cloud": "bilal", "/enterprise": "b.hassan" };
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/enterprise",
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getViewer: (input) => Effect.succeed(viewerFor[input.cwd] ?? "unknown"),
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 2);
    assert.deepStrictEqual(result.viewers, {
      "github.com": "bilal",
      "github.acme.dev": "b.hassan",
    });
    assert.deepStrictEqual(result.entries.map((entry) => entry.host).toSorted(), [
      "github.acme.dev",
      "github.com",
    ]);
  }),
);
it.effect("stops new reads after a rate limit while leaving manual actions available", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    let actionCalls = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: () =>
            Effect.sync(() => {
              listCalls += 1;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new PullRequestProviderError({
                    provider: SourceControlProviderKind.make("github"),
                    operation: "listChangeRequests",
                    reason: "rate-limited",
                    detail: "GitHub API rate limit exceeded.",
                  }),
                ),
              ),
            ),
          runAction: () =>
            Effect.sync(() => {
              actionCalls += 1;
            }),
        }),
      ],
    });

    const first = yield* service.list({ state: "open", involvement: "all" });
    const paused = yield* service.list({ state: "open", involvement: "authored" });
    yield* service.runAction({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      action: "close",
    });

    assert.strictEqual(listCalls, 1);
    assert.strictEqual(actionCalls, 1);
    assert.lengthOf(first.errors, 1);
    assert.lengthOf(paused.errors, 1);
  }),
);
it.effect("refuses a repository that does not belong to the requested project", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("github"))],
    });

    const error = yield* service
      .diff({ projectId: "p1" as ProjectId, repository: "attacker/repo", number: 1 })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);
