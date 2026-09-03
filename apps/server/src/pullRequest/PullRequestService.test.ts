import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
  SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  PullRequestProviderError,
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import * as PullRequestService from "./PullRequestService.ts";

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

function changeRequest(number: number, updatedAt: string): ProviderChangeRequest {
  return {
    number,
    title: `Change request ${number}`,
    url: `https://host/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    reviewRequestLogins: [],
    labels: [],
  };
}

function hostedChangeRequest(body: string, additions = 1) {
  return {
    ...changeRequest(1, "2026-07-02T00:00:00Z"),
    body,
    additions,
    changedFiles: 2,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    viewerPermissions: {
      actions: ["merge"] as const,
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"] as const,
      requestReviewers: true,
    },
  };
}

function unusable(provider: SourceControlProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new PullRequestProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

const requestFailed = new PullRequestProviderError({
  provider: "github",
  operation: "listChangeRequests",
  reason: "failed",
  detail: "HTTP 404",
});

/** Everything a host could offer, so a fixture only narrows what its own test is about. */
const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

/** A provider whose every call is supplied by the test; anything unset succeeds emptily. */
function fakeProvider(
  kind: SourceControlProviderKind,
  overrides: Partial<PullRequestProviderApi> = {},
): PullRequestProviderApi {
  return {
    kind,
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge", "ready", "draft", "close", "reopen"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
      edit: { changeRequest: true, comment: true },
    },
    getViewer: () => Effect.succeed("bilal"),
    // A viewer who may do everything the host can, so a test only narrows what it is about.
    getViewerPermissions: () =>
      Effect.succeed({
        actions: ["merge", "ready", "draft", "close", "reopen"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      }),
    listChangeRequests: () => Effect.succeed({ items: [], truncated: false, continues: true }),
    getChangeRequest: () => Effect.die("unused"),
    getChangeRequestActivity: () => Effect.die("unused"),
    getDiff: () => Effect.die("unused"),
    runAction: () => Effect.void,
    updateChangeRequest: () => Effect.void,
    comment: () => Effect.void,
    updateComment: () => Effect.void,
    submitReview: () => Effect.void,
    replyToThread: () => Effect.void,
    setThreadResolution: () => Effect.void,
    setReaction: () => Effect.void,
    listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
    setReviewerRequest: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
}) {
  return PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestProviderRegistry, fromProviders(input.providers)),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveHandle:
            input.resolveHandle ?? (() => Effect.die("Unexpected provider refinement")),
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: input.projects,
              threads: [],
              updatedAt: "2026-07-01T00:00:00Z",
            }),
        }),
        SourceControlRateLimit.layer,
      ),
    ),
  );
}

it.effect("refines unknown self-hosted GitLab projects before listing merge requests", () =>
  Effect.gen(function* () {
    let refinementCalls = 0;
    const selfHosted = project({
      id: "p1",
      title: "self-hosted",
      workspaceRoot: "/gitlab",
      repository: "group/project",
      provider: "unknown",
      host: "code.example.test",
    });
    const service = yield* makeService({
      projects: [
        selfHosted,
        { ...selfHosted, id: "p2" as ProjectId, workspaceRoot: "/gitlab-worktree" },
      ],
      providers: [fakeProvider("gitlab")],
      resolveHandle: ({ context }) => {
        refinementCalls += 1;
        assert.strictEqual(context?.remoteUrl, "https://code.example.test/group/project.git");
        return Effect.succeed({
          context: { ...context!, provider: { ...context!.provider, kind: "gitlab" } },
          provider: undefined as never,
        });
      },
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(refinementCalls, 1);
    assert.strictEqual(result.providers[0]?.host, "code.example.test");
    assert.strictEqual(result.providers[0]?.kind, "gitlab");
  }),
);

it.effect("derives a legacy repository host after refining its provider", () =>
  Effect.gen(function* () {
    const current = project({
      id: "p1",
      title: "legacy self-hosted",
      workspaceRoot: "/gitlab",
      repository: "group/project",
      provider: "unknown",
      host: "code.example.test",
    });
    const identity = current.repositoryIdentity!;
    // Persisted identities from before canonicalKey existed are still accepted at runtime.
    const legacy = {
      ...current,
      repositoryIdentity: {
        locator: identity.locator,
        provider: identity.provider,
        displayName: identity.displayName,
      },
    } as unknown as OrchestrationProjectShell;
    const service = yield* makeService({
      projects: [legacy],
      providers: [fakeProvider("gitlab")],
      resolveHandle: ({ context }) =>
        Effect.succeed({
          context: { ...context!, provider: { ...context!.provider, kind: "gitlab" } },
          provider: undefined as never,
        }),
    });

    const result = yield* service.list({ state: "open", host: "gitlab" });

    assert.strictEqual(result.providers[0]?.host, "gitlab");
    assert.strictEqual(result.providers[0]?.kind, "gitlab");
  }),
);

it.effect("tries another checkout when provider refinement remains unknown", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const selfHosted = project({
      id: "p1",
      title: "self-hosted",
      workspaceRoot: "/gone",
      repository: "group/project",
      provider: "unknown",
      host: "code.example.test",
    });
    const service = yield* makeService({
      projects: [selfHosted, { ...selfHosted, id: "p2" as ProjectId, workspaceRoot: "/healthy" }],
      providers: [fakeProvider("gitlab")],
      resolveHandle: ({ cwd, context }) => {
        asked.push(cwd);
        return cwd === "/gone"
          ? Effect.succeed({ context: context!, provider: undefined as never })
          : Effect.succeed({
              context: { ...context!, provider: { ...context!.provider, kind: "gitlab" } },
              provider: undefined as never,
            });
      },
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, ["/gone", "/healthy"]);
    assert.strictEqual(result.providers[0]?.kind, "gitlab");
  }),
);

/** A row as a host that reads several repositories at once hands it over. */
function batchedChangeRequest(number: number, repository: string, updatedAt: string) {
  return { ...changeRequest(number, updatedAt), repository };
}

it.effect("reads nothing from a host with no implementation, but reports it", () =>
  Effect.gen(function* () {
    const listed: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "notes", workspaceRoot: "/b" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            listed.push(input.repository);
            return Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(listed, ["pingdotgg/t3code"]);
    assert.strictEqual(result.entries[0]?.provider, "github");
    // The GitLab project is explained rather than quietly missing from the page.
    assert.deepStrictEqual(
      result.providers.map((summary) => ({
        kind: summary.kind,
        configured: summary.configured,
        projectCount: summary.projectCount,
      })),
      [
        { kind: "github", configured: true, projectCount: 1 },
        { kind: "gitlab", configured: false, projectCount: 1 },
      ],
    );
  }),
);

it.effect("asks for a whole page of a host, and for the reader's own size when given one", () =>
  Effect.gen(function* () {
    const limits: number[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            limits.push(input.limit);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.list({ state: "open", limit: 10 });

    // Providers probe with one row over this, so 99 asks a host for 100 — the most GitHub and
    // GitLab serve in one request. 100 here would cost a second round trip for a single row.
    assert.deepStrictEqual(limits, [99, 10]);
  }),
);

it.effect("says where each repository carries on, and from nothing it has run out of", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "web", workspaceRoot: "/b", repository: "acme/web" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: ({ repository }) =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: repository === "pingdotgg/t3code",
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // The instant of the oldest row, how many rows have gone, and the row already sent at that
    // instant. The repository that had nothing more is simply not in it.
    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|1",
    });
  }),
);

it.effect("offers no continuation for a host that cannot be carried on from", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // More rows exist and no cursor reaches them, which is what asking for a larger page is for.
    assert.isTrue(result.truncated);
    assert.deepStrictEqual(result.nextCursors, {});
  }),
);

it.effect("uses a provider's raw cursor advance when it consumed malformed rows", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/a",
          repository: "acme/web",
          provider: "azure-devops",
          host: "dev.azure.com",
        }),
      ],
      providers: [
        fakeProvider("azure-devops", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(7, "2026-07-02T00:00:00Z")],
              truncated: true,
              cursorAdvance: 4,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // Keyed by the selector Azure is actually asked with, which is the repository's own name.
    assert.deepStrictEqual(result.nextCursors, {
      "dev.azure.com web": "2026-07-02T00:00:00Z|4|7",
    });
  }),
);

it.effect("reads only the repositories it was asked to carry on with", () =>
  Effect.gen(function* () {
    const listed: string[] = [];
    const cursors: Array<unknown> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "web", workspaceRoot: "/b", repository: "acme/web" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            listed.push(input.repository);
            cursors.push(input.cursor);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { "github.com acme/web": "2026-07-02T00:00:00Z|99|7" },
    });

    // The other repository is already on the page, and reading it again is the whole cost this
    // is here to avoid. The host summaries stay over the workspace, because the switcher they
    // fill is about the workspace rather than about this slice.
    assert.deepStrictEqual(listed, ["acme/web"]);
    assert.deepStrictEqual(cursors, [{ updatedBefore: "2026-07-02T00:00:00Z", delivered: 99 }]);
    assert.strictEqual(result.providers.length, 1);
  }),
);

it.effect("keeps a row already sent at the boundary instant from arriving twice", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          // The boundary instant is asked for inclusively, so the host hands back the rows
          // already sent at it alongside the ones beside them — which a strictly-older read
          // would have lost instead.
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                changeRequest(7, "2026-07-02T00:00:00Z"),
                changeRequest(8, "2026-07-02T00:00:00Z"),
                changeRequest(9, "2026-07-01T00:00:00Z"),
              ],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|7" },
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [8, 9],
    );
    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-01T00:00:00Z|3|9",
    });
  }),
);

it.effect("keeps the earlier exclusions when a slice ends on the instant it began on", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                changeRequest(7, "2026-07-02T00:00:00Z"),
                changeRequest(8, "2026-07-02T00:00:00Z"),
              ],
              truncated: true,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|6" },
    });

    // Eight rows can share one second, so a whole slice inside one is ordinary. The next read
    // has to keep excluding 6 as well as the two just sent, or it hands 6 over again.
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [7, 8],
    );
    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|3|6,7,8",
    });
  }),
);

it.effect("refuses a continuation it did not issue, before asking any host anything", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", { listChangeRequests: () => Effect.die("should not be read") }),
      ],
    });

    const error = yield* Effect.flip(
      service.list({ state: "open", cursors: { "github.com pingdotgg/t3code": "yesterday" } }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(
      error.message,
      "Pull request operation list failed: The list could not be carried on from where it left off.",
    );
  }),
);

it.effect("calls a transient viewer failure a failed operation, not a signed-out CLI", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: "github",
                operation: "getViewer",
                reason: "failed",
                detail: "HTTP 500",
              }),
            ),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    // `cli-unauthenticated` would send the reader to `gh auth login` over a transient error.
    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("reports an unusable host over a merely failing one", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: "github",
                operation: "getViewer",
                reason: "failed",
                detail: "HTTP 500",
              }),
            ),
        }),
        fakeProvider("gitlab", {
          getViewer: () => Effect.fail(unusable("gitlab", "missing-tool")),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    assert.strictEqual(error._tag, "PullRequestUnavailableError");
    assert.strictEqual(error.message.includes("glab"), true);
  }),
);

it.effect("lists every host that has an implementation", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/sub/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-01T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
        fakeProvider("gitlab", {
          listChangeRequests: (input) =>
            // Nested groups need the full path, not the last two segments.
            input.repository === "group/sub/project"
              ? Effect.succeed({
                  items: [changeRequest(2, "2026-07-05T00:00:00Z")],
                  truncated: false,
                  continues: true,
                })
              : Effect.die("wrong repository identity"),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.provider, entry.number]),
      [
        ["gitlab", 2],
        ["github", 1],
      ],
    );
  }),
);

it.effect("narrows the listing to one host when asked", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", { listChangeRequests: () => Effect.die("should not be read") }),
        fakeProvider("gitlab", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(2, "2026-07-05T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open", host: "gitlab.com" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.provider),
      ["gitlab"],
    );
  }),
);

it.effect("tells two hosts of one kind apart in the switcher and the filter", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "on github.com", workspaceRoot: "/a", repository: "ping/one" }),
        project({
          id: "p2",
          title: "on the enterprise install",
          workspaceRoot: "/b",
          repository: "ping/two",
          host: "ghe.example.com",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: ({ host }) =>
            Effect.succeed({
              items: host === "ghe.example.com" ? [changeRequest(2, "2026-07-05T00:00:00Z")] : [],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    // Both hosts are GitHub, so a switcher keyed by provider kind would offer one pill for the
    // two of them and no way to ask for either.
    const all = yield* service.list({ state: "open" });
    assert.deepStrictEqual(
      all.providers.map((summary) => [summary.host, summary.kind, summary.projectCount]),
      [
        ["github.com", "github", 1],
        ["ghe.example.com", "github", 1],
      ],
    );

    const scoped = yield* service.list({ state: "open", host: "ghe.example.com" });
    assert.deepStrictEqual(
      scoped.entries.map((entry) => [entry.host, entry.number]),
      [["ghe.example.com", 2]],
    );
  }),
);

it.effect("keeps one host listed when another is not set up", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
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
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(1, "2026-07-01T00:00:00Z")],
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
    assert.deepStrictEqual(
      result.providers.map((summary) => [summary.kind, summary.configured]),
      [
        ["github", true],
        ["gitlab", false],
      ],
    );
  }),
);

it.effect("fails as unavailable only when no host can be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: () => Effect.fail(unusable("github", "missing-tool")),
        }),
      ],
    });

    const error = yield* service.list({ state: "open" }).pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestUnavailableError");
    assert.strictEqual(
      error._tag === "PullRequestUnavailableError" ? error.reason : null,
      "cli-missing",
    );
  }),
);

it.effect("reads a repository once when several worktrees share it", () =>
  Effect.gen(function* () {
    let calls = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "t3code worktree",
          workspaceRoot: "/b",
          repository: "PingDotGG/T3Code",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () => {
            calls += 1;
            return Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(calls, 1);
    assert.strictEqual(result.entries.length, 1);
  }),
);

it.effect("keeps healthy repositories when one of them cannot be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "broken", workspaceRoot: "/b", repository: "pingdotgg/broken" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) =>
            input.repository === "pingdotgg/broken"
              ? Effect.fail(requestFailed)
              : Effect.succeed({
                  items: [changeRequest(1, "2026-07-02T00:00:00Z")],
                  truncated: false,
                  continues: true,
                }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.strictEqual(result.entries.length, 1);
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectTitle),
      ["broken"],
    );
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
        fakeProvider("github", {
          getViewer: (input) =>
            input.cwd === "/healthy"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable("github", "missing-tool")),
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

it.effect("refuses an action the host never claimed it could run", () =>
  Effect.gen(function* () {
    let ran = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            // Bitbucket's shape: it can merge and close, but cannot reopen.
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

it.effect("publishes a successful merge for immediate settlement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mergedAt = "2026-09-03T02:00:00.000Z";
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakeProvider("github", {
            runAction: () => TestClock.setTime(Date.parse(mergedAt)),
          }),
        ],
      });
      const merges = yield* service.subscribeMerges;
      const observedMerge = yield* Stream.runHead(merges).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

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

it.effect("refuses an action this viewer may not take, and says what access it takes", () =>
  Effect.gen(function* () {
    let ran: string | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          // The host merges; this account only reads it, and opened the change request — which
          // is every contributor to a repository they do not own.
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

    // What the author keeps whatever their access is still theirs to take.
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
        fakeProvider("github", {
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
          // This account may close the change request it opened, and nothing else here.
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
    assert.include(refused.message, "merged for you once it is ready");
    assert.strictEqual(ranWith, null);

    // The strategy is checked against the host for an armed merge too: a merge it performs
    // later is still a merge, and one it cannot spell must not be passed on.
    const wrongStrategy = yield* Effect.flip(
      service.runAction({ ...reference, action: "enable-auto-merge", mergeMethod: "rebase" }),
    );
    assert.strictEqual(wrongStrategy._tag, "PullRequestOperationError");
    assert.strictEqual(ranWith, null);
  }),
);

it.effect("hands the host the strategy an armed merge was asked for", () =>
  Effect.gen(function* () {
    let ranWith: { readonly action: string; readonly mergeMethod?: string } | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "enable-auto-merge", "disable-auto-merge"],
            mergeMethods: ["merge", "squash"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["merge", "enable-auto-merge", "disable-auto-merge"],
              comment: true,
              resolve: true,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: true,
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

    yield* service.runAction({ ...reference, action: "enable-auto-merge", mergeMethod: "squash" });
    assert.deepStrictEqual(ranWith, { action: "enable-auto-merge", mergeMethod: "squash" });

    yield* service.runAction({ ...reference, action: "disable-auto-merge" });
    assert.deepStrictEqual(ranWith, { action: "disable-auto-merge" });
  }),
);

it.effect("refuses an auto-merge the host never claimed, without asking it", () =>
  Effect.gen(function* () {
    let ran = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        // Bitbucket's shape: it merges, and has nothing that merges later on its own.
        fakeProvider("github", {
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
        action: "enable-auto-merge",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(ran);
  }),
);

it.effect("refuses to resolve a conversation this viewer may not, without asking the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["merge", "ready", "draft", "close", "reopen"],
              comment: true,
              resolve: false,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: true,
            }),
          setThreadResolution: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.setThreadResolution({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        threadId: "t1",
        resolved: true,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "to resolve a review conversation.");
  }),
);

it.effect("asks nobody what the viewer may do when the host cannot do it at all", () =>
  Effect.gen(function* () {
    let asked = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
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
          getViewerPermissions: () => {
            asked = true;
            return Effect.die("must not be called");
          },
        }),
      ],
    });

    yield* Effect.flip(
      service.runAction({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        action: "reopen",
      }),
    );

    // The capability check costs nothing; the permission read is a request, so it comes second.
    assert.isFalse(asked);
  }),
);

it.effect("refuses a comment on a host that cannot post one", () =>
  Effect.gen(function* () {
    let posted = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: false,
            comment: false,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          comment: () => {
            posted = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.comment({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        body: "Looks good.",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(posted);
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
          // The same path on a different host: neither the viewer nor the row may be shared.
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
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

    // Both repositories survive de-duplication, each with its own account.
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

it.effect("reports repositories on a host that could not be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
        project({
          id: "p2",
          title: "enterprise",
          workspaceRoot: "/enterprise",
          repository: "acme/api",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: (input) =>
            input.cwd === "/cloud"
              ? Effect.succeed("bilal")
              : Effect.fail(unusable("github", "unauthenticated")),
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

    // The healthy host still lists, and the unreadable one is named rather than dropped.
    assert.strictEqual(result.entries.length, 1);
    assert.deepStrictEqual(
      result.errors.map((error) => error.projectId),
      ["p2"],
    );
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
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.sync(() => {
              listCalls += 1;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new PullRequestProviderError({
                    provider: "github",
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

it.effect("uses a manual rate limit to pause later reads", () =>
  Effect.gen(function* () {
    let listCalls = 0;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "cloud", workspaceRoot: "/cloud", repository: "acme/web" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.sync(() => {
              listCalls += 1;
              return { items: [], truncated: false, continues: true };
            }),
          runAction: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: "github",
                operation: "runAction",
                reason: "rate-limited",
                detail: "GitHub API rate limit exceeded.",
              }),
            ),
        }),
      ],
    });

    yield* Effect.flip(
      service.runAction({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        action: "close",
      }),
    );
    const error = yield* Effect.flip(service.list({ state: "open", involvement: "all" }));

    assert.strictEqual(listCalls, 0);
    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("flags a review request for the viewer but not on their own change request", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                { ...changeRequest(1, "2026-07-02T00:00:00Z"), reviewRequestLogins: ["Bilal"] },
                {
                  ...changeRequest(2, "2026-07-02T00:00:00Z"),
                  author: { login: "bilal", name: null, avatarUrl: null },
                  reviewRequestLogins: ["bilal"],
                },
              ],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.viewerReviewRequested),
      [true, false],
    );
  }),
);

it.effect("refuses a repository that does not belong to the requested project", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [fakeProvider("github")],
    });

    const error = yield* service
      .diff({ projectId: "p1" as ProjectId, repository: "attacker/repo", number: 1 })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses a diff on a host that cannot produce one", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on azure",
          workspaceRoot: "/a",
          repository: "org/project",
          provider: "azure-devops",
        }),
      ],
      providers: [
        fakeProvider("azure-devops", {
          capabilities: {
            diff: false,
            comment: true,
            actions: ["merge", "close"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getDiff: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* service
      .diff({ projectId: "p1" as ProjectId, repository: "org/project", number: 1 })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("rejects an empty comment before reaching the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [fakeProvider("github", { comment: () => Effect.die("must not be called") })],
    });

    const error = yield* service
      .comment({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        body: "   ",
      })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses a verdict the host never claimed, without asking the provider", () =>
  Effect.gen(function* () {
    let submitted = false;
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("gitlab", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            // GitLab's shape: it approves, and has nothing that rejects.
            review: {
              inlineComment: true,
              reply: true,
              resolve: true,
              verdicts: ["comment", "approve"],
            },
            reviewers: FULL_REVIEWERS,
          },
          submitReview: () => {
            submitted = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.submitReview({
        projectId: "p1" as ProjectId,
        repository: "group/project",
        number: 1,
        verdict: "request-changes",
        body: "no",
        comments: [],
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.isFalse(submitted);
  }),
);

it.effect("refuses line comments on a host that takes only a summary", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: { inlineComment: false, reply: false, resolve: false, verdicts: ["comment"] },
            reviewers: FULL_REVIEWERS,
          },
          submitReview: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.submitReview({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        verdict: "comment",
        body: "",
        comments: [{ path: "src/a.ts", position: { kind: "added", newLine: 1 }, body: "nit" }],
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect(
  "refuses a review with neither a summary nor a comment, but lets an approval through",
  () =>
    Effect.gen(function* () {
      let approved = false;
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "t3code",
            workspaceRoot: "/a",
            repository: "pingdotgg/t3code",
          }),
        ],
        providers: [
          fakeProvider("github", {
            submitReview: () => {
              approved = true;
              return Effect.void;
            },
          }),
        ],
      });
      const reference = {
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
      };

      const error = yield* Effect.flip(
        service.submitReview({ ...reference, verdict: "comment", body: "   ", comments: [] }),
      );
      assert.strictEqual(error._tag, "PullRequestOperationError");

      // An approval is a verdict in itself, so it needs no words.
      yield* service.submitReview({ ...reference, verdict: "approve", body: "", comments: [] });
      assert.isTrue(approved);
    }),
);

it.effect("refuses to resolve a conversation on a host that cannot", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: { inlineComment: true, reply: false, resolve: false, verdicts: ["comment"] },
            reviewers: FULL_REVIEWERS,
          },
          setThreadResolution: () => Effect.die("must not be called"),
          replyToThread: () => Effect.die("must not be called"),
        }),
      ],
    });
    const reference = {
      projectId: "p1" as ProjectId,
      repository: "pingdotgg/t3code",
      number: 1,
    };

    const resolveError = yield* Effect.flip(
      service.setThreadResolution({ ...reference, threadId: "t1", resolved: true }),
    );
    const replyError = yield* Effect.flip(
      service.replyToThread({ ...reference, threadId: "t1", body: "hi" }),
    );

    assert.strictEqual(resolveError._tag, "PullRequestOperationError");
    assert.strictEqual(replyError._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses to react on a host with no reactions", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: false,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          setReaction: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.setReaction({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        content: "heart",
        reacted: true,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses to react on a host whose capabilities omit reactions entirely", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          setReaction: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.setReaction({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        content: "heart",
        reacted: true,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("passes a reaction through with its subject id on a host that has them", () =>
  Effect.gen(function* () {
    let received: {
      readonly subjectId: string | undefined;
      readonly content: string;
      readonly reacted: boolean;
    } | null = null;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          setReaction: (input) => {
            received = {
              subjectId: input.subjectId,
              content: input.content,
              reacted: input.reacted,
            };
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.setReaction({
      projectId: "p1" as ProjectId,
      repository: "pingdotgg/t3code",
      number: 1,
      subjectId: "IC_1",
      content: "heart",
      reacted: true,
    });

    assert.deepStrictEqual(received, { subjectId: "IC_1", content: "heart", reacted: true });
  }),
);

it.effect("invalidates the cached activity after reacting, like the other mutations", () =>
  Effect.gen(function* () {
    let activityCalls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequestActivity: () => {
            activityCalls += 1;
            return Effect.succeed({
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            });
          },
        }),
      ],
    });

    yield* service.activity(reference);
    assert.strictEqual(activityCalls, 1);

    yield* service.setReaction({ ...reference, content: "heart", reacted: true });
    yield* service.activity(reference);

    assert.strictEqual(activityCalls, 2);
  }),
);

it.effect("refuses an empty reply before it reaches the host", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", { replyToThread: () => Effect.die("must not be called") }),
      ],
    });

    const error = yield* Effect.flip(
      service.replyToThread({
        projectId: "p1" as ProjectId,
        repository: "pingdotgg/t3code",
        number: 1,
        threadId: "t1",
        body: "   ",
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
  }),
);

it.effect("refuses a merge strategy the host does not offer", () =>
  Effect.gen(function* () {
    let ranWith: string | null = null;
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            // Azure DevOps's shape: it squashes as a completion option and has no rebase.
            mergeMethods: ["merge", "squash"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          runAction: (input) => {
            ranWith = input.mergeMethod ?? "merge";
            return Effect.void;
          },
        }),
      ],
    });
    const reference = {
      projectId: "p1" as ProjectId,
      repository: "pingdotgg/t3code",
      number: 1,
    };

    // Every provider maps an unrecognised strategy to its own default, so letting this through
    // would merge with the wrong one rather than fail.
    const error = yield* Effect.flip(
      service.runAction({ ...reference, action: "merge", mergeMethod: "rebase" }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(ranWith, null);

    yield* service.runAction({ ...reference, action: "merge", mergeMethod: "squash" });
    assert.strictEqual(ranWith, "squash");
  }),
);

it.effect("hands the provider the host its repository lives on", () =>
  Effect.gen(function* () {
    const hosts: string[] = [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "enterprise",
          workspaceRoot: "/a",
          repository: "acme/web",
          host: "github.acme.dev",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            hosts.push(input.host);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });

    // The identity a project records is the path below its host, so the host has to travel
    // separately or a GitHub Enterprise repository is read off github.com instead.
    assert.deepStrictEqual(hosts, ["github.acme.dev"]);
  }),
);

it.effect("asks every host the reader's search, rather than filtering what came back", () =>
  Effect.gen(function* () {
    const asked: Array<string | undefined> = [];
    const listing = (input: { readonly query?: string | undefined }) => {
      asked.push(input.query);
      return Effect.succeed({ items: [], truncated: false, continues: true });
    };
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({
          id: "p2",
          title: "on gitlab",
          workspaceRoot: "/b",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", { listChangeRequests: listing }),
        fakeProvider("gitlab", { listChangeRequests: listing }),
      ],
    });

    yield* service.list({ state: "open", query: "pull requests page" });

    // A page holds one page per repository, so a search that stopped at the service could only
    // find what was already loaded.
    assert.deepStrictEqual(asked, ["pull requests page", "pull requests page"]);
  }),
);

it.effect("asks for no search when the reader has typed nothing", () =>
  Effect.gen(function* () {
    const asked: Array<string | undefined> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: (input) => {
            asked.push(input.query);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [undefined]);
  }),
);

it.effect("asks another checkout who is signed in when the first one cannot answer", () =>
  Effect.gen(function* () {
    const asked: string[] = [];
    const service = yield* makeService({
      projects: [
        // One repository, checked out twice. The listing reads it once; the viewer lookup has
        // two places to ask.
        project({
          id: "p1",
          title: "t3code (stale worktree)",
          workspaceRoot: "/gone",
          repository: "pingdotgg/t3code",
        }),
        project({
          id: "p2",
          title: "t3code",
          workspaceRoot: "/healthy",
          repository: "pingdotgg/t3code",
        }),
      ],
      providers: [
        fakeProvider("github", {
          getViewer: (input) => {
            asked.push(input.cwd);
            return input.cwd === "/gone"
              ? Effect.fail(
                  new PullRequestProviderError({
                    provider: "github",
                    operation: "getViewer",
                    reason: "failed",
                    detail: "not a git repository",
                  }),
                )
              : Effect.succeed("bilal");
          },
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

    // De-duplicating the listing must not throw away the checkouts the fallback needs: the
    // host is readable, so it is read.
    assert.deepStrictEqual(asked, ["/gone", "/healthy"]);
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.providers[0]?.configured, true);
  }),
);

it.effect("refuses to ask for a review on a host that cannot, before any call is made", () =>
  Effect.gen(function* () {
    let asked = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: { request: false, listCandidates: false },
          },
          getViewerPermissions: () => {
            asked = true;
            return Effect.die("must not be called");
          },
          setReviewerRequest: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.requestReviewers({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: true,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "cannot ask somebody for a review.");
    assert.isFalse(asked);
  }),
);

it.effect("refuses the candidate list on a host that has no such list to give", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: false,
            comment: false,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: false,
            reactions: true,
            review: FULL_REVIEW,
            // Azure's shape: it takes a reviewer, and names nobody who could be one.
            reviewers: { request: true, listCandidates: false },
          },
          listReviewerCandidates: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.reviewerCandidates({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "cannot say who may review a change request.");
  }),
);

it.effect("refuses a review request this viewer may not make, and says what access it takes", () =>
  Effect.gen(function* () {
    let sent = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          // The host asks for reviews; this account only reads the repository.
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["ready", "draft", "close", "reopen"],
              comment: true,
              resolve: true,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: false,
            }),
          setReviewerRequest: () => {
            sent = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.requestReviewers({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: true,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "You need write access on this repository to ask for a review.");
    assert.isFalse(sent);
  }),
);

it.effect("keeps the menu from a viewer who may not ask, which is all it is for", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getViewerPermissions: () =>
            Effect.succeed({
              actions: [],
              comment: true,
              resolve: false,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: false,
            }),
          listReviewerCandidates: () => Effect.die("must not be called"),
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.reviewerCandidates({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
      }),
    );

    assert.include(error.message, "You need write access on this repository to ask for a review.");
  }),
);

it.effect("hands the host's own candidate list back, and asks for it with the change request", () =>
  Effect.gen(function* () {
    let askedFor: number | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          listReviewerCandidates: (input) => {
            askedFor = input.number;
            return Effect.succeed({
              candidates: [
                {
                  id: "octocat",
                  kind: "user",
                  login: "octocat",
                  name: null,
                  avatarUrl: null,
                  isRequested: true,
                },
              ],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const list = yield* service.reviewerCandidates({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 4,
    });

    assert.strictEqual(askedFor, 4);
    assert.deepStrictEqual(
      list.candidates.map((candidate) => candidate.login),
      ["octocat"],
    );
  }),
);

it.effect("refuses a label change on a host that has not said it takes one", () =>
  Effect.gen(function* () {
    let changed = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          // The method is there; the capability that would let it be called is not.
          setLabels: () => {
            changed = true;
            return Effect.void;
          },
        }),
      ],
    });

    const error = yield* Effect.flip(
      service.setLabels({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        labels: ["bug"],
        applied: true,
      }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "cannot change the labels");
    assert.isFalse(changed);
  }),
);

it.effect("refuses a label change this viewer may not make, and says what access it takes", () =>
  Effect.gen(function* () {
    let changed = false;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: { ...fakeProvider("github").capabilities, labels: true },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: [],
              comment: true,
              resolve: false,
              verdicts: ["comment", "approve", "request-changes"],
              requestReviewers: false,
              labels: false,
            }),
          listLabelCandidates: () => Effect.die("must not be called"),
          setLabels: () => {
            changed = true;
            return Effect.void;
          },
        }),
      ],
    });

    const listError = yield* Effect.flip(
      service.labelCandidates({ projectId: "p1" as ProjectId, repository: "acme/web", number: 1 }),
    );
    assert.include(listError.message, "You need triage access on this repository");

    const error = yield* Effect.flip(
      service.setLabels({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        labels: ["bug"],
        applied: true,
      }),
    );
    assert.include(error.message, "You need triage access on this repository");
    assert.isFalse(changed);
  }),
);

it.effect("hands a label change to the host, and reads the labels back for the menu", () =>
  Effect.gen(function* () {
    let received: { labels: ReadonlyArray<string>; applied: boolean } | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: { ...fakeProvider("github").capabilities, labels: true },
          listLabelCandidates: () =>
            Effect.succeed({
              candidates: [{ name: "bug", color: null, description: null, isApplied: false }],
              truncated: false,
            }),
          setLabels: (input) => {
            received = { labels: input.labels, applied: input.applied };
            return Effect.void;
          },
        }),
      ],
    });

    const list = yield* service.labelCandidates({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 4,
    });
    assert.deepStrictEqual(
      list.candidates.map((label) => label.name),
      ["bug"],
    );

    yield* service.setLabels({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 4,
      labels: ["bug"],
      applied: false,
    });
    assert.deepStrictEqual(received, { labels: ["bug"], applied: false });
  }),
);

it.effect("answers a repeated listing from cache, and concurrent readers share one request", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () => {
            hostCalls += 1;
            return Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
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

it.effect("shares one cold viewer lookup across distinct concurrent lists", () =>
  Effect.gen(function* () {
    let viewerCalls = 0;
    let listCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getViewer: () =>
            Effect.sync(() => {
              viewerCalls += 1;
            }).pipe(Effect.andThen(Effect.yieldNow), Effect.as("bilal")),
          listChangeRequests: () =>
            Effect.sync(() => {
              listCalls += 1;
              return { items: [], truncated: false, continues: true };
            }),
        }),
      ],
    });

    yield* Effect.all(
      ["all", "authored", "reviewing"].map((involvement) =>
        service.list({
          state: "open",
          involvement: involvement as "all" | "authored" | "reviewing",
        }),
      ),
      { concurrency: "unbounded" },
    );

    assert.strictEqual(viewerCalls, 1);
    assert.strictEqual(listCalls, 3);
  }),
);

it.effect("uses five host reads for the normal indexed-repository page workflow", () =>
  Effect.gen(function* () {
    let viewerCalls = 0;
    let searchCalls = 0;
    let fallbackCalls = 0;
    let statsCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getViewer: () =>
            Effect.sync(() => {
              viewerCalls += 1;
              return "bilal";
            }),
          listChangeRequestsAcross: (input) =>
            Effect.sync(() => {
              searchCalls += 1;
              return {
                items:
                  input.involvement === "all"
                    ? [batchedChangeRequest(1, "acme/web", "2026-07-02T00:00:00Z")]
                    : [],
                truncated: false,
              };
            }),
          listChangeRequests: () =>
            Effect.sync(() => {
              fallbackCalls += 1;
              return { items: [], truncated: false, continues: true };
            }),
          listChangeRequestStats: () =>
            Effect.sync(() => {
              statsCalls += 1;
              return [{ repository: "acme/web", number: 1, additions: 3, deletions: 1 }];
            }),
        }),
      ],
    });

    const baseline = yield* service.list({ state: "open", involvement: "all" });
    yield* Effect.all(
      [
        service.list({ state: "open", involvement: "authored" }),
        service.list({ state: "open", involvement: "reviewing" }),
      ],
      { concurrency: "unbounded" },
    );
    yield* service.listStats({
      refs: baseline.entries.map(({ projectId, repository, number }) => ({
        projectId,
        repository,
        number,
      })),
    });

    assert.deepStrictEqual(
      { viewerCalls, searchCalls, fallbackCalls, statsCalls },
      { viewerCalls: 1, searchCalls: 3, fallbackCalls: 0, statsCalls: 1 },
    );
  }),
);

it.effect("returns the refreshed listing on the first read after its cache expires", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () => {
            hostCalls += 1;
            return Effect.succeed({
              items: [changeRequest(hostCalls, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: false,
            });
          },
        }),
      ],
    });

    const first = yield* service.list({ state: "open" });
    assert.deepStrictEqual(
      first.entries.map((entry) => entry.number),
      [1],
    );

    yield* TestClock.adjust("31 seconds");
    const refreshed = yield* service.list({ state: "open" });

    assert.strictEqual(hostCalls, 2);
    assert.deepStrictEqual(
      refreshed.entries.map((entry) => entry.number),
      [2],
    );
  }),
);

it.effect("a listing narrowed to some projects is its own cache entry", () =>
  Effect.gen(function* () {
    const asked: ReadonlyArray<string>[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequestsAcross: (input) => {
            asked.push(input.repositories);
            return Effect.succeed({
              items: input.repositories.map((repository, index) =>
                batchedChangeRequest(index + 1, repository, "2026-07-02T00:00:00Z"),
              ),
              truncated: false,
            });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    const narrowed = yield* service.list({ state: "open", projectIds: ["p2" as ProjectId] });

    // The narrowing is part of the key, so it reads its own scope instead of the wider answer.
    assert.deepStrictEqual(asked, [["acme/web", "acme/docs"], ["acme/docs"]]);
    assert.deepStrictEqual(
      narrowed.entries.map((entry) => entry.repository),
      ["acme/docs"],
    );

    // Asking again with the same narrowing, ordered differently, is still the same answer.
    yield* service.list({ state: "open", projectIds: ["p2" as ProjectId] });
    assert.strictEqual(asked.length, 2);
  }),
);

it.effect("an explicit invalidation makes the next listing ask the host again", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    let viewerCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getViewer: () => {
            viewerCalls += 1;
            return Effect.succeed("bilal");
          },
          listChangeRequests: () => {
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
    assert.strictEqual(viewerCalls, 2);

    // Forgetting one change request leaves the listings shared.
    yield* service.invalidate({
      reference: { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 },
    });
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("a mutation makes the next listing ask the host again, with no client asking", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          listChangeRequests: () => {
            hostCalls += 1;
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });

    yield* service.list({ state: "open" });
    yield* service.runAction({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      action: "close",
    });
    yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);
  }),
);

it.effect("does not cache a failed listing", () =>
  Effect.gen(function* () {
    let hostCalls = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          // The viewer lookup is what fails the whole listing rather than one repository.
          getViewer: () => {
            hostCalls += 1;
            return hostCalls === 1 ? Effect.fail(requestFailed) : Effect.succeed("bilal");
          },
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));
    assert.strictEqual(error._tag, "PullRequestOperationError");
    const second = yield* service.list({ state: "open" });
    assert.strictEqual(hostCalls, 2);
    assert.strictEqual(second.providers[0]?.configured, true);
  }),
);

it.effect("reads a host's repositories in one search, and files the rows back under each", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "web", workspaceRoot: "/b", repository: "acme/web" }),
        project({
          id: "p3",
          title: "on gitlab",
          workspaceRoot: "/c",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
          listChangeRequestsAcross: (input) => {
            asked.push(input.repositories);
            return Effect.succeed({
              items: [
                batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z"),
                batchedChangeRequest(2, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
              ],
              truncated: false,
            });
          },
        }),
        // A host with no search across repositories keeps being asked one at a time.
        fakeProvider("gitlab", {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [changeRequest(3, "2026-07-01T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [["pingdotgg/t3code", "acme/web"]]);
    assert.deepStrictEqual(separately, ["group/project"]);
    // Ordered by update across every host, and each row under the project whose repository it
    // came from.
    assert.deepStrictEqual(
      result.entries.map((entry) => [entry.projectId, entry.number]),
      [
        ["p2", 1],
        ["p1", 2],
        ["p3", 3],
      ],
    );
  }),
);
it.effect("carries every repository of a slice on from the oldest row in it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
        project({ id: "p2", title: "web", workspaceRoot: "/b", repository: "acme/web" }),
        project({ id: "p3", title: "docs", workspaceRoot: "/c", repository: "acme/docs" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequestsAcross: () =>
            Effect.succeed({
              items: [
                batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z"),
                batchedChangeRequest(2, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
                batchedChangeRequest(3, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: true,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // The boundary is the oldest row of the whole slice, not of each repository: `acme/web` has
    // been read past its newest row, so only the rows sent at the boundary are named for it.
    // `acme/docs`, which the slice holds nothing of, is not believed on silence alone — it is
    // read on its own, and that read is what says whether it has anything at all.
    assert.isTrue(result.truncated);
    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|2",
      "github.com acme/web": "2026-07-02T00:00:00Z|2|3",
    });
  }),
);
it.effect("carries a slice on without sending the rows it already sent", () =>
  Effect.gen(function* () {
    const cursors: Array<unknown> = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          listChangeRequestsAcross: (input) => {
            cursors.push(input.cursor);
            return Effect.succeed({
              items: [
                batchedChangeRequest(3, "acme/web", "2026-07-02T00:00:00Z"),
                batchedChangeRequest(4, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: true,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({
      state: "open",
      cursors: { "github.com acme/web": "2026-07-02T00:00:00Z|1|3" },
    });

    // The boundary instant is asked for inclusively, so the row already sent at it comes back and
    // is dropped here — and stays named in the next cursor, which has not moved off that instant.
    assert.deepStrictEqual(cursors, [{ updatedBefore: "2026-07-02T00:00:00Z", delivered: 1 }]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [4],
    );
    assert.deepStrictEqual(result.nextCursors, {
      "github.com acme/web": "2026-07-02T00:00:00Z|2|3,3,4",
    });
  }),
);
it.effect("reads a workspace larger than one search in chunks, and merges them", () =>
  Effect.gen(function* () {
    const asked: Array<number> = [];
    const service = yield* makeService({
      projects: Array.from({ length: 101 }, (_, index) =>
        project({
          id: `p${index}`,
          title: `repo ${index}`,
          workspaceRoot: `/w${index}`,
          repository: `acme/repo${index}`,
        }),
      ),
      providers: [
        fakeProvider("github", {
          listChangeRequestsAcross: (input) => {
            asked.push(input.repositories.length);
            return Effect.succeed({
              items: input.repositories.map((repository, index) =>
                batchedChangeRequest(index + 1, repository, "2026-07-02T00:00:00Z"),
              ),
              truncated: false,
            });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, [100, 1]);
    assert.strictEqual(result.entries.length, 101);
  }),
);
it.effect("asks on its own for a repository a search answered nothing for", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return repository === "acme/docs"
              ? Effect.fail(requestFailed)
              : Effect.succeed({ items: [], truncated: false, continues: true });
          },
          listChangeRequestsAcross: () =>
            Effect.succeed({
              items: [batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z")],
              truncated: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // The slice had room and still held nothing of `acme/docs`, which is what a repository GitHub
    // will not search looks like — so it is read the old way, and its failure is still reported
    // against its own project.
    assert.deepStrictEqual(separately, ["acme/docs"]);
    assert.deepStrictEqual(result.errors, [
      {
        projectId: "p2" as ProjectId,
        projectTitle: "docs",
        message: "acme/docs could not be read.",
      },
    ]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1],
    );
  }),
);
it.effect("reads the repositories one at a time when the search itself fails", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakeProvider("github", {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({
              items: [changeRequest(1, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            });
          },
          listChangeRequestsAcross: () => Effect.fail(requestFailed),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    // One failed question about two repositories is not two unreadable repositories.
    assert.deepStrictEqual(separately.toSorted(), ["acme/docs", "acme/web"]);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.entries.length, 2);
  }),
);
it.effect("fills in the line counts for the rows it is given", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
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
          listChangeRequestStats: (input) => {
            asked.push(input.changeRequests);
            return Effect.succeed([
              { repository: "acme/web", number: 1, additions: 12, deletions: 3 },
            ]);
          },
        }),
        // Its listing carries the counts already, so it has nothing to be asked.
        fakeProvider("gitlab"),
      ],
    });

    const result = yield* service.listStats({
      refs: [
        { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 },
        { projectId: "p1" as ProjectId, repository: "acme/web", number: 2 },
        { projectId: "p2" as ProjectId, repository: "group/project", number: 3 },
        // Not the repository this project's remote points at, so it is dropped rather than asked.
        { projectId: "p1" as ProjectId, repository: "evil/repo", number: 4 },
      ],
    });

    assert.deepStrictEqual(asked, [
      [
        { repository: "acme/web", number: 1 },
        { repository: "acme/web", number: 2 },
      ],
    ]);
    // Only the rows the host answered for; the other is left with whatever the listing had.
    assert.deepStrictEqual(result.stats, [
      {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        additions: 12,
        deletions: 3,
      },
    ]);
  }),
);
it.effect("keeps the rows when the line counts cannot be read", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", { listChangeRequestStats: () => Effect.fail(requestFailed) }),
      ],
    });

    const result = yield* service.listStats({
      refs: [{ projectId: "p1" as ProjectId, repository: "acme/web", number: 1 }],
    });

    assert.deepStrictEqual(result.stats, []);
  }),
);

it.effect(
  "serves core detail without waiting for activity, and shares activity between clients",
  () =>
    Effect.gen(function* () {
      let coreCalls = 0;
      let activityCalls = 0;
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakeProvider("github", {
            getChangeRequest: () => {
              coreCalls += 1;
              return Effect.succeed({
                ...changeRequest(1, "2026-07-02T00:00:00Z"),
                body: "Ready before the conversation",
                changedFiles: 2,
                mergedAt: null,
                closedAt: null,
                reviewers: [],
                checks: [],
                mergeCapabilities: { merge: true, squash: true, rebase: true },
                viewerPermissions: {
                  actions: ["merge"],
                  comment: true,
                  resolve: true,
                  verdicts: ["comment", "approve", "request-changes"],
                  requestReviewers: true,
                },
              });
            },
            getChangeRequestActivity: () => {
              activityCalls += 1;
              return Effect.succeed({
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              });
            },
          }),
        ],
      });

      const core = yield* service.detail(reference);
      assert.strictEqual(core.body, "Ready before the conversation");
      assert.strictEqual(coreCalls, 1);
      assert.strictEqual(activityCalls, 0);

      yield* Effect.all([service.activity(reference), service.activity(reference)], {
        concurrency: 2,
      });
      assert.strictEqual(activityCalls, 1);

      yield* service.invalidate({ reference });
      yield* service.activity(reference);
      assert.strictEqual(activityCalls, 2);
    }),
);

it.effect("shares linked summaries and reuses them for display without asking the host again", () =>
  Effect.gen(function* () {
    let calls = 0;
    let failing = false;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequestSummary: () =>
            Effect.sync(() => {
              calls += 1;
              return failing;
            }).pipe(
              Effect.tap(() => Effect.yieldNow),
              Effect.flatMap((shouldFail) =>
                shouldFail
                  ? Effect.fail(
                      new PullRequestProviderError({
                        provider: "github",
                        operation: "getChangeRequestSummary",
                        reason: "failed",
                        detail: "HTTP 504",
                      }),
                    )
                  : Effect.succeed(changeRequest(1, "2026-07-02T00:00:00Z")),
              ),
            ),
        }),
      ],
    });

    yield* Effect.all(
      [
        service.summary(reference, { recoverTransientFailure: false }),
        service.summary(reference, { recoverTransientFailure: false }),
      ],
      { concurrency: "unbounded" },
    );
    assert.strictEqual(calls, 1);

    yield* TestClock.adjust("61 seconds");
    failing = true;
    const strict = yield* Effect.flip(
      service.summary(reference, { recoverTransientFailure: false }),
    );
    assert.strictEqual(strict._tag, "PullRequestOperationError");

    const stale = yield* service.summary(reference);
    assert.strictEqual(stale.updatedAt, "2026-07-02T00:00:00Z");
    // Display reads keep the last title and state rather than asking the host again.
    assert.strictEqual(calls, 2);

    yield* service.invalidate({ reference });
    const invalidated = yield* Effect.flip(service.summary(reference));
    assert.strictEqual(invalidated._tag, "PullRequestOperationError");
  }),
);

it.effect("answers a known pull request immediately while the host refreshes", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let calls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () =>
            Effect.gen(function* () {
              calls += 1;
              if (calls > 1) yield* Deferred.await(gate);
              return hostedChangeRequest("cached body", 4);
            }),
        }),
      ],
    });

    const first = yield* service.detail(reference);
    assert.strictEqual(first.body, "cached body");
    assert.strictEqual(first.additions, 4);

    yield* TestClock.adjust("16 seconds");
    const second = yield* service.detail(reference);
    assert.strictEqual(second.body, "cached body");
    assert.strictEqual(second.additions, 4);
    yield* Effect.yieldNow;
    assert.strictEqual(calls, 2);
  }),
);

it.effect("does not ask the host again for a linked summary it already holds", () =>
  Effect.gen(function* () {
    let calls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequestSummary: () =>
            Effect.sync(() => {
              calls += 1;
              return changeRequest(1, "2026-07-02T00:00:00Z");
            }),
        }),
      ],
    });

    const first = yield* service.summary(reference);
    assert.strictEqual(first.title, "Change request 1");
    yield* TestClock.adjust("61 seconds");
    const second = yield* service.summary(reference);
    assert.strictEqual(second.title, "Change request 1");
    assert.strictEqual(calls, 1);
  }),
);

it.effect("reuses an observed merged state for strict settlement reads", () =>
  Effect.gen(function* () {
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () =>
            Effect.succeed({
              ...hostedChangeRequest("merged body", 4),
              state: "merged",
              updatedAt: "2026-07-03T00:00:00Z",
            }),
          getChangeRequestSummary: () => Effect.die("strict merged state must not refresh"),
        }),
      ],
    });

    yield* service.detail(reference);

    const summary = yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual(summary.state, "merged");
    assert.strictEqual(summary.updatedAt, "2026-07-03T00:00:00Z");
  }),
);

it.effect("does not let a stale detail reopen overwrite a fresher linked summary", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let detailCalls = 0;
    let summaryTitle = "old title";
    let summaryState: "open" | "merged" = "open";
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () =>
            Effect.gen(function* () {
              detailCalls += 1;
              if (detailCalls > 1) yield* Deferred.await(gate);
              return hostedChangeRequest("old body", 4);
            }),
          getChangeRequestSummary: () =>
            Effect.succeed({
              ...changeRequest(1, "2026-07-02T00:00:00Z"),
              title: summaryTitle,
              state: summaryState,
            }),
        }),
      ],
    });

    const first = yield* service.detail(reference);
    assert.strictEqual(first.title, "Change request 1");

    summaryTitle = "merged title";
    summaryState = "merged";
    yield* TestClock.adjust("61 seconds");
    const settled = yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual(settled.title, "merged title");
    assert.strictEqual(settled.state, "merged");

    yield* TestClock.adjust("16 seconds");
    const stale = yield* service.detail(reference);
    assert.strictEqual(stale.title, "Change request 1");
    yield* Effect.yieldNow;

    const display = yield* service.summary(reference);
    assert.strictEqual(display.title, "merged title");
    assert.strictEqual(display.state, "merged");
    assert.strictEqual(detailCalls, 2);
  }),
);

it.effect("does not let a still-cached detail overwrite a fresher linked summary", () =>
  Effect.gen(function* () {
    let summaryTitle = "old title";
    let summaryState: "open" | "merged" = "open";
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () => Effect.succeed(hostedChangeRequest("old body", 4)),
          getChangeRequestSummary: () =>
            Effect.succeed({
              ...changeRequest(1, "2026-07-02T00:00:00Z"),
              title: summaryTitle,
              state: summaryState,
            }),
        }),
      ],
    });

    const first = yield* service.detail(reference);
    assert.strictEqual(first.title, "Change request 1");

    summaryTitle = "merged title";
    summaryState = "merged";
    const settled = yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual(settled.state, "merged");

    const cached = yield* service.detail(reference);
    assert.strictEqual(cached.title, "Change request 1");
    yield* Effect.yieldNow;

    const display = yield* service.summary(reference);
    assert.strictEqual(display.title, "merged title");
    assert.strictEqual(display.state, "merged");
  }),
);

it.effect("keeps recent detail on a transient refresh failure but not after invalidation", () =>
  Effect.gen(function* () {
    let failing = false;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () =>
            failing
              ? Effect.fail(
                  new PullRequestProviderError({
                    provider: "github",
                    operation: "getChangeRequest",
                    reason: "failed",
                    detail: "spawn gh EAGAIN",
                  }),
                )
              : Effect.succeed({
                  ...changeRequest(1, "2026-07-02T00:00:00Z"),
                  body: "last good body",
                  changedFiles: 2,
                  mergedAt: null,
                  closedAt: null,
                  reviewers: [],
                  checks: [],
                  mergeCapabilities: { merge: true, squash: true, rebase: true },
                  viewerPermissions: {
                    actions: ["merge"],
                    comment: true,
                    resolve: true,
                    verdicts: ["comment", "approve", "request-changes"],
                    requestReviewers: true,
                  },
                }),
        }),
      ],
    });

    yield* service.detail(reference);
    yield* TestClock.adjust("16 seconds");
    failing = true;
    const stale = yield* service.detail(reference);
    assert.strictEqual(stale.body, "last good body");

    yield* service.invalidate({ reference });
    const invalidated = yield* Effect.flip(service.detail(reference));
    assert.strictEqual(invalidated._tag, "PullRequestOperationError");
  }),
);

it.effect("carries an armed auto-merge through to the detail, and silence as silence", () =>
  Effect.gen(function* () {
    const detailWith = (autoMergeEnabled: boolean | undefined) =>
      Effect.gen(function* () {
        const service = yield* makeService({
          projects: [
            project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
          ],
          providers: [
            fakeProvider("github", {
              getChangeRequest: () =>
                Effect.succeed({
                  ...changeRequest(1, "2026-07-02T00:00:00Z"),
                  body: "",
                  changedFiles: 0,
                  mergedAt: null,
                  closedAt: null,
                  reviewers: [],
                  checks: [],
                  mergeCapabilities: { merge: true, squash: true, rebase: true },
                  viewerPermissions: {
                    actions: ["merge"],
                    comment: true,
                    resolve: true,
                    verdicts: ["comment", "approve", "request-changes"],
                    requestReviewers: true,
                  },
                  ...(autoMergeEnabled === undefined ? {} : { autoMergeEnabled }),
                }),
            }),
          ],
        });
        return yield* service.detail({
          projectId: "p1" as ProjectId,
          repository: "acme/web",
          number: 1,
        });
      });

    assert.strictEqual((yield* detailWith(true)).autoMergeEnabled, true);
    assert.strictEqual((yield* detailWith(false)).autoMergeEnabled, false);
    // A host that says nothing leaves the field absent rather than claiming the merge is unarmed.
    assert.isUndefined((yield* detailWith(undefined)).autoMergeEnabled);
  }),
);

it("names an Azure DevOps repository by its own name, not its project path", () => {
  // `az repos pr list --repository` takes a name and detects the organisation and project from
  // the checkout; the recorded `org/project/_git/repo` path is refused, and the repository then
  // reads as unavailable on the page.
  const selector = PullRequestService.repositoryIdentityOf({
    repositoryIdentity: {
      provider: "azure-devops",
      displayName: "contoso/payments/_git/checkout",
      owner: "contoso",
      name: "checkout",
    },
  } as never);
  assert.strictEqual(selector, "checkout");
});

it("falls back to the path's last segment where an Azure identity has no name", () => {
  const selector = PullRequestService.repositoryIdentityOf({
    repositoryIdentity: {
      provider: "azure-devops",
      displayName: "contoso/payments/_git/checkout",
    },
  } as never);
  assert.strictEqual(selector, "checkout");
});

it("keeps a GitLab identity's whole path, because a nested group is part of the name", () => {
  const selector = PullRequestService.repositoryIdentityOf({
    repositoryIdentity: {
      provider: "gitlab",
      displayName: "group/subgroup/service",
      owner: "group",
      name: "service",
    },
  } as never);
  assert.strictEqual(selector, "group/subgroup/service");
});

it.effect("narrows the rows of a host that ignored the filters it was handed", () =>
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
        // Only GitHub narrows a listing for itself; every other host answers unnarrowed, and
        // sending it a draft filter it quietly ignores used to put drafts on a filtered page.
        fakeProvider("gitlab", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                { ...changeRequest(1, "2026-07-02T00:00:00Z"), isDraft: true },
                changeRequest(2, "2026-07-01T00:00:00Z"),
              ],
              truncated: false,
              continues: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open", filters: { draft: "hide" } });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2],
    );
  }),
);

it.effect("keeps a row of a host that ignored the filters if any name of a label group holds", () =>
  Effect.gen(function* () {
    const sized = (number: number, updatedAt: string, ...names: ReadonlyArray<string>) => ({
      ...changeRequest(number, updatedAt),
      labels: names.map((name) => ({ name, color: null })),
    });
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
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                sized(1, "2026-07-04T00:00:00Z", "size:S", "bug"),
                sized(2, "2026-07-03T00:00:00Z", "size:XS", "bug"),
                sized(3, "2026-07-02T00:00:00Z", "size:L", "bug"),
                sized(4, "2026-07-01T00:00:00Z", "size:S"),
              ],
              truncated: false,
              continues: false,
            }),
        }),
      ],
    });

    // Either size satisfies the first group; the second group is its own question, so the row
    // carrying a size but no bug goes.
    const result = yield* service.list({
      state: "open",
      filters: { labels: [["size:S", "size:XS"], ["bug"]] },
    });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1, 2],
    );
  }),
);

it.effect('resolves an author filter of "me" to the viewer before narrowing a host\'s rows', () =>
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
        // Only GitHub narrows a listing for itself, so this fixture's "me" has to be resolved
        // locally too — the same helper both call sites lean on.
        fakeProvider("gitlab", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                changeRequest(1, "2026-07-02T00:00:00Z"),
                {
                  ...changeRequest(2, "2026-07-01T00:00:00Z"),
                  author: { login: "bilal", name: null, avatarUrl: null },
                },
              ],
              truncated: false,
              continues: false,
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open", filters: { author: "me" } });

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [2],
    );
  }),
);

it.effect("refuses a way of updating a branch that the host or the viewer does not allow", () =>
  Effect.gen(function* () {
    let taken: string | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "close", "update-branch"],
            mergeMethods: ["merge"],
            // This host brings a stale branch up to date with a merge commit and nothing else.
            updateMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["close", "update-branch"],
              comment: true,
              resolve: true,
              verdicts: ["comment"],
              requestReviewers: false,
              updateMethods: ["merge"],
            }),
          runAction: (input) => {
            taken = input.updateMethod ?? "default";
            return Effect.void;
          },
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    // Asking for a rebase a host does not offer must fail rather than quietly merge instead.
    const error = yield* Effect.flip(
      service.runAction({ ...reference, action: "update-branch", updateMethod: "rebase" }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(taken, null);

    yield* service.runAction({ ...reference, action: "update-branch", updateMethod: "merge" });
    assert.strictEqual(taken, "merge");
  }),
);

it.effect("refuses to merge a target branch into a source branch on a host that only rebases", () =>
  Effect.gen(function* () {
    let taken = 0;
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: "gitlab",
        }),
      ],
      providers: [
        fakeProvider("gitlab", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "close", "update-branch"],
            mergeMethods: ["merge"],
            // What GitLab declares: it replays the branch, and has no update that merges the
            // target back in.
            updateMethods: ["rebase"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getViewerPermissions: () =>
            Effect.succeed({
              actions: ["close", "update-branch"],
              comment: true,
              resolve: true,
              verdicts: ["comment"],
              requestReviewers: false,
              updateMethods: ["rebase"],
            }),
          runAction: () => {
            taken += 1;
            return Effect.void;
          },
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "group/project", number: 1 };

    // A merge asked of a host that rebases must fail here rather than reach the provider, which
    // would rebase instead and report the wrong thing as done.
    const error = yield* Effect.flip(
      service.runAction({ ...reference, action: "update-branch", updateMethod: "merge" }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(taken, 0);

    yield* service.runAction({ ...reference, action: "update-branch", updateMethod: "rebase" });
    assert.strictEqual(taken, 1);
  }),
);

it.effect("judges the review filter only on a host that summarises its reviews", () =>
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
        // GitHub answers with the field on every row: null is "nobody has decided yet".
        fakeProvider("github", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [
                { ...changeRequest(1, "2026-07-02T00:00:00Z"), reviewDecision: null },
                {
                  ...changeRequest(2, "2026-07-02T00:00:00Z"),
                  reviewDecision: "approved" as const,
                },
              ],
              truncated: false,
              continues: true,
            }),
        }),
        // GitLab never supplies the field, so its rows are not the filter's to judge.
        fakeProvider("gitlab", {
          listChangeRequests: () =>
            Effect.succeed({
              items: [changeRequest(3, "2026-07-02T00:00:00Z")],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

    const none = yield* service.list({ state: "open", filters: { review: "none" } });
    assert.deepStrictEqual(none.entries.map((entry) => entry.number).toSorted(), [1, 3]);

    const approved = yield* service.list({ state: "open", filters: { review: "approved" } });
    assert.deepStrictEqual(approved.entries.map((entry) => entry.number).toSorted(), [2, 3]);
  }),
);

it.effect("sends only the words a rewrite carries", () =>
  Effect.gen(function* () {
    const received: Array<{ title?: string | undefined; body?: string | undefined }> = [];
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          updateChangeRequest: (input) => {
            received.push({ title: input.title, body: input.body });
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.update({ ...reference, title: "A better title" });
    yield* service.update({ ...reference, body: "" });
    yield* service.update({ ...reference, title: "Both", body: "at once" });

    assert.deepStrictEqual(received, [
      { title: "A better title", body: undefined },
      { title: undefined, body: "" },
      { title: "Both", body: "at once" },
    ]);
  }),
);

it.effect("refuses a rewrite that changes nothing, before any call is made", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", { updateChangeRequest: () => Effect.die("must not be called") }),
      ],
    });

    const error = yield* Effect.flip(
      service.update({ projectId: "p1" as ProjectId, repository: "acme/web", number: 1 }),
    );

    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.include(error.message, "Nothing was changed.");
  }),
);

it.effect("refuses to rewrite anything on a host that never claimed it", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          updateChangeRequest: () => Effect.die("must not be called"),
          updateComment: () => Effect.die("must not be called"),
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    const rewriteRefused = yield* Effect.flip(service.update({ ...reference, title: "New" }));
    const commentRefused = yield* Effect.flip(
      service.updateComment({
        ...reference,
        commentId: "IC_1",
        kind: "issue-comment",
        body: "New",
      }),
    );

    assert.include(rewriteRefused.message, "cannot rewrite a change request.");
    assert.include(commentRefused.message, "cannot rewrite a comment.");
  }),
);

it.effect("passes a rewritten remark through with the id and kind it arrived under", () =>
  Effect.gen(function* () {
    let received: { id: string; kind: string; body: string } | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          updateComment: (input) => {
            received = { id: input.commentId, kind: input.kind, body: input.body };
            return Effect.void;
          },
        }),
      ],
    });

    yield* service.updateComment({
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      commentId: "PRRC_1",
      kind: "review-comment",
      body: "Second thoughts",
    });

    assert.deepStrictEqual(received, {
      id: "PRRC_1",
      kind: "review-comment",
      body: "Second thoughts",
    });
  }),
);

it.effect("refuses a remark rewritten into nothing but whitespace", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", { updateComment: () => Effect.die("must not be called") }),
      ],
    });

    const error = yield* Effect.flip(
      service.updateComment({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        commentId: "IC_1",
        kind: "issue-comment",
        body: "   \n  ",
      }),
    );

    assert.include(error.message, "A comment cannot be empty.");
  }),
);

it.effect("forgets the cached detail after a rewrite, like the other mutations", () =>
  Effect.gen(function* () {
    let coreCalls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakeProvider("github", {
          getChangeRequest: () => {
            coreCalls += 1;
            return Effect.succeed({
              ...changeRequest(1, "2026-07-02T00:00:00Z"),
              body: "",
              changedFiles: 0,
              mergedAt: null,
              closedAt: null,
              reviewers: [],
              checks: [],
              mergeCapabilities: { merge: true, squash: true, rebase: true },
              viewerPermissions: {
                actions: ["merge"],
                comment: true,
                resolve: true,
                verdicts: ["comment", "approve", "request-changes"],
                requestReviewers: true,
              },
            });
          },
        }),
      ],
    });

    yield* service.detail(reference);
    yield* service.update({ ...reference, title: "Renamed" });
    yield* service.detail(reference);

    assert.strictEqual(coreCalls, 2);
  }),
);

it.effect("names the signed-in account in the detail, and says nothing where the host cannot", () =>
  Effect.gen(function* () {
    const detailFrom = (provider: PullRequestProviderApi) =>
      Effect.gen(function* () {
        const service = yield* makeService({
          projects: [
            project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
          ],
          providers: [provider],
        });
        return yield* service.detail({
          projectId: "p1" as ProjectId,
          repository: "acme/web",
          number: 1,
        });
      });
    const readable = fakeProvider("github", {
      getChangeRequest: () =>
        Effect.succeed({
          ...changeRequest(1, "2026-07-02T00:00:00Z"),
          body: "",
          changedFiles: 0,
          mergedAt: null,
          closedAt: null,
          reviewers: [],
          checks: [],
          mergeCapabilities: { merge: true, squash: true, rebase: true },
          viewerPermissions: {
            actions: ["merge"],
            comment: true,
            resolve: true,
            verdicts: ["comment", "approve", "request-changes"],
            requestReviewers: true,
          },
        }),
    });

    const named = yield* detailFrom(readable);
    const unnamed = yield* detailFrom({
      ...readable,
      getViewer: () => Effect.fail(unusable("github", "unauthenticated")),
    });

    assert.strictEqual(named.viewer, "bilal");
    assert.strictEqual(unnamed.viewer, undefined);
  }),
);
