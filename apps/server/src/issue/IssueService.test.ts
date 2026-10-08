import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import {
  issueProjectSourceKey,
  issueSourceKey,
  IssueListInput,
  IssueListResult,
  type IssueCapabilities,
  type IssueTemplateList,
  type IssueProviderKind,
  type IssueViewerPermissions,
  type OrchestrationProjectShell,
  type ProjectId,
  type IssueRef,
  IssueTrackingError,
} from "@t3tools/contracts";

import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  IssueProviderError,
  type ProviderBatchedIssue,
  type ProviderIssue,
  type ProviderIssueDetail,
  type IssueAdapter,
  type ProviderListCursor,
} from "./IssueProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { AllowGitHubReserve } from "../sourceControl/GitHubApi.ts";
import * as GitHubApi from "../sourceControl/GitHubApi.ts";
import * as GitHubIssueCli from "./GitHubIssueCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestReadCache from "../pullRequest/PullRequestReadCache.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as GitLabIssueCli from "./GitLabIssueCli.ts";
import * as GitLabIssueProvider from "./GitLabIssueProvider.ts";
import { IssueProviderRegistry, fromProviders } from "./IssueProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  // The host defaults from the provider, so a fixture only names one when the point of the
  // test is two hosts of the same kind.
  const host = input.host ?? (input.provider === "gitlab" ? "gitlab.com" : "github.com");
  return {
    id: input.id as ProjectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: `${host}/${input.repository}`,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
            },
            provider: input.provider ?? "github",
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function issue(number: number, updatedAt: string): ProviderIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://host/issues/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    state: "open",
    stateReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    closedAt: null,
    assignees: [],
    labels: [],
    milestone: null,
    commentCount: 0,
  };
}

function issueDetail(
  number: number,
  overrides: Partial<ProviderIssueDetail> = {},
): ProviderIssueDetail {
  return {
    ...issue(number, "2026-07-02T00:00:00Z"),
    body: "What went wrong",
    linkedPullRequests: [],
    viewerPermissions: FULL_PERMISSIONS,
    ...overrides,
  };
}

function unusable(provider: IssueProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new IssueProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

const trackerDisabled = new IssueProviderError({
  provider: "github",
  operation: "listIssues",
  reason: "tracker-disabled",
  detail: "Issues are disabled for this repository.",
});

/** Everything a host could offer, so a fixture only narrows what its own test is about. */
const FULL_CAPABILITIES: IssueCapabilities = {
  sorts: ["updated"],
  referenceStyle: "hash",
  closesViaPullRequest: true,
  comment: true,
  actions: ["close", "reopen"],
  closeReasons: ["completed", "not-planned"],
  create: true,
  issueTemplates: true,
  edit: true,
  editComment: true,
  reactions: true,
  labels: true,
  assignees: true,
  listLabelCandidates: true,
  listAssigneeCandidates: true,
  search: true,
  linkedPullRequests: true,
  timelineEvents: true,
};

/** A viewer who may do everything the host can, so a test only narrows what it is about. */
const FULL_PERMISSIONS: IssueViewerPermissions = {
  actions: ["close", "reopen"],
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
  create: true,
};

/** A provider whose every call is supplied by the test; anything unset succeeds emptily. */
function fakeProvider(
  kind: IssueProviderKind,
  overrides: Partial<IssueAdapter> = {},
): IssueAdapter {
  return {
    kind,
    capabilities: FULL_CAPABILITIES,
    getViewer: () => Effect.succeed("bilal"),
    getViewerPermissions: () => Effect.succeed(FULL_PERMISSIONS),
    listIssues: () => Effect.succeed({ items: [], truncated: false, continues: true }),
    getIssue: () => Effect.die("unused"),
    getIssueActivity: () => Effect.die("unused"),
    runAction: () => Effect.void,
    comment: () => Effect.void,
    create: () => Effect.succeed({ number: 1, url: "https://host/issues/1" }),
    update: () => Effect.void,
    setLabels: () => Effect.void,
    setAssignees: () => Effect.void,
    listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    listAssigneeCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<IssueAdapter>;
  readonly rateLimits?: SourceControlRateLimit.SourceControlRateLimit["Service"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
}) {
  return IssueService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        input.rateLimits === undefined
          ? SourceControlRateLimit.layer
          : Layer.succeed(SourceControlRateLimit.SourceControlRateLimit, input.rateLimits),
        Layer.effect(IssueProviderRegistry, fromProviders(input.providers)).pipe(
          Layer.provide(
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => Effect.die("unused"),
            }),
          ),
        ),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(input.projects),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: input.resolveRepositoryIdentity ?? (() => Effect.succeed(null)),
        }),
      ),
    ),
  );
}

function cursorKey(repository: string): string {
  return `github.com ${repository}`;
}

/** The reference every write test aims at, so a test body only says what it is about. */
const REFERENCE = { projectId: "p1" as ProjectId, repository: "acme/web", number: 7 };

const ONE_PROJECT = [
  project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
];

it.effect.each(["gitlab", "azure-devops", "bitbucket", "jira"] as const)(
  "shares %s cooldown across reads and writes while keeping cached answers",
  (kind) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const calls = { detail: 0, activity: 0, viewer: 0, list: 0, write: 0 };
      let limited = true;
      const provider = fakeProvider(kind, {
        getIssue: ({ number }) => {
          calls.detail++;
          return limited && number === 8
            ? Effect.fail(
                new IssueProviderError({
                  provider: kind,
                  operation: "getIssue",
                  reason: "rate-limited",
                  detail: "Quota exhausted.",
                  retryAt: 60_000,
                }),
              )
            : Effect.succeed(issueDetail(number, { viewer: "bilal" }));
        },
        getIssueActivity: () => {
          calls.activity++;
          return Effect.succeed({
            comments: [],
            commentCount: 0,
            commentsTruncated: false,
            events: [],
          });
        },
        getViewer: () => {
          calls.viewer++;
          return Effect.succeed("bilal");
        },
        listIssues: () => {
          calls.list++;
          return Effect.succeed({ items: [], truncated: false, continues: false });
        },
        create: () => {
          calls.write++;
          return Effect.succeed({ number: 9, url: "https://host/issues/9" });
        },
      });
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "web",
            workspaceRoot: "/a",
            repository: REFERENCE.repository,
            provider: kind,
            host: "tracker.test",
          }),
        ],
        providers: [provider],
      });
      const detail = yield* service.detail(REFERENCE);
      const activity = yield* service.activity(REFERENCE);
      const list = yield* service.list({ state: "open" });
      const failed = yield* service.detail({ ...REFERENCE, number: 8 }).pipe(Effect.flip);
      assert.instanceOf(failed.cause, IssueProviderError);
      assert.equal((failed.cause as IssueProviderError).retryAt, 60_000);
      assert.deepEqual(yield* service.detail(REFERENCE), detail);
      assert.deepEqual(yield* service.activity(REFERENCE), activity);
      assert.deepEqual(yield* service.list({ state: "open" }), list);
      for (const read of [
        service.detail({ ...REFERENCE, number: 9 }).pipe(Effect.asVoid),
        service.activity({ ...REFERENCE, number: 9 }).pipe(Effect.asVoid),
        service.summary({ ...REFERENCE, number: 9 }).pipe(Effect.asVoid),
      ]) {
        const error = yield* read.pipe(Effect.flip);
        assert.instanceOf(error.cause, IssueProviderError);
        assert.equal((error.cause as IssueProviderError).reason, "rate-limited");
        assert.equal((error.cause as IssueProviderError).retryAt, 60_000);
      }
      const blockedList = yield* service.list({ state: "closed" });
      assert.equal(blockedList.errors.length, 1);
      yield* service
        .create({ ...REFERENCE, title: "New issue", body: "", labels: [], assignees: [] })
        .pipe(Effect.flip);
      yield* TestClock.adjust("16 seconds");
      assert.deepEqual(yield* service.activity({ ...REFERENCE, number: 7 }), activity);
      yield* service.invalidate({ reference: REFERENCE });
      yield* service.detail(REFERENCE).pipe(Effect.flip);
      yield* service.invalidate({});
      const blockedViewer = yield* service.list({ state: "open" }).pipe(Effect.flip);
      assert.equal((blockedViewer.cause as IssueProviderError).operation, "getViewer");
      assert.deepEqual(calls, { detail: 2, activity: 1, viewer: 1, list: 1, write: 0 });
      yield* TestClock.adjust("44 seconds");
      limited = false;
      assert.equal((yield* service.detail({ ...REFERENCE, number: 8 })).number, 8);
      yield* service.list({ state: "open" });
      assert.deepEqual(calls, { detail: 3, activity: 1, viewer: 2, list: 2, write: 0 });
    }),
);

it.effect("isolates custom issue cooldowns by host and saved credential", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const service = yield* makeService({
      projects: ["p1", "p2", "p3"].map((id) => project({ id, title: id, workspaceRoot: `/${id}` })),
      providers: [
        fakeProvider("jira", {
          resolveSource: ({ id }) =>
            Effect.succeed({
              host: id === "p3" ? "other.test" : "jira.test",
              repository: "ENG",
              credentialId: id === "p2" ? "second" : "first",
            }),
          getIssue: ({ host, credentialId }) => {
            calls.push(`${host}:${credentialId}`);
            return host === "jira.test" && credentialId === "first"
              ? Effect.fail(
                  new IssueProviderError({
                    provider: "jira",
                    operation: "getIssue",
                    reason: "rate-limited",
                    detail: "Quota exhausted.",
                  }),
                )
              : Effect.succeed(issueDetail(7, { viewer: "bilal" }));
          },
        }),
      ],
    });
    const ref = { ...REFERENCE, repository: "ENG", provider: "jira" };
    yield* service.detail(ref).pipe(Effect.flip);
    yield* service.detail({ ...ref, projectId: "p2" as ProjectId });
    yield* service.detail({ ...ref, projectId: "p3" as ProjectId });
    yield* service.activity(ref).pipe(Effect.flip);
    assert.deepEqual(calls, ["jira.test:first", "jira.test:second", "other.test:first"]);
  }),
);

it.effect("shares cooldowns in both directions with the pull request service", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const limits = yield* SourceControlRateLimit.make;
    const shells = [
      project({
        id: "p1",
        title: "web",
        workspaceRoot: "/a",
        provider: "gitlab",
        repository: REFERENCE.repository,
      }),
    ];
    const calls = { issue: 0, pr: 0 };
    const issues = yield* makeService({
      projects: shells,
      rateLimits: limits,
      providers: [
        fakeProvider("gitlab", {
          getIssue: () => {
            calls.issue++;
            return Effect.fail(
              new IssueProviderError({
                provider: "gitlab",
                operation: "getIssue",
                reason: "rate-limited",
                detail: "Quota exhausted.",
              }),
            );
          },
        }),
      ],
    });
    const unused = () => Effect.die("unused");
    const prs = yield* PullRequestService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(SourceControlRateLimit.SourceControlRateLimit, limits),
          Layer.mock(ProjectService.ProjectService)({
            listShells: () => Effect.succeed(shells),
            getShell: () => Effect.succeedSome(shells[0]!),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: unused,
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(PullRequestFilesViewed.PullRequestFilesViewedRepository)({}),
          Layer.mock(PullRequestReadCache.PullRequestReadCache)({ get: (_key, read) => read }),
          Layer.mock(PullRequestProviderRegistry.PullRequestProviderRegistry)({
            kinds: ["gitlab"],
            get: () => ({
              kind: "gitlab",
              capabilities: {
                diff: false,
                comment: false,
                actions: [],
                mergeMethods: [],
                search: false,
                review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
                reviewers: { request: false, listCandidates: false },
              },
              getViewer: unused,
              listChangeRequests: unused,
              getChangeRequest: () =>
                Effect.suspend(() => {
                  calls.pr++;
                  return Effect.fail(
                    new PullRequestProviderError({
                      provider: "gitlab",
                      operation: "getChangeRequest",
                      reason: "rate-limited",
                      detail: "Quota exhausted.",
                    }),
                  );
                }),
              getChangeRequestActivity: unused,
              getViewerPermissions: unused,
              getDiff: unused,
              runAction: unused,
              comment: unused,
              submitReview: unused,
              listReviewerCandidates: unused,
              setReviewerRequest: unused,
              replyToThread: unused,
              setReaction: unused,
              setThreadResolution: unused,
            }),
          }),
        ),
      ),
    );
    yield* prs.summary(REFERENCE).pipe(Effect.flip);
    assert.deepEqual(calls, { issue: 0, pr: 1 });
    const sharedPause = yield* limits
      .check({ provider: "gitlab", host: "gitlab.com" })
      .pipe(Effect.flip);
    const issuePause = yield* issues.detail(REFERENCE).pipe(Effect.flip);
    assert.equal((issuePause.cause as IssueProviderError).retryAt, sharedPause.retryAt);
    assert.deepEqual(calls, { issue: 0, pr: 1 });
    yield* TestClock.setTime(sharedPause.retryAt);
    yield* issues.detail(REFERENCE).pipe(Effect.flip);
    const nextPause = yield* limits
      .check({ provider: "gitlab", host: "gitlab.com" })
      .pipe(Effect.flip);
    const prPause = yield* prs.summary({ ...REFERENCE, number: 8 }).pipe(Effect.flip);
    assert.equal((prPause.cause as PullRequestProviderError).retryAt, nextPause.retryAt);
    assert.isAbove(nextPause.retryAt, sharedPause.retryAt);
    assert.deepEqual(calls, { issue: 1, pr: 1 });
  }),
);

it.effect("records a rate-limited issue write and blocks later reads", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("jira", {
          resolveSource: () =>
            Effect.succeed({ host: "jira.test", repository: REFERENCE.repository }),
          updateComment: () => {
            calls.push("write");
            return Effect.fail(
              new IssueProviderError({
                provider: "jira",
                operation: "updateComment",
                reason: "rate-limited",
                detail: "Quota exhausted.",
              }),
            );
          },
          getIssue: () => {
            calls.push("read");
            return Effect.succeed(issueDetail(7));
          },
        }),
      ],
    });
    const ref = { ...REFERENCE, provider: "jira" };
    yield* service.updateComment({ ...ref, commentId: "1", body: "Updated" }).pipe(Effect.flip);
    yield* service.detail(ref).pipe(Effect.flip);
    yield* service.updateComment({ ...ref, commentId: "2", body: "Updated" }).pipe(Effect.flip);
    assert.deepEqual(calls, ["write"]);
  }),
);

it.effect("pins custom adapter cooldowns to each verified credential in list reads", () =>
  Effect.gen(function* () {
    let fingerprint = "first";
    const calls: string[] = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a" })],
      providers: [
        fakeProvider("jira", {
          resolveSource: () => Effect.succeed({ host: "jira.test", repository: "ENG" }),
          withCredential: (_host, read) => read(fingerprint),
          getIssue: () => {
            calls.push(`detail:${fingerprint}`);
            return fingerprint === "first"
              ? Effect.fail(
                  new IssueProviderError({
                    provider: "jira",
                    operation: "getIssue",
                    reason: "rate-limited",
                    detail: "Quota exhausted.",
                  }),
                )
              : Effect.succeed(issueDetail(7, { viewer: "bilal" }));
          },
          getViewer: () => {
            calls.push(`viewer:${fingerprint}`);
            return Effect.succeed("bilal");
          },
          listIssues: () => {
            calls.push(`list:${fingerprint}`);
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });
    const ref = { ...REFERENCE, repository: "ENG", provider: "jira" };
    yield* service.detail(ref).pipe(Effect.flip);
    yield* service.list({ state: "open" }).pipe(Effect.flip);
    fingerprint = "second";
    yield* service.detail(ref);
    yield* service.list({ state: "open" });
    fingerprint = "first";
    yield* service.detail({ ...ref, number: 8 }).pipe(Effect.flip);
    yield* service.list({ state: "closed" }).pipe(Effect.flip);
    assert.deepEqual(calls, ["detail:first", "detail:second", "viewer:second", "list:second"]);
  }),
);

it.effect("keeps a concurrent issue success from clearing an active cooldown", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("jira", {
          resolveSource: () =>
            Effect.succeed({ host: "jira.test", repository: REFERENCE.repository }),
          getIssue: ({ number }) => {
            calls++;
            return number === 7
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(issueDetail(7, { viewer: "bilal" })),
                )
              : Effect.fail(
                  new IssueProviderError({
                    provider: "jira",
                    operation: "getIssue",
                    reason: "rate-limited",
                    detail: "Quota exhausted.",
                  }),
                );
          },
        }),
      ],
    });
    const ref = { ...REFERENCE, provider: "jira" };
    const pending = yield* service.detail(ref).pipe(Effect.forkChild());
    yield* Deferred.await(started);
    yield* service.detail({ ...ref, number: 8 }).pipe(Effect.flip);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    yield* service.detail({ ...ref, number: 9 }).pipe(Effect.flip);
    assert.equal(calls, 2);
  }),
);

it.effect("routes tracker operations through the requested adapter and preserves failures", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const failure = new IssueTrackingError({ operation: "disconnect", detail: "Unavailable" });
    const connection = {
      status: "unauthenticated" as const,
      hasStoredToken: false,
      accountName: null,
      accountEmail: null,
      projects: [],
      accounts: [],
    };
    const service = yield* makeService({
      projects: [],
      providers: [
        fakeProvider("jira", {
          tracker: {
            status: Effect.succeed(connection),
            connect: (token) =>
              Effect.sync(() => {
                calls.push(token);
                return connection;
              }),
            disconnect: () => Effect.fail(failure),
            bind: (input) =>
              Effect.sync(() => {
                calls.push(input);
              }),
          },
        }),
      ],
    });
    assert.deepStrictEqual(yield* service.trackerStatus({ provider: "jira" }), connection);
    assert.deepStrictEqual(
      yield* service.trackerConnect({ provider: "jira", token: "test-token" }),
      connection,
    );
    const binding = { provider: "jira", projectId: REFERENCE.projectId, binding: null };
    yield* service.trackerBind(binding);
    assert.deepStrictEqual(calls, ["test-token", binding]);
    assert.strictEqual(
      yield* service.trackerDisconnect({ provider: "jira", credentialId: "id" }).pipe(Effect.flip),
      failure,
    );
    const unsupported = yield* service
      .trackerConnect({ provider: "github", token: "test-token" })
      .pipe(Effect.flip);
    assert.strictEqual(unsupported.operation, "connect");
    assert.include(unsupported.detail, "not supported");
  }),
);

it.effect("keeps a cached read from bypassing the requested host", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: ({ host }) => {
            assert.equal(host, "github.com");
            reads += 1;
            return Effect.succeed(issueDetail(7));
          },
        }),
      ],
    });
    yield* service.detail(REFERENCE);
    const error = yield* service
      .detail({
        ...REFERENCE,
        provider: "github",
        host: "github.enterprise.test",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "IssueOperationError");
    assert.equal(reads, 1);
    yield* service.detail({ ...REFERENCE, provider: "github", host: "GITHUB.COM" });
    assert.equal(reads, 2);
    yield* service.detail({ ...REFERENCE, provider: "github", host: "github.com" });
    assert.equal(reads, 2);
  }),
);

/** The two writes whose capability and permission refusals are checked as a pair. */
const labelling = (service: IssueService.IssueService["Service"]) =>
  service.setLabels({ ...REFERENCE, labels: ["bug"] });

const assigning = (service: IssueService.IssueService["Service"]) =>
  service.setAssignees({ ...REFERENCE, assignees: ["bilal"] });

it.effect("resolves a cold project shell before its first issue listing", () =>
  Effect.gen(function* () {
    const hydrated = project({
      id: "p1",
      title: "web",
      workspaceRoot: "/a",
      repository: "acme/web",
      host: "github.acme.dev",
    });
    const resolved: string[] = [];
    let listCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a" })],
      resolveRepositoryIdentity: (cwd) => {
        resolved.push(cwd);
        return Effect.succeed(hydrated.repositoryIdentity ?? null);
      },
      providers: [
        fakeProvider("github", {
          resolveSource: (candidate) => {
            assert.strictEqual(candidate.repositoryIdentity, hydrated.repositoryIdentity);
            return Effect.succeed(null);
          },
          getViewer: ({ host }) => {
            assert.strictEqual(host, "github.acme.dev");
            return Effect.succeed("enterprise-user");
          },
          listIssues: ({ cwd, repository, host, viewer }) => {
            listCalls += 1;
            assert.deepStrictEqual(
              [cwd, repository, host, viewer],
              ["/a", "acme/web", "github.acme.dev", "enterprise-user"],
            );
            return Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(resolved, ["/a"]);
    assert.strictEqual(listCalls, 1);
    assert.deepStrictEqual(
      result.entries.map(({ projectId, provider, host, repository, number }) => [
        projectId,
        provider,
        host,
        repository,
        number,
      ]),
      [["p1", "github", "github.acme.dev", "acme/web", 7]],
    );
    assert.strictEqual(result.providers[0]?.projectCount, 1);
  }),
);

it.effect("resolves a cold project shell before its first issue detail", () =>
  Effect.gen(function* () {
    const hydrated = project({
      id: "p1",
      title: "web",
      workspaceRoot: "/a",
      repository: "group/sub/project",
      provider: "gitlab",
      host: "gitlab.acme.dev",
    });
    const resolved: string[] = [];
    let detailCalls = 0;
    const service = yield* makeService({
      projects: [{ ...hydrated, repositoryIdentity: null }],
      resolveRepositoryIdentity: (cwd) => {
        resolved.push(cwd);
        return Effect.succeed(hydrated.repositoryIdentity ?? null);
      },
      providers: [
        fakeProvider("gitlab", {
          getIssue: (input) => {
            detailCalls += 1;
            assert.deepStrictEqual(input, {
              cwd: "/a",
              repository: "group/sub/project",
              host: "gitlab.acme.dev",
              number: 7,
            });
            return Effect.succeed(issueDetail(7));
          },
        }),
      ],
    });

    const result = yield* service.detail({
      ...REFERENCE,
      provider: "gitlab",
      repository: "GROUP/SUB/PROJECT",
    });

    assert.deepStrictEqual(resolved, ["/a"]);
    assert.strictEqual(detailCalls, 1);
    assert.deepStrictEqual(
      [result.projectId, result.provider, result.repository, result.number],
      ["p1", "gitlab", "group/sub/project", 7],
    );
  }),
);

it.effect("preserves a hydrated project identity without resolving it again", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      resolveRepositoryIdentity: () => Effect.die("must not resolve a hydrated identity"),
      providers: [
        fakeProvider("github", {
          resolveSource: (candidate) => {
            assert.strictEqual(candidate.repositoryIdentity, ONE_PROJECT[0]!.repositoryIdentity);
            return Effect.succeed(null);
          },
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: false,
            }),
          getIssue: () => Effect.succeed(issueDetail(7)),
        }),
      ],
    });

    assert.strictEqual((yield* service.list({ state: "open" })).entries[0]?.repository, "acme/web");
    assert.strictEqual((yield* service.detail(REFERENCE)).repository, "acme/web");
  }),
);

it.effect("puts every host's issues on one page, newest update first", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/sub/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) =>
            Effect.succeed({
              items:
                repository === "acme/web"
                  ? [issue(1, "2026-07-02T00:00:00Z")]
                  : [issue(2, "2026-07-05T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
        fakeProvider("gitlab", {
          listIssues: ({ repository }) =>
            // Nested groups need the full path, not the last two segments.
            repository === "group/sub/project"
              ? Effect.succeed({
                  items: [issue(3, "2026-07-04T00:00:00Z")],
                  truncated: false,
                  continues: true,
                })
              : Effect.die("wrong repository identity"),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.projectId, entry.number]),
      [
        ["p2", 2],
        ["p3", 3],
        ["p1", 1],
      ],
    );
  }),
);

it.effect("keeps a row already sent at the boundary instant from arriving twice", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // The boundary instant is asked for inclusively, so the host hands back the rows
          // already sent at it alongside the ones beside them — which a strictly-older read
          // would have lost instead.
          listIssues: (input) => {
            assert.deepStrictEqual(input.cursor, {
              updatedBefore: "2026-07-02T00:00:00Z",
              seenAt: [7],
            });
            return Effect.succeed({
              items: [
                issue(7, "2026-07-02T00:00:00Z"),
                issue(8, "2026-07-02T00:00:00Z"),
                issue(9, "2026-07-01T00:00:00Z"),
              ],
              truncated: true,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|1|7" },
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [8, 9],
    );
    // The cursor sent in still carries the row count no host pages by any more, and is taken as it
    // stands; the one handed back writes that field out as zero.
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-01T00:00:00Z|0|9",
    });
  }),
);

it.effect("keeps the earlier exclusions when a slice ends on the instant it began on", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z"), issue(8, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|1|6" },
    });

    // A triage afternoon puts a whole slice inside one second. The next read has to keep
    // excluding 6 as well as the two just sent, or it hands 6 over again.
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [7, 8],
    );
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|0|6,7,8",
    });
  }),
);

it.effect.each([
  ["repository", 600, 100_000],
  ["grouped", 600, 100_000],
  ["repository", 1000, 100_000_000],
  ["grouped", 1000, 100_000_000],
] as const)("round-trips a large %s continuation with %i tied issues", ([mode, count, start]) =>
  Effect.gen(function* () {
    const boundary = "2026-07-02T00:00:00Z";
    const numbers = Array.from({ length: count }, (_, index) => start + index);
    const rows = numbers.map((number) => batchedIssue(number, "acme/web", boundary));
    let calls = 0;
    const read = (cursor: ProviderListCursor | undefined) => {
      calls++;
      if (calls === 1) {
        assert.isUndefined(cursor);
        return Effect.succeed({ items: rows, truncated: true, continues: true });
      }
      assert.strictEqual(cursor?.updatedBefore, boundary);
      assert.deepStrictEqual(
        mode === "grouped" ? cursor?.seenAtByRepository?.["acme/web"] : cursor?.seenAt,
        calls === 2 ? numbers : [...numbers, start + count],
      );
      return Effect.succeed({
        items: [
          rows[0]!,
          batchedIssue(start + count, "acme/web", boundary),
          ...(calls === 2
            ? []
            : [batchedIssue(start + count + 1, "acme/web", "2026-07-01T00:00:00Z")]),
        ],
        truncated: true,
        continues: true,
      });
    };
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: ({ cursor }) => read(cursor),
          ...(mode === "grouped" ? { listIssuesAcross: ({ cursor }) => read(cursor) } : {}),
        }),
      ],
    });
    const outputCodec = Schema.toCodecJson(IssueListResult);
    const result = yield* service.list({ state: "open", limit: 99 });
    assert.isAbove(result.nextCursors[cursorKey("acme/web")]!.length, 4096);
    const first = yield* Schema.decodeUnknownEffect(outputCodec)(
      yield* Schema.encodeUnknownEffect(outputCodec)(result),
    );
    assert.deepStrictEqual(first, result);
    assert.isUndefined(first.cursorLimitReached);
    assert.deepStrictEqual(first.entries.map((entry) => entry.number).toSorted(), numbers);
    const inputCodec = Schema.toCodecJson(IssueListInput);
    const input = yield* Schema.decodeUnknownEffect(inputCodec)(
      yield* Schema.encodeUnknownEffect(inputCodec)({
        state: "open",
        limit: 99,
        cursors: first.nextCursors,
      }),
    );
    const second = yield* Schema.decodeUnknownEffect(outputCodec)(
      yield* Schema.encodeUnknownEffect(outputCodec)(yield* service.list(input)),
    );
    assert.deepStrictEqual(
      second.entries.map((entry) => entry.number),
      [start + count],
    );
    assert.deepStrictEqual(second.nextCursors, {
      [cursorKey("acme/web")]: `${boundary}|0|${[...numbers, start + count].join(",")}`,
    });
    const continuation = yield* Schema.decodeUnknownEffect(inputCodec)(
      yield* Schema.encodeUnknownEffect(inputCodec)({
        state: "open",
        limit: 99,
        cursors: second.nextCursors,
      }),
    );
    const third = yield* Schema.decodeUnknownEffect(outputCodec)(
      yield* Schema.encodeUnknownEffect(outputCodec)(yield* service.list(continuation)),
    );
    assert.deepStrictEqual(
      third.entries.map((entry) => entry.number),
      [start + count + 1],
    );
    assert.deepStrictEqual(third.nextCursors, {
      [cursorKey("acme/web")]: `2026-07-01T00:00:00Z|0|${start + count + 1}`,
    });
    assert.strictEqual(calls, 3);
  }),
);

it.effect.each(["repository", "grouped"] as const)(
  "reports a truncated %s page when its complete continuation exceeds the wire bound",
  (mode) =>
    Effect.gen(function* () {
      const boundary = "2026-07-02T00:00:00Z";
      const numbers = Array.from({ length: 1636 }, (_, index) => 100_000_000 + index);
      const read = (cursor: ProviderListCursor | undefined) => {
        assert.deepStrictEqual(
          mode === "grouped" ? cursor?.seenAtByRepository?.["acme/web"] : cursor?.seenAt,
          numbers,
        );
        return Effect.succeed({
          items: [
            batchedIssue(numbers[0]!, "acme/web", boundary),
            batchedIssue(200_000_000, "acme/web", boundary),
          ],
          truncated: true,
          continues: true,
        });
      };
      const service = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            listIssues: ({ cursor }) => read(cursor),
            ...(mode === "grouped" ? { listIssuesAcross: ({ cursor }) => read(cursor) } : {}),
          }),
        ],
      });
      const inputCodec = Schema.toCodecJson(IssueListInput);
      const input = yield* Schema.decodeUnknownEffect(inputCodec)(
        yield* Schema.encodeUnknownEffect(inputCodec)({
          state: "open",
          cursors: { [cursorKey("acme/web")]: `${boundary}|0|${numbers.join(",")}` },
        }),
      );
      const outputCodec = Schema.toCodecJson(IssueListResult);
      const result = yield* Schema.decodeUnknownEffect(outputCodec)(
        yield* Schema.encodeUnknownEffect(outputCodec)(yield* service.list(input)),
      );
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.number),
        [200_000_000],
      );
      assert.isTrue(result.truncated);
      assert.isTrue(result.cursorLimitReached);
      assert.deepStrictEqual(result.nextCursors, {});
    }),
);

it.effect("carries on from a slice that was nothing but rows it had already sent", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|1|7" },
    });

    // Nothing survived de-duplication, and reading that as "nothing left" would strand every
    // older row for good.
    assert.deepStrictEqual(result.entries, []);
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-02T00:00:00Z|0|7",
    });
  }),
);

it.effect("keeps other repositories paging when one complete cursor exceeds its bound", () =>
  Effect.gen(function* () {
    const boundary = "2026-07-02T00:00:00Z";
    const numbers = Array.from({ length: 1636 }, (_, index) => 100_000_000 + index);
    let calls = 0;
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: () => Effect.die("must use grouped continuation"),
          listIssuesAcross: ({ repositories, cursor }) => {
            calls++;
            if (calls === 1) {
              assert.deepStrictEqual(cursor?.seenAtByRepository, {
                "acme/web": numbers,
                "acme/api": [7],
              });
              return Effect.succeed({
                items: [
                  batchedIssue(200_000_000, "acme/web", boundary),
                  batchedIssue(8, "acme/api", boundary),
                ],
                truncated: true,
              });
            }
            assert.deepStrictEqual(repositories, ["acme/api"]);
            assert.deepStrictEqual(cursor?.seenAtByRepository, { "acme/api": [7, 8] });
            return Effect.succeed({
              items: [batchedIssue(9, "acme/api", "2026-07-01T00:00:00Z")],
              truncated: false,
            });
          },
        }),
      ],
    });
    const first = yield* service.list({
      state: "open",
      cursors: {
        [cursorKey("acme/web")]: `${boundary}|0|${numbers.join(",")}`,
        [cursorKey("acme/api")]: `${boundary}|0|7`,
      },
    });
    assert.isTrue(first.cursorLimitReached);
    assert.isTrue(first.truncated);
    assert.deepStrictEqual(first.nextCursors, { [cursorKey("acme/api")]: `${boundary}|0|7,8` });
    const second = yield* service.list({ state: "open", cursors: first.nextCursors });
    assert.deepStrictEqual(
      second.entries.map((entry) => entry.number),
      [9],
    );
    assert.isUndefined(second.cursorLimitReached);
    assert.isFalse(second.truncated);
    assert.deepStrictEqual(second.nextCursors, {});
    assert.strictEqual(calls, 2);
  }),
);

it.effect("refuses a continuation it did not issue, before asking any host anything", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github", { listIssues: () => Effect.die("should not be read") })],
    });

    const error = yield* Effect.flip(
      service.list({ state: "open", cursors: { [cursorKey("acme/web")]: "yesterday" } }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
  }),
);

it.effect("keeps a host listing when one of its repositories has the tracker switched off", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) =>
            repository === "acme/web"
              ? Effect.fail(trackerDisabled)
              : Effect.succeed({
                  items: [issue(2, "2026-07-05T00:00:00Z")],
                  truncated: false,
                  continues: true,
                }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // One repository's setting is not a dead host: saying so would hide every other repository
    // on the account.
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2],
    );
    assert.deepStrictEqual(result.errors, [
      {
        projectId: "p1" as ProjectId,
        projectTitle: "web",
        message: "Issue tracker is switched off for acme/web.",
      },
    ]);
    assert.deepStrictEqual(
      result.providers.map((summary) => [summary.host, summary.configured]),
      [["github.com", true]],
    );
  }),
);

it.effect("says what a host whose tool is missing needs before it can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
        fakeProvider("gitlab", {
          getViewer: () => Effect.fail(unusable("gitlab", "missing-tool")),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.provider),
      ["github"],
    );
    const gitlab = result.providers.find((summary) => summary.kind === "gitlab");
    assert.strictEqual(gitlab?.configured, false);
    // The fix rather than whatever the tool printed: "gitlab is not usable" names no next step.
    assert.strictEqual(
      gitlab?.detail,
      "GitLab CLI (`glab`) is required to browse issues on this host. Install it from https://gitlab.com/gitlab-org/cli and reload.",
    );
  }),
);

it.effect("says what a host with an unauthenticated tool needs before it can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/b",
          repository: "acme/api",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: ({ cwd }) =>
            cwd === "/a"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable("github", "unauthenticated")),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    const enterprise = result.providers.find((summary) => summary.host === "github.acme.dev");
    assert.strictEqual(enterprise?.configured, false);
    assert.strictEqual(enterprise?.detail, "github is not usable.");
    // Its repositories are named rather than dropped, so "N unavailable" stays honest.
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectId),
      ["p2"],
    );
  }),
);

it.effect("reports a host with no implementation rather than dropping its projects", () =>
  Effect.gen(function* () {
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "notes", workspaceRoot: "/b" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
        project({
          id: "p4",
          title: "also on gitlab",
          workspaceRoot: "/d",
          repository: "group/other",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) => {
            listed.push(repository);
            return Effect.succeed({
              items: [issue(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(listed, ["acme/web"]);
    assert.deepStrictEqual(
      result.providers.map((summary) => [
        summary.host,
        summary.kind,
        summary.configured,
        summary.projectCount,
        summary.detail,
      ]),
      [
        ["github.com", "github", true, 1, null],
        ["gitlab.com", "gitlab", false, 2, "This host cannot be browsed here yet."],
      ],
    );
  }),
);

it.effect("fails as unavailable only when no host this request covers can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.fail(unusable("github", "missing-tool")),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    assert.strictEqual(error._tag, "IssueUnavailableError");
    assert.strictEqual(error._tag === "IssueUnavailableError" ? error.reason : null, "cli-missing");
  }),
);

it.effect("asks each host for the account signed in on that host, not on another", () =>
  Effect.gen(function* () {
    const asked: Array<[string, string, string]> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/enterprise",
          // The same path on a different host: neither the account nor the row may be shared.
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: ({ cwd }) => Effect.succeed(cwd === "/cloud" ? "bilal" : "b.hassan"),
          listIssues: ({ host, viewer, involvement }) => {
            asked.push([host, viewer, involvement]);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open", involvement: "assigned" });

    assert.deepStrictEqual(asked.toSorted(), [
      ["github.acme.dev", "b.hassan", "assigned"],
      ["github.com", "bilal", "assigned"],
    ]);
    assert.deepStrictEqual(result.viewers, {
      [issueSourceKey("github", "github.com")]: "bilal",
      [issueSourceKey("github", "github.acme.dev")]: "b.hassan",
      [issueProjectSourceKey("github", "github.com", "p1" as ProjectId)]: "bilal",
      [issueProjectSourceKey("github", "github.acme.dev", "p2" as ProjectId)]: "b.hassan",
    });
  }),
);

it.effect("keeps adapters separate when they share a host and repository name", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "source",
          workspaceRoot: "/source",
          repository: "acme/web",
          host: "tracker.example.test",
        }),
        project({ id: "p2", title: "planning", workspaceRoot: "/planning" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.succeed("octocat"),
          listIssues: ({ viewer }) => {
            asked.push(`github:${viewer}`);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
        fakeProvider("jira", {
          getIssue: () =>
            Effect.succeed(
              issueDetail(7, { repositoryUrl: "https://tracker.example.test/acme/web" }),
            ),
          capabilities: {
            ...FULL_CAPABILITIES,
            referenceStyle: "key-number",
            sorts: ["created"],
            closesViaPullRequest: false,
          },
          resolveSource: (candidate) =>
            Effect.succeed(
              candidate.id === "p2"
                ? { host: "tracker.example.test", repository: "acme/web" }
                : null,
            ),
          getViewer: () => Effect.succeed("jira-user"),
          listIssues: ({ viewer }) => {
            asked.push(`jira:${viewer}`);
            return Effect.succeed({
              items: [issue(7, "2026-07-01T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(result.providers.map(({ kind }) => kind).toSorted(), ["github", "jira"]);
    assert.deepStrictEqual(asked.toSorted(), ["github:octocat", "jira:jira-user"]);
    assert.strictEqual(result.entries[0]?.referenceStyle, "key-number");
    assert.deepStrictEqual(result.providers.find(({ kind }) => kind === "jira")?.sorts, [
      "created",
    ]);
    const detail = yield* service.detail({
      projectId: "p2" as ProjectId,
      provider: "jira",
      repository: "acme/web",
      number: 7,
    });
    assert.isFalse(detail.capabilities.closesViaPullRequest);
    assert.strictEqual(detail.repositoryUrl, "https://tracker.example.test/acme/web");
  }),
);

it.effect("routes each repository on one project through its matching adapter", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("linear", {
          resolveSource: () =>
            Effect.succeed({
              host: "linear.app",
              repository: REFERENCE.repository,
              credentialId: "user-1",
            }),
          getIssue: ({ repository }) => {
            asked.push(`linear:${repository}`);
            return Effect.succeed(issueDetail(7, { title: "Linear issue" }));
          },
        }),
        fakeProvider("github", {
          getIssue: ({ repository }) => {
            asked.push(`github:${repository}`);
            return Effect.succeed(issueDetail(7, { title: "GitHub issue" }));
          },
        }),
      ],
    });

    const linear = yield* service.detail({ ...REFERENCE, provider: "linear" });
    const github = yield* service.detail({ ...REFERENCE, provider: "github" });

    assert.strictEqual(linear.title, "Linear issue");
    assert.strictEqual(github.title, "GitHub issue");
    assert.deepStrictEqual(asked, ["linear:acme/web", "github:acme/web"]);
  }),
);

it.effect("keeps a project available when one of its issue sources is unreadable", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("linear", {
          resolveSource: () =>
            Effect.succeed({ host: "linear.app", repository: "ENG", credentialId: "user-1" }),
          getViewer: () => Effect.fail(unusable("linear", "unauthenticated")),
        }),
        fakeProvider("github", {
          listIssues: () =>
            Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const listed = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      listed.entries.map(({ provider }) => provider),
      ["github"],
    );
    assert.deepStrictEqual(listed.errors, []);
  }),
);

it.effect("routes projects on one host through distinct credential viewers", () =>
  Effect.gen(function* () {
    const viewers: Array<string | undefined> = [];
    const listings: Array<[string | undefined, string]> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/api" }),
      ],
      providers: [
        fakeProvider("linear", {
          resolveSource: (candidate) =>
            Effect.succeed({
              host: "linear.app",
              repository: candidate.id === "p1" ? "ENG" : "OPS",
              credentialId: candidate.id === "p1" ? "user-1" : "user-2",
            }),
          getViewer: (input: { readonly credentialId?: string }) => {
            viewers.push(input.credentialId);
            return Effect.succeed(input.credentialId ?? "missing");
          },
          listIssues: (input: { readonly credentialId?: string; readonly repository: string }) => {
            listings.push([input.credentialId, input.repository]);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(viewers.toSorted(), ["user-1", "user-2"]);
    assert.deepStrictEqual(listings.toSorted(), [
      ["user-1", "ENG"],
      ["user-2", "OPS"],
    ]);
    assert.strictEqual(
      result.viewers[issueProjectSourceKey("linear", "linear.app", "p1" as ProjectId)],
      "user-1",
    );
    assert.strictEqual(
      result.viewers[issueProjectSourceKey("linear", "linear.app", "p2" as ProjectId)],
      "user-2",
    );
    assert.strictEqual(result.providers.length, 1);
    assert.strictEqual(result.providers[0]?.projectCount, 2);
  }),
);

it.effect.each(["assigned", "authored"] as const)(
  "rebuilds project viewers after a selected-project %s listing",
  (involvement) =>
    Effect.gen(function* () {
      const asked: Array<[string, string]> = [];
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/web" }),
          project({ id: "p2", title: "api", workspaceRoot: "/api" }),
          project({ id: "p3", title: "mobile", workspaceRoot: "/mobile" }),
        ],
        providers: [
          fakeProvider("linear", {
            resolveSource: (candidate) =>
              Effect.succeed({
                host: "linear.app",
                repository: candidate.id.toUpperCase(),
                credentialId: candidate.id === "p2" ? "user-2" : "user-1",
              }),
            getViewer: ({ credentialId }) => Effect.succeed(credentialId!),
            listIssues: ({ repository, viewer }) => {
              asked.push([repository, viewer]);
              return Effect.succeed({
                items: [
                  {
                    ...issue(7, "2026-07-02T00:00:00Z"),
                    author: { login: viewer, name: null, avatarUrl: null },
                    assignees: [{ login: viewer, name: null, avatarUrl: null }],
                  },
                ],
                truncated: false,
                continues: true,
              });
            },
          }),
        ],
      });
      yield* service.list({ state: "open", involvement, projectId: "p1" as ProjectId });
      const otherProject = yield* service.list({
        state: "open",
        involvement,
        projectId: "p3" as ProjectId,
      });
      assert.strictEqual(
        otherProject.viewers[issueProjectSourceKey("linear", "linear.app", "p3" as ProjectId)],
        "user-1",
      );
      const result = yield* service.list({ state: "open", involvement });
      assert.deepStrictEqual(result.entries.map(({ projectId }) => projectId).toSorted(), [
        "p1",
        "p2",
        "p3",
      ]);
      for (const [projectId, viewer] of [
        ["p1", "user-1"],
        ["p2", "user-2"],
        ["p3", "user-1"],
      ] as const) {
        assert.strictEqual(
          result.viewers[issueProjectSourceKey("linear", "linear.app", projectId as ProjectId)],
          viewer,
        );
      }
      assert.deepStrictEqual(asked.slice(2).toSorted(), [
        ["P1", "user-1"],
        ["P2", "user-2"],
        ["P3", "user-1"],
      ]);
    }),
);

it.effect.each([false, true])(
  "separates cached Linear reads after a same-team account switch, tracker mutation: %s",
  (throughTracker) =>
    Effect.gen(function* () {
      let credentialId = "user-1";
      const reads: string[] = [];
      const connected = {
        status: "authenticated" as const,
        hasStoredToken: true,
        accountName: null,
        accountEmail: null,
        projects: [],
        accounts: [],
      };
      const service = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("linear", {
            resolveSource: () =>
              Effect.succeed({ host: "linear.app", repository: "ENG", credentialId }),
            getViewer: ({ credentialId }) => Effect.succeed(credentialId!),
            getIssue: ({ credentialId }) => {
              reads.push(`detail:${credentialId}`);
              return Effect.succeed(
                issueDetail(7, { title: credentialId!, viewer: credentialId! }),
              );
            },
            listIssues: ({ credentialId }) => {
              reads.push(`list:${credentialId}`);
              return Effect.succeed({
                items: [{ ...issue(7, "2026-07-02T00:00:00Z"), title: credentialId! }],
                truncated: false,
                continues: true,
              });
            },
            tracker: {
              status: Effect.succeed(connected),
              connect: () => Effect.succeed(connected),
              disconnect: () => Effect.succeed(connected),
              bind: (input) =>
                Effect.sync(() => {
                  credentialId = input.binding!.credentialId!;
                }),
            },
          }),
        ],
      });
      const reference = { ...REFERENCE, provider: "linear", repository: "ENG" };
      for (const next of ["user-1", "user-2", "user-1"]) {
        if (throughTracker) {
          yield* service.trackerBind({
            provider: "linear",
            projectId: REFERENCE.projectId,
            binding: { repository: "ENG", credentialId: next },
          });
        } else {
          credentialId = next;
        }
        assert.strictEqual((yield* service.detail(reference)).title, next);
        assert.strictEqual((yield* service.list({ state: "open" })).entries[0]?.title, next);
      }
      assert.deepStrictEqual(
        reads,
        throughTracker
          ? [
              "detail:user-1",
              "list:user-1",
              "detail:user-2",
              "list:user-2",
              "detail:user-1",
              "list:user-1",
            ]
          : ["detail:user-1", "list:user-1", "detail:user-2", "list:user-2"],
      );
    }),
);

it.effect("pauses GitLab detail reads after a template quota failure", () =>
  Effect.gen(function* () {
    const provider = yield* GitLabIssueProvider.make.pipe(
      Effect.provide(
        Layer.mock(GitLabIssueCli.GitLabIssueCli)({
          listIssueTemplates: () =>
            Effect.fail(
              new GitLabCli.GitLabCliRateLimitError({
                operation: "execute",
                command: "glab",
                cwd: "/web",
                cause: "429",
              }),
            ),
          getIssueDetail: () => Effect.die("detail must not reach the CLI during cooldown"),
        }),
      ),
    );
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/web",
          provider: "gitlab",
          repository: REFERENCE.repository,
        }),
      ],
      providers: [provider],
    });
    const templateError = yield* service.templates(REFERENCE).pipe(Effect.flip);
    const detailError = yield* service.detail(REFERENCE).pipe(Effect.flip);
    assert.strictEqual((templateError.cause as IssueProviderError).reason, "rate-limited");
    assert.strictEqual((detailError.cause as IssueProviderError).reason, "rate-limited");
  }),
);

it.effect("keeps separate cursors for accounts that use the same Linear team", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/web" }),
        project({ id: "p2", title: "api", workspaceRoot: "/api" }),
      ],
      providers: [
        fakeProvider("linear", {
          resolveSource: (candidate) =>
            Effect.succeed({
              host: "linear.app",
              repository: "ENG",
              credentialId: candidate.id === "p1" ? "user-1" : "user-2",
            }),
          getViewer: ({ credentialId }: { readonly credentialId?: string }) =>
            Effect.succeed(credentialId ?? "missing"),
          listIssues: ({ credentialId }: { readonly credentialId?: string }) =>
            Effect.succeed({
              items: [issue(credentialId === "user-1" ? 1 : 2, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(Object.keys(result.nextCursors).toSorted(), [
      '["linear","linear.app","eng","user-1"]',
      '["linear","linear.app","eng","user-2"]',
    ]);
  }),
);

it.effect("hands each involvement the reader picked straight to the host", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: ({ involvement }) => {
            asked.push(involvement);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.list({ state: "open", involvement: "assigned" });
    yield* service.list({ state: "open", involvement: "authored" });
    yield* service.list({ state: "open", involvement: "mentioned" });

    // Narrowing happens on the host, because a listing only ever holds a page per repository.
    assert.deepStrictEqual(asked, ["all", "assigned", "authored", "mentioned"]);
  }),
);

it.effect("refuses a repository that does not belong to the requested project", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github", { getIssue: () => Effect.die("must not be called") })],
    });

    const error = yield* Effect.flip(
      service.detail({ projectId: "p1" as ProjectId, repository: "attacker/repo", number: 7 }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "The issue does not belong to the selected project.");
  }),
);

it.effect("carries the change requests a host links to an issue through to the detail", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () =>
            Effect.succeed(
              issueDetail(7, {
                linkedPullRequests: [
                  {
                    repository: "acme/web",
                    number: 42,
                    title: "Fix the thing",
                    url: "https://host/pull/42",
                    state: "open",
                    isDraft: false,
                    closesIssue: true,
                  },
                ],
              }),
            ),
        }),
      ],
    });

    const result = yield* service.detail(REFERENCE);

    assert.deepStrictEqual(
      result.linkedPullRequests.map((link) => [link.number, link.closesIssue]),
      [[42, true]],
    );
    assert.strictEqual(result.workspaceRoot, "/a");
  }),
);

it.effect("carries the signed-in account through to issue detail", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.succeed("bilal"),
          getIssue: () => Effect.succeed(issueDetail(7)),
        }),
      ],
    });

    const result = yield* service.detail(REFERENCE);

    assert.strictEqual(result.viewer, "bilal");
  }),
);

it.effect("refuses an action the host never claimed it could run", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // A host that can close an issue but has no way to bring it back.
          capabilities: { ...FULL_CAPABILITIES, actions: ["close"] },
          getViewerPermissions: () => Effect.die("must not be asked"),
          runAction: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.runAction({ ...REFERENCE, action: "reopen" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot reopen an issue.");
  }),
);

it.effect("refuses a close reason the host never said it records", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // Everywhere but GitHub, a closed issue simply has no reason to report.
          capabilities: { ...FULL_CAPABILITIES, closeReasons: [] },
          runAction: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.runAction({ ...REFERENCE, action: "close", reason: "not-planned" }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host does not record why an issue was closed.");
  }),
);

it.effect("refuses an action this viewer may not take, and says what access it takes", () =>
  Effect.gen(function* () {
    let ran: string | null = null;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          // A reader who opened this issue: theirs to close, nobody else's to reopen.
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, actions: ["close"] }),
          runAction: ({ action }) => {
            ran = action;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(service.runAction({ ...REFERENCE, action: "reopen" }));
    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(
      error.message,
      "You need write access on this repository, or to have opened this issue, to reopen it.",
    );
    assert.strictEqual(ran, null);

    yield* service.runAction({ ...REFERENCE, action: "close" });
    assert.strictEqual(ran, "close");
  }),
);

it.effect("refuses a comment on a host that cannot post one, without asking anybody", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, comment: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          comment: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.comment({ ...REFERENCE, body: "Thanks!" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot post a comment on an issue.");
  }),
);

it.effect("refuses a comment this viewer may not post", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, comment: false }),
          comment: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.comment({ ...REFERENCE, body: "Thanks!" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(
      error.message,
      "You need write access on this repository to comment on an issue.",
    );
  }),
);

it.effect("refuses a comment written out of spaces before it reaches the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github", { comment: () => Effect.die("must not be called") })],
    });

    const error = yield* Effect.flip(service.comment({ ...REFERENCE, body: "   \n  " }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "A comment cannot be empty.");
  }),
);

it.effect("passes a rewritten issue comment through with its id and body", () =>
  Effect.gen(function* () {
    let received: { id: string; body: string } | null = null;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          updateComment: (input) => {
            received = { id: input.commentId, body: input.body };
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.updateComment({ ...REFERENCE, commentId: "IC_1", body: "Second thoughts" });

    assert.deepStrictEqual(received, { id: "IC_1", body: "Second thoughts" });
  }),
);

it.effect("refuses to open an issue on a host that cannot file one", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, create: false },
          create: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.create({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        title: "It broke",
        body: "",
        labels: [],
        assignees: [],
      }),
    );

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot open an issue.");
  }),
);

it.effect("refuses an edit on a host that cannot rewrite an issue", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, edit: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          update: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.update({ ...REFERENCE, title: "A better title" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(error.message, "This host cannot rewrite an issue.");
  }),
);

it.effect("refuses an edit that changes nothing, and one written out of spaces", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.die("must not be asked"),
          update: () => Effect.die("must not be called"),
        }),
      ],
    });

    const nothing = yield* Effect.flip(service.update(REFERENCE));
    assert.include(nothing.message, "An edit needs a new title or a new body.");

    const blankTitle = yield* Effect.flip(service.update({ ...REFERENCE, title: "   " }));
    assert.include(blankTitle.message, "A title cannot be empty.");

    // A body may legitimately be cleared, so only one written out of spaces is refused.
    const blankBody = yield* Effect.flip(service.update({ ...REFERENCE, body: "  \t " }));
    assert.include(blankBody.message, "A body cannot be only whitespace.");
  }),
);

it.effect("lets a cleared body through, which is a body somebody meant to empty", () =>
  Effect.gen(function* () {
    let written: string | undefined = "unset";
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          update: ({ body }) => {
            written = body;
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.update({ ...REFERENCE, body: "" });

    assert.strictEqual(written, "");
  }),
);

it.effect("refuses an edit this viewer may not make", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, edit: false }),
          update: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(service.update({ ...REFERENCE, title: "A better title" }));

    assert.strictEqual(error._tag, "IssueOperationError");
    assert.include(
      error.message,
      "You need write access on this repository, or to have opened this issue, to edit it.",
    );
  }),
);

it.effect("refuses labelling on a host that cannot label, and to a viewer who may not", () =>
  Effect.gen(function* () {
    const hostCannot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, labels: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          setLabels: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedHost = yield* Effect.flip(labelling(hostCannot));
    assert.include(refusedHost.message, "This host cannot label an issue.");

    const viewerMayNot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, labels: false }),
          setLabels: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedViewer = yield* Effect.flip(labelling(viewerMayNot));
    assert.include(
      refusedViewer.message,
      "You need write access on this repository to change the labels on an issue.",
    );
  }),
);

it.effect("refuses assignment on a host that cannot assign, and to a viewer who may not", () =>
  Effect.gen(function* () {
    const hostCannot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities: { ...FULL_CAPABILITIES, assignees: false },
          getViewerPermissions: () => Effect.die("must not be asked"),
          setAssignees: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedHost = yield* Effect.flip(assigning(hostCannot));
    assert.include(refusedHost.message, "This host cannot assign an issue to somebody.");

    const viewerMayNot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, assignees: false }),
          setAssignees: () => Effect.die("must not be called"),
        }),
      ],
    });
    const refusedViewer = yield* Effect.flip(assigning(viewerMayNot));
    assert.include(
      refusedViewer.message,
      "You need write access on this repository to change who an issue is assigned to.",
    );
  }),
);

it.effect(
  "keeps the label picker from a host without one, and from a viewer who may not label",
  () =>
    Effect.gen(function* () {
      const hostCannot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            capabilities: { ...FULL_CAPABILITIES, listLabelCandidates: false },
            getViewerPermissions: () => Effect.die("must not be asked"),
            listLabelCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedHost = yield* Effect.flip(hostCannot.labelCandidates(REFERENCE));
      assert.include(refusedHost.message, "This host cannot say which labels a repository has.");

      // The picker is the one the change is made from, so a viewer who may not apply a label is
      // offered no list whose every press was going to be turned down.
      const viewerMayNot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, labels: false }),
            listLabelCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedViewer = yield* Effect.flip(viewerMayNot.labelCandidates(REFERENCE));
      assert.include(
        refusedViewer.message,
        "You need write access on this repository to change the labels on an issue.",
      );
    }),
);

it.effect(
  "keeps the assignee picker from a host without one, and from a viewer who may not assign",
  () =>
    Effect.gen(function* () {
      const hostCannot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            capabilities: { ...FULL_CAPABILITIES, listAssigneeCandidates: false },
            getViewerPermissions: () => Effect.die("must not be asked"),
            listAssigneeCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedHost = yield* Effect.flip(hostCannot.assigneeCandidates(REFERENCE));
      assert.include(refusedHost.message, "This host cannot say who may be assigned an issue.");

      const viewerMayNot = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            getViewerPermissions: () => Effect.succeed({ ...FULL_PERMISSIONS, assignees: false }),
            listAssigneeCandidates: () => Effect.die("must not be called"),
          }),
        ],
      });
      const refusedViewer = yield* Effect.flip(viewerMayNot.assigneeCandidates(REFERENCE));
      assert.include(
        refusedViewer.message,
        "You need write access on this repository to change who an issue is assigned to.",
      );
    }),
);

it.effect("hands the host's own candidate lists back, asked for with the issue", () =>
  Effect.gen(function* () {
    const asked: number[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listLabelCandidates: ({ number }) => {
            asked.push(number);
            return Effect.succeed({
              candidates: [{ name: "bug", color: null, description: null, isApplied: true }],
              truncated: false,
            });
          },
          listAssigneeCandidates: ({ number }) => {
            asked.push(number);
            return Effect.succeed({
              candidates: [
                {
                  login: "bilal",
                  name: null,
                  avatarUrl: null,
                  id: "bilal",
                  isAssigned: false,
                },
              ],
              truncated: true,
            });
          },
        }),
      ],
    });

    const labels = yield* service.labelCandidates(REFERENCE);
    const assignees = yield* service.assigneeCandidates(REFERENCE);

    assert.deepStrictEqual(asked, [7, 7]);
    assert.deepStrictEqual(
      labels.candidates.map((candidate) => candidate.name),
      ["bug"],
    );
    assert.isTrue(assignees.truncated);
  }),
);

const REPOSITORY = { projectId: REFERENCE.projectId, repository: REFERENCE.repository };

const TEMPLATES: IssueTemplateList = {
  templates: [
    {
      key: "bug_report.md",
      name: "Bug report",
      about: "Something is broken",
      title: "[Bug]: ",
      body: "### What happened\n",
      labels: ["bug"],
      assignees: [],
    },
  ],
  contactLinks: [],
  blankIssuesEnabled: false,
};

/**
 * The host that offers no starting point is the one the composer most needs an answer from: it is
 * also the host that may take no labels, or no new issue at all. So an empty offer, with what the
 * host can do on it, rather than a refusal the form can read nothing out of.
 */
it.effect("tells a host with no templates apart by what it says it can do", () =>
  Effect.gen(function* () {
    const capabilities = { ...FULL_CAPABILITIES, issueTemplates: false, create: false };
    const hostCannot = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          capabilities,
          listIssueTemplates: () => Effect.die("must not be called"),
        }),
      ],
    });
    assert.deepStrictEqual(yield* hostCannot.templates(REPOSITORY), {
      capabilities,
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });

    // A host that claims the capability and implements nothing is the same empty offer rather than
    // a crash: the declaration is what the page believes, and it is the thing that was wrong.
    const undeclared = yield* makeService({
      projects: ONE_PROJECT,
      providers: [fakeProvider("github")],
    });
    assert.deepStrictEqual(yield* undeclared.templates(REPOSITORY), {
      capabilities: FULL_CAPABILITIES,
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });
  }),
);

/**
 * Nothing about the viewer is asked, unlike the candidate lists: this is the repository saying
 * what it wants filed, and everyone who can see the repository is told the same thing.
 */
it.effect("hands a repository's templates back without asking who is reading them", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () => Effect.die("must not be asked"),
          listIssueTemplates: () => Effect.succeed(TEMPLATES),
        }),
      ],
    });

    // The host's own answer, with what the host can do added to it: a provider reports the offer,
    // the service is what knows the capabilities.
    assert.deepStrictEqual(yield* service.templates(REPOSITORY), {
      ...TEMPLATES,
      capabilities: FULL_CAPABILITIES,
    });
  }),
);

it.effect("asks the host for a repository's templates once, and again once told to forget", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssueTemplates: () => {
            hostCalls += 1;
            return Effect.succeed(TEMPLATES);
          },
        }),
      ],
    });

    yield* Effect.all([service.templates(REPOSITORY), service.templates(REPOSITORY)], {
      concurrency: "unbounded",
    });
    yield* service.templates(REPOSITORY);
    assert.strictEqual(hostCalls, 1);

    // What a repository offers is changed by a commit to it, so one issue's own refresh leaves it
    // alone; only a reader asking for the whole page again spends the request.
    yield* service.invalidate({ reference: REFERENCE });
    yield* service.templates(REPOSITORY);
    assert.strictEqual(hostCalls, 1);

    yield* service.invalidate({});
    yield* service.templates(REPOSITORY);
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("answers a repeated listing from cache, and concurrent readers share one request", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            hostCalls += 1;
            return Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: false,
            });
          },
        }),
      ],
    });

    yield* Effect.all([service.list({ state: "open" }), service.list({ state: "open" })], {
      concurrency: "unbounded",
    });
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 1);

    // A different filter is a different answer, not a cache hit.
    yield* service.list({ state: "all" });
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("an explicit invalidation makes the next listing ask the host again", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            hostCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.invalidate({});
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);

    // Forgetting one issue leaves the listings shared.
    yield* service.invalidate({ reference: REFERENCE });
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("keeps a refreshed viewer when an older lookup finishes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let viewerCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          withCredential: (_host, read) => read("account"),
          getViewer: () =>
            ++viewerCalls === 1
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as("alice"),
                )
              : Effect.succeed("bob"),
        }),
      ],
    });
    const pending = yield* service.list({ state: "open" }).pipe(Effect.forkChild());
    yield* Deferred.await(started);
    yield* service.invalidate({});
    const key = issueSourceKey("github", "github.com");
    assert.equal((yield* service.list({ state: "open" })).viewers[key], "bob");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    assert.equal((yield* service.list({ state: "all" })).viewers[key], "bob");
    assert.equal(viewerCalls, 2);
  }),
);

it.effect.each(["github", "linear", "gitlab", "azure-devops", "bitbucket", "forgejo"])(
  "shares repeated and concurrent %s detail reads without spending extra host calls",
  (provider) =>
    Effect.gen(function* () {
      let calls = 0;
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "web",
            workspaceRoot: "/a",
            repository: "acme/web",
            provider,
          }),
        ],
        providers: [
          fakeProvider(provider, {
            getIssue: () =>
              Effect.sync(() => {
                calls += 1;
                return issueDetail(7);
              }),
          }),
        ],
      });
      const reads = yield* Effect.all(
        Array.from({ length: 20 }, () => service.detail(REFERENCE)),
        { concurrency: "unbounded" },
      );
      assert.isTrue(reads.every((read) => read.number === 7));
      yield* service.detail(REFERENCE);
      assert.equal(calls, 1);
    }),
);

it.effect("keeps issue reads out of GitHub's reserve while allowing writes to use it", () =>
  Effect.gen(function* () {
    const read = AllowGitHubReserve.pipe(
      Effect.flatMap((allowed) =>
        allowed
          ? Effect.succeed(issueDetail(7))
          : Effect.fail(
              new IssueProviderError({
                provider: "github",
                operation: "getIssue",
                reason: "rate-limited",
                detail: "Reserved quota",
              }),
            ),
      ),
    );
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () => read,
          getIssueActivity: () =>
            read.pipe(
              Effect.as({ comments: [], commentCount: 0, commentsTruncated: false, events: [] }),
            ),
          comment: () => read.pipe(Effect.asVoid),
        }),
      ],
    });
    assert.equal((yield* service.detail(REFERENCE).pipe(Effect.flip))._tag, "IssueOperationError");
    assert.equal(
      (yield* service.activity(REFERENCE).pipe(Effect.flip))._tag,
      "IssueOperationError",
    );
    yield* service.comment({ ...REFERENCE, body: "Keep writes available" });
  }),
);

it.effect("an explicit invalidation refreshes issue detail and activity", () =>
  Effect.gen(function* () {
    let detailVersion = 0;
    let activityVersion = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () => {
            detailVersion += 1;
            return Effect.succeed(issueDetail(7, { body: `detail ${detailVersion}` }));
          },
          getIssueActivity: () => {
            activityVersion += 1;
            return Effect.succeed({
              comments: [],
              commentCount: activityVersion,
              commentsTruncated: false,
              events: [],
            });
          },
        }),
      ],
    });

    assert.strictEqual((yield* service.detail(REFERENCE)).body, "detail 1");
    assert.strictEqual((yield* service.activity(REFERENCE)).commentCount, 1);

    yield* service.invalidate({});

    assert.strictEqual((yield* service.detail(REFERENCE)).body, "detail 2");
    assert.strictEqual((yield* service.activity(REFERENCE)).commentCount, 2);
  }),
);

it.effect("does not revive old detail after its invalidation epoch is evicted", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () => Effect.succeed(issueDetail(7, { body: `detail ${++reads}` })),
        }),
      ],
    });
    assert.strictEqual((yield* service.detail(REFERENCE)).body, "detail 1");
    yield* service.invalidate({ reference: REFERENCE });
    for (let number = 100; number < 2148; number++) {
      yield* service.invalidate({ reference: { ...REFERENCE, number } });
    }
    assert.strictEqual((yield* service.detail(REFERENCE)).body, "detail 2");
  }),
);

it.effect("a write forgets the listings and the issue it touched, with no client asking", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    let detailCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            listCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
          getIssue: () => {
            detailCalls += 1;
            return Effect.succeed(issueDetail(7));
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.detail(REFERENCE);
    assert.deepStrictEqual([listCalls, detailCalls], [1, 1]);

    yield* service.comment({ ...REFERENCE, body: "On it." });

    yield* service.list({ state: "open" });
    yield* service.detail(REFERENCE);
    assert.deepStrictEqual([listCalls, detailCalls], [2, 2]);
  }),
);

it.effect.each([
  { provider: "github" as const, repository: "acme/web", alternate: " Acme/Web " },
  { provider: "linear" as const, repository: "ENG", alternate: " eng " },
])("invalidates $provider issue caches across repository case and spaces", (input) =>
  Effect.gen(function* () {
    let state: "open" | "closed" = "open";
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider(input.provider, {
          resolveSource: () => Effect.succeed({ host: "host.test", repository: input.repository }),
          getIssue: ({ repository }) => {
            assert.equal(repository, input.repository);
            return Effect.succeed(issueDetail(7, { state }));
          },
          getIssueActivity: () =>
            Effect.succeed({
              comments: [],
              commentCount: state === "open" ? 0 : 1,
              commentsTruncated: false,
              events: [],
            }),
          runAction: ({ repository }) =>
            Effect.sync(() => {
              assert.equal(repository, input.repository);
              state = "closed";
            }),
        }),
      ],
    });
    const ref = { ...REFERENCE, provider: input.provider, repository: input.repository };
    assert.equal((yield* service.detail(ref)).state, "open");
    assert.equal((yield* service.summary(ref)).state, "open");
    assert.equal((yield* service.activity(ref)).commentCount, 0);
    yield* service.runAction({ ...ref, repository: input.alternate, action: "close" });
    assert.equal((yield* service.detail(ref)).state, "closed");
    assert.equal((yield* service.summary(ref)).state, "closed");
    assert.equal((yield* service.activity(ref)).commentCount, 1);
    state = "open";
    yield* service.invalidate({ reference: { ...ref, repository: input.alternate } });
    assert.equal((yield* service.detail(ref)).state, "open");
    assert.equal((yield* service.summary(ref)).state, "open");
    assert.equal((yield* service.activity(ref)).commentCount, 0);
  }),
);

it.effect(
  "publishes refreshes after successful close, reopen and edit, but not failed writes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeService({
          projects: ONE_PROJECT,
          providers: [fakeProvider("github")],
        });
        const refreshes = yield* Queue.unbounded<IssueRef>();
        yield* service.subscribeRefreshes.pipe(
          Stream.runForEach((ref) => Queue.offer(refreshes, ref)),
          Effect.forkChild({ startImmediately: true }),
        );
        const ref = { ...REFERENCE, provider: "github", host: "github.com" };
        for (const action of ["close", "reopen"] as const) {
          const input = { ...ref, action };
          yield* service.runAction(input);
          assert.deepEqual(yield* Queue.take(refreshes), input);
        }
        const error = yield* Effect.flip(service.update({ ...ref, title: "   " }));
        assert.equal(error._tag, "IssueOperationError");
        const input = { ...ref, title: "Edited title" };
        yield* service.update(input);
        assert.deepEqual(yield* Queue.take(refreshes), input);
        assert.equal(yield* Queue.size(refreshes), 0);
      }),
    ),
);

it.effect("a new issue forgets the listings that would hold it", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          listIssues: () => {
            listCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    const created = yield* service.create({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      title: "It broke",
      body: "",
      labels: [],
      assignees: [],
    });
    yield* service.list({ state: "open" });

    assert.strictEqual(created.number, 1);
    assert.strictEqual(listCalls, 2);
  }),
);

/** A row as a host that reads several repositories at once hands it over. */
function batchedIssue(number: number, repository: string, updatedAt: string): ProviderBatchedIssue {
  return { ...issue(number, updatedAt), repository };
}

const TWO_PROJECTS = [
  project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
  project({ id: "p2", title: "api", workspaceRoot: "/b", repository: "acme/api" }),
];

it.effect("sorts non-GitHub issues by comments in either direction", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/a",
          repository: "acme/web",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("gitlab", {
          listIssues: () =>
            Effect.succeed({
              items: [
                { ...issue(1, "2026-07-05T00:00:00Z"), commentCount: 2 },
                { ...issue(2, "2026-07-02T00:00:00Z"), commentCount: 8 },
              ],
              truncated: false,
              continues: false,
            }),
        }),
      ],
    });
    for (const order of ["asc", "desc"] as const) {
      const result = yield* service.list({ state: "open", sort: "comments", order });
      assert.deepStrictEqual(
        result.entries.map((entry) => entry.number),
        order === "asc" ? [1, 2] : [2, 1],
      );
    }
  }),
);

it.effect("orders rows by the selected reaction kind across repositories", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssuesAcross: () =>
            Effect.succeed({
              items: [
                {
                  ...batchedIssue(1, "acme/web", "2026-07-05T00:00:00Z"),
                  reactions: [
                    { content: "thumbs-up", count: 9, actors: [], viewerHasReacted: false },
                    { content: "heart", count: 1, actors: [], viewerHasReacted: false },
                  ],
                },
                {
                  ...batchedIssue(2, "acme/api", "2026-07-02T00:00:00Z"),
                  reactions: [{ content: "heart", count: 3, actors: [], viewerHasReacted: false }],
                },
              ],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      sort: "reactions-heart",
      order: "desc",
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2, 1],
    );
  }),
);

it.effect("reads a host's repositories in one search, and files the rows back under each", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: () => Effect.die("must not be asked one at a time"),
          listIssuesAcross: (input) => {
            asked.push(input.repositories);
            return Effect.succeed({
              items: [
                batchedIssue(1, "acme/api", "2026-07-05T00:00:00Z"),
                batchedIssue(2, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [["acme/web", "acme/api"]]);
    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.projectId, entry.number]),
      [
        ["p2", 1],
        ["p1", 2],
      ],
    );
  }),
);

it.effect(
  "reports the GitHub search ceiling across grouped repositories without a stalled cursor",
  () =>
    Effect.gen(function* () {
      const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      for (const total of [1000, 1001]) {
        let searches = 0;
        const provider = yield* GitHubIssueProvider.make.pipe(
          Effect.provide(
            GitHubIssueCli.layer.pipe(
              Layer.provideMerge(
                Layer.mock(GitHubApi.GitHubApi)({
                  credential: () =>
                    Effect.succeed({ token: Redacted.make("test-token"), fingerprint: "test" }),
                  graphql: ({ operation, variables }) =>
                    Effect.gen(function* () {
                      if (operation === "getViewerLogin") {
                        return yield* encodeJson({ data: { viewer: { login: "bilal" } } });
                      }
                      searches += 1;
                      const start = Number(variables?.["cursor"] ?? 0);
                      const end = Math.min(start + 100, total);
                      return yield* encodeJson({
                        data: {
                          search: {
                            nodes: Array.from({ length: end - start }, (_, index) => {
                              const number = start + index + 1;
                              return {
                                number,
                                title: `Issue ${number}`,
                                url: `https://github.com/acme/web/issues/${number}`,
                                createdAt: "2026-07-01T00:00:00Z",
                                updatedAt: "2026-07-02T00:00:00Z",
                                repository: { nameWithOwner: number % 2 ? "acme/web" : "acme/api" },
                              };
                            }),
                            pageInfo: { hasNextPage: end < total, endCursor: String(end) },
                          },
                        },
                      });
                    }).pipe(Effect.orDie),
                }),
              ),
            ),
          ),
        );
        const service = yield* makeService({ projects: TWO_PROJECTS, providers: [provider] });
        const result = yield* service.list({ state: "open", limit: 99 });
        assert.strictEqual(result.entries.length, 1000);
        assert.strictEqual(result.truncated, total > 1000);
        assert.deepStrictEqual(result.nextCursors, {});
        assert.strictEqual(searches, 10);
      }
    }),
);

it.effect("does not repeat a grouped cursor after the provider reaches its ceiling", () =>
  Effect.gen(function* () {
    const boundary = "2026-07-02T00:00:00Z";
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssuesAcross: () =>
            Effect.succeed({
              items: [batchedIssue(7, "acme/web", boundary), batchedIssue(8, "acme/api", boundary)],
              truncated: true,
              ceilingReached: true,
            }),
        }),
      ],
    });
    const result = yield* service.list({
      state: "open",
      cursors: {
        [cursorKey("acme/web")]: `${boundary}|0|7`,
        [cursorKey("acme/api")]: `${boundary}|0|8`,
      },
    });
    assert.deepStrictEqual(result.entries, []);
    assert.isTrue(result.truncated);
    assert.deepStrictEqual(result.nextCursors, {});
  }),
);

it.effect(
  "carries on grouped listings without counting another repository's seen issue number",
  () =>
    Effect.gen(function* () {
      const boundary = "2026-07-02T00:00:00Z";
      const firstRows = [
        batchedIssue(7, "acme/web", boundary),
        batchedIssue(8, "acme/api", boundary),
      ];
      const service = yield* makeService({
        projects: TWO_PROJECTS,
        providers: [
          fakeProvider("github", {
            listIssues: () => Effect.die("must use grouped continuation"),
            listIssuesAcross: ({ cursor, limit }) => {
              const rows =
                cursor === undefined
                  ? firstRows
                  : [
                      ...firstRows,
                      batchedIssue(7, "acme/api", boundary),
                      batchedIssue(8, "acme/web", "2026-07-01T00:00:00Z"),
                    ].filter(
                      (row) =>
                        row.updatedAt !== cursor.updatedBefore ||
                        !cursor.seenAtByRepository?.[row.repository]?.includes(row.number),
                    );
              return Effect.succeed({
                items: rows.slice(0, limit),
                truncated: cursor === undefined,
              });
            },
          }),
        ],
      });
      const first = yield* service.list({ state: "open", limit: 2 });
      const second = yield* service.list({ state: "open", limit: 2, cursors: first.nextCursors });
      assert.deepStrictEqual(
        second.entries.map(({ repository, number }) => [repository, number]),
        [
          ["acme/api", 7],
          ["acme/web", 8],
        ],
      );
    }),
);

it.effect("asks on its own for a repository the search said nothing at all about", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [issue(9, "2026-07-01T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
          listIssuesAcross: () =>
            Effect.succeed({
              items: [batchedIssue(1, "acme/web", "2026-07-05T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // A host does not index every repository for search, and a switched-off tracker is silent
    // too — so silence is checked once rather than believed.
    assert.deepStrictEqual(separately, ["acme/api"]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1, 9],
    );
  }),
);

it.effect("reads the repositories one at a time when the search itself fails", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssues: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [issue(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
          listIssuesAcross: () =>
            Effect.fail(
              new IssueProviderError({
                provider: "github",
                operation: "listIssuesAcross",
                reason: "failed",
                detail: "HTTP 422",
              }),
            ),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // One failed question about two repositories is no reason to call both of them unreadable.
    assert.deepStrictEqual(separately.toSorted(), ["acme/api", "acme/web"]);
    assert.strictEqual(result.entries.length, 2);
    assert.deepStrictEqual(result.errors, []);
  }),
);

it.effect("carries every repository of a slice on from the oldest row in it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: TWO_PROJECTS,
      providers: [
        fakeProvider("github", {
          listIssuesAcross: () =>
            Effect.succeed({
              items: [
                batchedIssue(1, "acme/web", "2026-07-05T00:00:00Z"),
                batchedIssue(2, "acme/web", "2026-07-03T00:00:00Z"),
              ],
              truncated: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: {
        [cursorKey("acme/web")]: "2026-07-06T00:00:00Z|1|1",
        [cursorKey("acme/api")]: "2026-07-06T00:00:00Z|1|5",
      },
    });

    // The repository that contributed nothing has been read to the same instant: its rows are
    // simply all older, and carrying it on from its own oldest row would say nothing about them.
    assert.deepStrictEqual(result.nextCursors, {
      [cursorKey("acme/web")]: "2026-07-03T00:00:00Z|0|2",
      [cursorKey("acme/api")]: "2026-07-03T00:00:00Z|0|",
    });
  }),
);

it.effect("passes a reaction through with its subject id", () =>
  Effect.gen(function* () {
    let received: Parameters<NonNullable<IssueAdapter["setReaction"]>>[0] | null = null;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          setReaction: (input) => {
            received = input;
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.setReaction({
      ...REFERENCE,
      subjectId: "IC_1",
      content: "heart",
      reacted: true,
    });

    assert.deepStrictEqual(received, {
      cwd: "/a",
      repository: "acme/web",
      host: "github.com",
      number: 7,
      subjectId: "IC_1",
      content: "heart",
      reacted: true,
    });
  }),
);

it.effect(
  "shares issue summaries and refreshes them after writes without reading full detail",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const service = yield* makeService({
        projects: ONE_PROJECT,
        providers: [
          fakeProvider("github", {
            getIssueSummary: () =>
              Effect.sync(() => {
                reads++;
                return issue(7, "2026-07-02T00:00:00Z");
              }),
            getIssue: () => Effect.die("full detail must not be read"),
            getViewer: () => Effect.die("viewer must not be read"),
          }),
        ],
      });
      yield* Effect.all([service.summary(REFERENCE), service.summary(REFERENCE)], {
        concurrency: 2,
      });
      yield* service.summary(REFERENCE);
      assert.equal(reads, 1);
      yield* service.invalidate({ reference: REFERENCE });
      yield* service.summary(REFERENCE);
      assert.equal(reads, 2);
    }),
);

it.effect("falls back to issue detail when a provider has no summary read", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () =>
            Effect.sync(() => {
              reads++;
              return issueDetail(7);
            }),
        }),
      ],
    });
    assert.equal((yield* service.summary(REFERENCE)).title, "Issue 7");
    assert.equal(reads, 1);
  }),
);

it.effect("changes every GitHub cache and viewer when the verified credential changes", () =>
  Effect.gen(function* () {
    let fingerprint = "account-a";
    const reads = { detail: 0, activity: 0, summary: 0, list: 0, templates: 0, viewer: 0 };
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          withCredential: (_host, read) => read(fingerprint),
          getViewer: () => {
            reads.viewer++;
            return Effect.succeed(fingerprint);
          },
          getIssue: () => {
            reads.detail++;
            return Effect.succeed({ ...issueDetail(7), viewer: fingerprint });
          },
          getIssueActivity: () => {
            reads.activity++;
            return Effect.succeed({
              author: null,
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              events: [],
            });
          },
          getIssueSummary: () => {
            reads.summary++;
            return Effect.succeed(issue(7, "2026-07-02T00:00:00Z"));
          },
          listIssues: () => {
            reads.list++;
            return Effect.succeed({
              items: [issue(7, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
          listIssueTemplates: () => {
            reads.templates++;
            return Effect.succeed(TEMPLATES);
          },
        }),
      ],
    });
    const readAll = Effect.gen(function* () {
      const detail = yield* service.detail(REFERENCE);
      assert.equal(detail.viewer, fingerprint);
      yield* service.activity(REFERENCE);
      yield* service.summary(REFERENCE);
      yield* service.list({ state: "open" });
      yield* service.templates(REFERENCE);
    });
    yield* readAll;
    yield* readAll;
    assert.deepEqual(reads, {
      detail: 1,
      activity: 1,
      summary: 1,
      list: 1,
      templates: 1,
      viewer: 1,
    });
    fingerprint = "account-b";
    yield* readAll;
    assert.deepEqual(reads, {
      detail: 2,
      activity: 2,
      summary: 2,
      list: 2,
      templates: 2,
      viewer: 2,
    });
  }),
);

it.effect("candidate queries with fresh access rights skip a separate permission read", () =>
  Effect.gen(function* () {
    let permissionReads = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          candidatePermissionsIncluded: true,
          getViewerPermissions: () => {
            permissionReads++;
            return Effect.succeed(FULL_PERMISSIONS);
          },
          listLabelCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
          listAssigneeCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
        }),
      ],
    });
    yield* service.labelCandidates(REFERENCE);
    yield* service.assigneeCandidates(REFERENCE);
    assert.equal(permissionReads, 0);
  }),
);

it.effect("pins list viewers and rows to the same account when settings change", () =>
  Effect.gen(function* () {
    const account = Context.Reference<string>("test/issue/account", { defaultValue: () => "" });
    let selected = "account-a";
    const observed: string[] = [];
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          withCredential: (_host, read) =>
            read(selected).pipe(Effect.provideService(account, selected)),
          getViewer: () =>
            Effect.map(account, (pinned) => {
              selected = "account-b";
              return pinned;
            }),
          listIssues: (input) =>
            Effect.map(account, (pinned) => {
              observed.push(pinned);
              assert.equal(input.viewer, pinned);
              return {
                items: [issue(7, "2026-07-02T00:00:00Z")],
                truncated: false,
                continues: true,
              };
            }),
        }),
      ],
    });
    yield* service.list({ state: "open" });
    yield* service.list({ state: "open" });
    assert.deepEqual(observed, ["account-a", "account-b"]);
  }),
);

it.effect("stops a stale detail refresh when the service scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<Exit.Exit<never>>();
    let reads = 0;
    const service = yield* makeService({
      projects: ONE_PROJECT,
      providers: [
        fakeProvider("github", {
          getIssue: () => {
            reads += 1;
            return reads === 1
              ? Effect.succeed(issueDetail(7))
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onExit((exit) => Deferred.succeed(finished, exit)),
                );
          },
        }),
      ],
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const first = yield* service.detail(REFERENCE);
    yield* TestClock.adjust("16 seconds");
    assert.deepEqual(yield* service.detail(REFERENCE), first);
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(yield* Deferred.isDone(finished));
    assert.isTrue(Exit.hasInterrupts(yield* Deferred.await(finished)));
    assert.equal(reads, 2);
  }),
);
