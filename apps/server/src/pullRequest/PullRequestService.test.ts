import { SourceControlProviderKind } from "@t3tools/contracts";
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

function project(input: {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
  readonly remoteUrl?: string;
}): OrchestrationProjectShell {
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
              remoteUrl: input.remoteUrl ?? `https://${host}/${input.repository}.git`,
            },
            provider: SourceControlProviderKind.make(input.provider ?? "github"),
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

it.effect("does not wait for an in-flight detail read to display a preview", () =>
  Effect.gen(function* () {
    const detailStarted = yield* Deferred.make<void>();
    const releaseDetail = yield* Deferred.make<void>();
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/w", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Deferred.succeed(detailStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDetail)),
              Effect.as(hostedChangeRequest("Description")),
            ),
          getChangeRequestPreview: () => Effect.succeed(changeRequest(1, "2026-07-02T00:00:00Z")),
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const detail = yield* Effect.forkChild(service.detail(ref));
    yield* Deferred.await(detailStarted);
    assert.strictEqual((yield* service.preview(ref)).title, "Change request 1");
    yield* Deferred.succeed(releaseDetail, undefined);
    yield* Fiber.join(detail);
  }),
);

function unusable(provider: SourceControlProviderKind, reason: "missing-tool" | "unauthenticated") {
  return new PullRequestProviderError({
    provider,
    operation: "getViewer",
    reason,
    detail: `${provider} is not usable.`,
  });
}

const requestFailed = new PullRequestProviderError({
  provider: SourceControlProviderKind.make("github"),
  operation: "listChangeRequests",
  reason: "failed",
  detail: "HTTP 404",
});

const FULL_REVIEW: PullRequestReviewCapabilities = {
  inlineComment: true,
  reply: true,
  resolve: true,
  verdicts: ["comment", "approve", "request-changes"],
};

const FULL_REVIEWERS: PullRequestReviewerCapabilities = { request: true, listCandidates: true };

// Like Azure DevOps, whose repository names repeat across organizations and projects.
const keyedByCanonicalKey = {
  repositoryKey: ({ canonicalKey }: { readonly canonicalKey: string }) => canonicalKey,
};

/** A host whose SSH remotes name an alias, so discovery says which server serves them. */
const sshAliasHost = {
  resolveRemoteWebHost: ({ cwd, context, resolveContext }) =>
    isSshRemoteUrl(context.remoteUrl)
      ? resolveContext({
          cwd,
          context: {
            ...context,
            provider: { kind: SourceControlProviderKind.make("unknown"), name: "", baseUrl: "" },
          },
        }).pipe(
          Effect.map((resolved) =>
            resolved === null || resolved.provider.kind === "unknown"
              ? null
              : new URL(resolved.provider.baseUrl).host,
          ),
        )
      : Effect.succeed(null),
} as SourceControlProvider["Service"];

function makeService(input: {
  readonly settings?: ServerSettings;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers: ReadonlyArray<PullRequestProviderApi>;
  readonly resolveHandle?: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"]["resolveHandle"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]["resolve"];
}) {
  // Build in the test scope; per-call Effect.provide would close the marks database on service acquisition.
  return Effect.flatMap(
    Layer.build(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(input.settings ?? DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders(input.providers),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle:
            input.resolveHandle ?? (() => Effect.die("Unexpected provider refinement")),
          get: (kind) =>
            Effect.succeed(
              kind === "forgejo" ? sshAliasHost : ({} as SourceControlProvider["Service"]),
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (options) =>
            Effect.succeed(
              input.projects.filter((project) => options?.projectIds?.includes(project.id) ?? true),
            ),
          getShell: (projectId) =>
            Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: input.resolveRepositoryIdentity ?? (() => Effect.succeed(null)),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );
}

it.effect("lists GitHub Enterprise PRs for a stored unknown repository after host discovery", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "enterprise",
          workspaceRoot: "/repo",
          repository: "team/project",
          provider: SourceControlProviderKind.make("unknown"),
          host: "code.example.test",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: ({ host, repository }) => {
            assert.strictEqual(host, "code.example.test");
            assert.strictEqual(repository, "team/project");
            return Effect.succeed({
              items: [changeRequest(42, "2026-07-05T00:00:00Z")],
              truncated: false,
              continues: false,
            });
          },
        }),
      ],
      resolveHandle: ({ context }) => {
        assert.ok(context);
        return Effect.succeed({
          context: {
            ...context,
            provider: {
              ...context.provider,
              kind: SourceControlProviderKind.make("github"),
              name: "GitHub Self-Hosted",
            },
          },
          provider: undefined as never,
        });
      },
    });
    const result = yield* service.list({ state: "open" });
    assert.deepStrictEqual(
      result.entries.map(({ host, number }) => [host, number]),
      [["code.example.test", 42]],
    );
  }),
);

it.effect("derives a legacy repository host after refining its provider", () =>
  Effect.gen(function* () {
    const current = project({
      id: "p1",
      title: "legacy self-hosted",
      workspaceRoot: "/gitlab",
      repository: "group/project",
      provider: SourceControlProviderKind.make("unknown"),
      host: "code.example.test",
    });
    const identity = current.repositoryIdentity!;
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
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("gitlab"))],
      resolveHandle: ({ context }) =>
        Effect.succeed({
          context: {
            ...context!,
            provider: { ...context!.provider, kind: SourceControlProviderKind.make("gitlab") },
          },
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
      provider: SourceControlProviderKind.make("unknown"),
      host: "code.example.test",
    });
    const service = yield* makeService({
      projects: [selfHosted, { ...selfHosted, id: "p2" as ProjectId, workspaceRoot: "/healthy" }],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("gitlab"))],
      resolveHandle: ({ cwd, context }) => {
        asked.push(cwd);
        return cwd === "/gone"
          ? Effect.succeed({ context: context!, provider: undefined as never })
          : Effect.succeed({
              context: {
                ...context!,
                provider: { ...context!.provider, kind: SourceControlProviderKind.make("gitlab") },
              },
              provider: undefined as never,
            });
      },
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual(asked, ["/gone", "/healthy"]);
    assert.strictEqual(result.providers[0]?.kind, "gitlab");
  }),
);

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
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
    assert.deepStrictEqual(
      result.providers.map((summary) => ({
        kind: summary.kind,
        configured: summary.configured,
        projectCount: summary.projectCount,
      })),
      [
        { kind: SourceControlProviderKind.make("github"), configured: true, projectCount: 1 },
        { kind: SourceControlProviderKind.make("gitlab"), configured: false, projectCount: 1 },
      ],
    );
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|1",
    });
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
          provider: SourceControlProviderKind.make("azure-devops"),
          host: "dev.azure.com",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
          ...keyedByCanonicalKey,
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

    assert.deepStrictEqual(result.nextCursors, {
      "dev.azure.com dev.azure.com/acme/web": "2026-07-02T00:00:00Z|4|7",
    });
  }),
);

it.effect(
  "continues a timestamp-paged host's listings through tied timestamps and terminates",
  () =>
    Effect.gen(function* () {
      const boundary = "2026-10-12T00:00:00.000Z";
      const older = "2026-10-11T00:00:00.000Z";
      const rows = [1, 2, 3, 4, 5].map((number) =>
        changeRequest(number, number <= 3 ? boundary : older),
      );
      const service = yield* makeService({
        projects: [
          project({
            id: "p1",
            title: "web",
            workspaceRoot: "/w",
            repository: "acme/web",
            provider: "bitbucket",
            host: "bitbucket.org",
          }),
        ],
        providers: [
          // Pages the way Bitbucket does: inclusively by update time, excluding rows already sent.
          fakePullRequestProvider(SourceControlProviderKind.make("bitbucket"), {
            listChangeRequests: ({ cursor, limit }) =>
              Effect.sync(() => {
                const seen = new Set(cursor?.seenAt ?? []);
                const matching = rows.filter(
                  (row) =>
                    (cursor === undefined || row.updatedAt <= cursor.updatedBefore) &&
                    !seen.has(row.number),
                );
                return {
                  items: matching.slice(0, limit),
                  truncated: matching.length > limit,
                  continues: true,
                };
              }),
          }),
        ],
      });
      let page = yield* service.list({ state: "open", limit: 2 });
      assert.deepStrictEqual(
        page.entries.map((entry) => entry.number),
        [1, 2],
      );
      for (const expected of [[3, 4], [5]]) {
        assert.isTrue(page.truncated);
        assert.isNotEmpty(page.nextCursors);
        page = yield* service.list({ state: "open", limit: 2, cursors: page.nextCursors });
        assert.deepStrictEqual(
          page.entries.map((entry) => entry.number),
          expected,
        );
      }
      assert.isFalse(page.truncated);
      assert.deepStrictEqual(page.nextCursors, {});
    }),
);

it.effect("keeps a row already sent at the boundary instant from arriving twice", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [7, 8],
    );
    assert.deepStrictEqual(result.nextCursors, {
      "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|3|6,7,8",
    });
  }),
);

it.effect("calls a transient viewer failure a failed operation, not a signed-out CLI", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "t3code", workspaceRoot: "/a", repository: "pingdotgg/t3code" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getViewer: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation: "getViewer",
                reason: "failed",
                detail: "HTTP 500",
              }),
            ),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

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
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getViewer: () =>
            Effect.fail(
              new PullRequestProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation: "getViewer",
                reason: "failed",
                detail: "HTTP 500",
              }),
            ),
        }),
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          unavailableRequirement: {
            missing: "Install glab.",
            unauthenticated: "Run glab auth login.",
          },
          getViewer: () =>
            Effect.fail(unusable(SourceControlProviderKind.make("gitlab"), "missing-tool")),
        }),
      ],
    });

    const error = yield* Effect.flip(service.list({ state: "open" }));

    assert.strictEqual(error._tag, "PullRequestUnavailableError");
    if (error._tag === "PullRequestUnavailableError") {
      assert.strictEqual(error.requirement, "Install glab.");
    }
    assert.strictEqual(error.message, "Install glab.");
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: ({ host }) =>
            Effect.succeed({
              items: host === "ghe.example.com" ? [changeRequest(2, "2026-07-05T00:00:00Z")] : [],
              truncated: false,
              continues: true,
            }),
        }),
      ],
    });

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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

for (const [] of [
  ["github", "github.com"],
  ["gitlab", "gitlab.com"],
  ["forgejo", "code.example.test"],
  ["bitbucket", "bitbucket.org"],
  ["azure-devops", "dev.azure.com"],
] as const) {
}

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

it.effect("routes explicit Forgejo HTTP authorities through SSH checkouts after refinement", () =>
  Effect.gen(function* () {
    for (const provider of ["forgejo", "unknown"] as const) {
      const seen: string[] = [];
      const viewers: Array<string | undefined> = [];
      const service = yield* makeService({
        projects: [
          project({
            id: "ssh",
            title: "ssh",
            workspaceRoot: "/ssh",
            repository: "team/repo",
            provider,
            host: "ssh.code.example",
            remoteUrl: "git@ssh.code.example:team/repo.git",
          }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("forgejo"), {
            getViewer: (input) => {
              viewers.push(input.host);
              assert.strictEqual(input.host, "code.example:3000");
              return Effect.succeed("bilal");
            },
            listChangeRequests: (input) => {
              assert.strictEqual(input.host, "code.example:3000");
              return Effect.succeed({ items: [], truncated: false, continues: true });
            },
            getChangeRequest: (input) => {
              assert.strictEqual(input.host, "code.example:3000");
              return Effect.succeed({ ...hostedChangeRequest("Forgejo detail"), number: 42 });
            },
            getChangeRequestSummary: (input) =>
              Effect.sync(() => {
                seen.push(input.host);
                return changeRequest(42, "2026-07-02T00:00:00Z");
              }),
          }),
        ],
        resolveHandle: ({ context }) => {
          if (context?.requestedHost === undefined) {
            return Effect.succeed({ context: context!, provider: undefined as never });
          }
          assert.strictEqual(context.requestedHost, "code.example:3000");
          return Effect.succeed({
            context: {
              ...context,
              provider: {
                kind: SourceControlProviderKind.make("forgejo"),
                name: "Forgejo",
                baseUrl: "http://code.example:3000",
              },
            },
            provider: undefined as never,
          });
        },
      });
      yield* service.summary(
        {
          projectId: "ssh" as ProjectId,
          host: "code.example:3000",
          repository: "team/repo",
          number: 42,
        },
        { recoverTransientFailure: false },
      );
      assert.deepStrictEqual(seen, ["code.example:3000"]);
      const listed = yield* service.list({
        projectId: "ssh" as ProjectId,
        host: "code.example:3000",
        state: "open",
      });
      assert.strictEqual(listed.viewers["code.example:3000"], "bilal");
      const preview = yield* service.preview({
        projectId: "ssh" as ProjectId,
        host: "code.example:3000",
        repository: "team/repo",
        number: 42,
      });
      assert.strictEqual(preview.number, 42);
      const detail = yield* service.detail({
        projectId: "ssh" as ProjectId,
        host: "code.example:3000",
        repository: "team/repo",
        number: 42,
      });
      assert.strictEqual(detail.body, "Forgejo detail");
      assert.deepStrictEqual(viewers, ["code.example:3000"]);
    }
  }),
);

it.effect("names an SSH remote's web host from a later checkout when the first cannot", () =>
  Effect.gen(function* () {
    const hosts: Array<string> = [];
    const service = yield* makeService({
      projects: ["/first", "/second"].map((workspaceRoot, index) =>
        project({
          id: `p${index}`,
          title: `checkout ${index}`,
          workspaceRoot,
          repository: "team/repo",
          provider: SourceControlProviderKind.make("forgejo"),
          host: "ssh.code.example",
          remoteUrl: "git@ssh.code.example:team/repo.git",
        }),
      ),
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("forgejo"), {
          listChangeRequests: (input) => {
            hosts.push(input.host);
            return Effect.succeed({ items: [], truncated: false, continues: true });
          },
        }),
      ],
      resolveHandle: ({ cwd, context }) =>
        Effect.succeed({
          context:
            cwd === "/first"
              ? context!
              : {
                  ...context!,
                  provider: {
                    kind: SourceControlProviderKind.make("forgejo"),
                    name: "Forgejo",
                    baseUrl: "http://code.example:3000",
                  },
                },
          provider: undefined as never,
        }),
    });

    yield* service.list({ state: "open" });

    assert.deepStrictEqual(hosts, ["code.example:3000"]);
  }),
);

it.effect("rejects a different Forgejo HTTP port for an HTTP checkout", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "http",
          title: "http",
          workspaceRoot: "/http",
          repository: "team/repo",
          provider: SourceControlProviderKind.make("forgejo"),
          host: "code.example",
          remoteUrl: "http://code.example:4000/team/repo.git",
        }),
      ],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("forgejo"))],
    });
    const failure = yield* service
      .summary(
        {
          projectId: "http" as ProjectId,
          host: "code.example:3000",
          repository: "team/repo",
          number: 42,
        },
        { recoverTransientFailure: false },
      )
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "PullRequestUnavailableError");
  }),
);

it.effect("resolves a project's repository identity when its shell has none cached", () =>
  Effect.gen(function* () {
    const resolved = project({
      id: "web",
      title: "web",
      workspaceRoot: "/web",
      repository: "acme/web",
    });
    const service = yield* makeService({
      projects: [{ ...resolved, repositoryIdentity: null }],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequestSummary: () => Effect.succeed(changeRequest(7, "2026-07-02T00:00:00Z")),
        }),
      ],
      resolveRepositoryIdentity: () => Effect.succeed(resolved.repositoryIdentity ?? null),
    });

    const summary = yield* service.summary(
      { projectId: "web" as ProjectId, host: "github.com", repository: "acme/web", number: 7 },
      { recoverTransientFailure: false },
    );

    assert.strictEqual(summary.number, 7);
  }),
);

it.effect("routes a hosted reference to another repository through a project on that host", () =>
  Effect.gen(function* () {
    const seen: Array<{ cwd: string; repository: string; host: string }> = [];
    const service = yield* makeService({
      projects: [
        project({ id: "frontend", title: "web", workspaceRoot: "/web", repository: "acme/web" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequestSummary: (input) =>
            Effect.sync(() => {
              seen.push({ cwd: input.cwd, repository: input.repository, host: input.host });
              return changeRequest(7, "2026-07-02T00:00:00Z");
            }),
        }),
      ],
    });

    const summary = yield* service.summary(
      { projectId: "frontend" as ProjectId, host: "github.com", repository: "acme/api", number: 7 },
      { recoverTransientFailure: false },
    );

    assert.strictEqual(summary.number, 7);
    assert.deepStrictEqual(seen, [{ cwd: "/web", repository: "acme/api", host: "github.com" }]);
  }),
);

it.effect("routes Azure reads and writes through the requested organization's checkout", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const service = yield* makeService({
      projects: ["org-a", "org-b"].map((organization) =>
        project({
          id: organization,
          title: organization,
          workspaceRoot: `/${organization}`,
          repository: `${organization}/project/_git/web`,
          provider: SourceControlProviderKind.make("azure-devops"),
          host: "dev.azure.com",
        }),
      ),
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
          ...keyedByCanonicalKey,
          getChangeRequestSummary: (input) =>
            Effect.sync(() => {
              seen.push(`read ${input.cwd} ${input.repository}`);
              return changeRequest(7, "2026-07-02T00:00:00Z");
            }),
          runAction: (input) =>
            Effect.sync(() => {
              seen.push(`write ${input.cwd} ${input.repository}`);
            }),
        }),
      ],
    });
    const reference = {
      projectId: "org-a" as ProjectId,
      host: "dev.azure.com",
      repository: "org-b/project/_git/web",
      number: 7,
    };
    yield* service.summary(reference, { recoverTransientFailure: false });
    yield* service.runAction({ ...reference, action: "merge" });
    assert.deepStrictEqual(seen, ["read /org-b web", "write /org-b web", "read /org-b web"]);
  }),
);

it.effect.each([
  {
    host: "ssh.dev.azure.com",
    repository: "v3/org-b/project/web",
    remoteUrl: "git@ssh.dev.azure.com:v3/org-b/project/web",
  },
  {
    host: "vs-ssh.visualstudio.com",
    repository: "v3/org-b/project/web",
    remoteUrl: "git@vs-ssh.visualstudio.com:v3/org-b/project/web",
  },
  {
    host: "org-b.visualstudio.com",
    repository: "DefaultCollection/project/_git/web",
    remoteUrl: "https://org-b.visualstudio.com/DefaultCollection/project/_git/web",
  },
])("routes Azure URL reads and writes through a $host checkout", (checkout) =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const target = project({
      id: "target",
      title: "target",
      workspaceRoot: "/target",
      provider: SourceControlProviderKind.make("azure-devops"),
      ...checkout,
    });
    const service = yield* makeService({
      projects: [
        ...["org-a/project/_git/web", "org-b/other-project/_git/web"].map((repository) =>
          project({
            id: repository,
            title: repository,
            workspaceRoot: `/${repository}`,
            provider: SourceControlProviderKind.make("azure-devops"),
            host: "dev.azure.com",
            repository,
          }),
        ),
        target,
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
          ...keyedByCanonicalKey,
          getChangeRequestSummary: (input) =>
            Effect.sync(() => {
              seen.push(`read ${input.cwd} ${input.repository}`);
              return changeRequest(7, "2026-07-02T00:00:00Z");
            }),
          runAction: (input) =>
            Effect.sync(() => {
              seen.push(`write ${input.cwd} ${input.repository}`);
            }),
        }),
      ],
    });
    const reference = {
      projectId: "org-a/project/_git/web" as ProjectId,
      host: "dev.azure.com",
      repository: "org-b/project/_git/web",
      number: 7,
    };
    yield* service.summary(reference, { recoverTransientFailure: false });
    yield* service.runAction({ ...reference, action: "merge" });
    assert.deepStrictEqual(seen, ["read /target web", "write /target web", "read /target web"]);
  }),
);

it.effect("refuses Azure cross-organization reads and writes without its checkout", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [
        project({
          id: "org-a",
          title: "org-a",
          workspaceRoot: "/org-a",
          repository: "org-a/project/_git/web",
          provider: SourceControlProviderKind.make("azure-devops"),
          host: "dev.azure.com",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
          ...keyedByCanonicalKey,
          getChangeRequestSummary: () => Effect.die("must not read the wrong organization"),
          runAction: () => Effect.die("must not modify the wrong organization"),
        }),
      ],
    });
    const reference = {
      projectId: "org-a" as ProjectId,
      host: "dev.azure.com",
      repository: "org-b/project/_git/web",
      number: 7,
    };
    const readError = yield* Effect.flip(
      service.summary(reference, { recoverTransientFailure: false }),
    );
    const writeError = yield* Effect.flip(service.runAction({ ...reference, action: "close" }));
    assert.strictEqual(readError._tag, "PullRequestUnavailableError");
    assert.strictEqual(writeError._tag, "PullRequestUnavailableError");
  }),
);

it.effect("prefers a matching checkout over a non-repository project's directory", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "inbox", title: "Inbox", workspaceRoot: "/home/alex" }),
        project({ id: "repo", title: "API", workspaceRoot: "/api", repository: "acme/api" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequestSummary: (input) =>
            Effect.sync(() => {
              seen.push(input.cwd);
              return changeRequest(7, "2026-07-02T00:00:00Z");
            }),
        }),
      ],
    });
    yield* service.summary(
      {
        projectId: "inbox" as ProjectId,
        host: "github.com",
        repository: "acme/api",
        number: 7,
      },
      { recoverTransientFailure: false },
    );
    assert.deepStrictEqual(seen, ["/api"]);
  }),
);

// regression: #17167 refresh linked PRs without a checkout
it.effect("requires an explicit host for a non-repository project's linked PR", () =>
  Effect.gen(function* () {
    const service = yield* makeService({
      projects: [project({ id: "inbox", title: "Inbox", workspaceRoot: "/home/alex" })],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("github"))],
    });
    const error = yield* service
      .summary(
        {
          projectId: "inbox" as ProjectId,
          repository: "acme/api",
          number: 7,
        },
        { recoverTransientFailure: false },
      )
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "PullRequestUnavailableError");
  }),
);

it.effect("refuses a review request this viewer may not make, and says what access it takes", () =>
  Effect.gen(function* () {
    let sent = false;
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

it.effect.each(["list", "listStats"] as const)(
  "retries a replacement %s read that joins a canceled lookup",
  (operation) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      const finishShutdown = yield* Deferred.make<void>();
      let hostCalls = 0;
      const lookup = Effect.gen(function* () {
        if (++hostCalls !== 1) return;
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Deferred.succeed(stopping, undefined).pipe(
              Effect.andThen(Deferred.await(finishShutdown)),
            ),
          ),
        );
      });
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            listChangeRequests: () =>
              lookup.pipe(
                Effect.as({
                  items: [changeRequest(1, "2026-07-02T00:00:00Z")],
                  truncated: false,
                  continues: false,
                }),
              ),
            listChangeRequestStats: () =>
              lookup.pipe(
                Effect.as([{ repository: "acme/web", number: 1, additions: 3, deletions: 1 }]),
              ),
          }),
        ],
      });
      const read =
        operation === "list"
          ? service
              .list({ state: "open" })
              .pipe(Effect.map((result) => result.entries.map((entry) => entry.number)))
          : service
              .listStats({
                refs: [{ projectId: "p1" as ProjectId, repository: "acme/web", number: 1 }],
              })
              .pipe(Effect.map((result) => result.stats.map((stat) => stat.number)));
      const original = yield* Effect.forkScoped(read);
      yield* Deferred.await(started);
      const cancellation = yield* Effect.forkScoped(Fiber.interrupt(original));
      yield* Deferred.await(stopping);
      const replacement = yield* Effect.forkScoped(read, { startImmediately: true });
      yield* Deferred.succeed(finishShutdown, undefined);
      yield* Fiber.join(cancellation);
      const canceled = yield* Fiber.await(original);
      assert.isTrue(Exit.isFailure(canceled));
      if (Exit.isFailure(canceled)) assert.isTrue(Cause.hasInterruptsOnly(canceled.cause));
      assert.deepStrictEqual(yield* Fiber.join(replacement), [1]);
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

    yield* Effect.forEach(
      ["all", "authored", "reviewing"],
      (involvement) =>
        service.list({
          state: "open",
          involvement: involvement as "all" | "authored" | "reviewing",
        }),
      { concurrency: "unbounded" },
    );

    assert.strictEqual(viewerCalls, 1);
    assert.strictEqual(listCalls, 3);
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

    assert.deepStrictEqual(asked, [["acme/web", "acme/docs"], ["acme/docs"]]);
    assert.deepStrictEqual(
      narrowed.entries.map((entry) => entry.repository),
      ["acme/docs"],
    );

    yield* service.list({ state: "open", projectIds: ["p2" as ProjectId] });
    assert.strictEqual(asked.length, 2);
  }),
);

it.effect(
  "keeps listing freshness tied to read start when filtered reads finish out of order",
  () =>
    Effect.gen(function* () {
      const olderStarted = yield* Deferred.make<void>();
      const releaseOlder = yield* Deferred.make<void>();
      let reads = 0;
      const updatedAt = "2026-07-02T00:00:00Z";
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            listChangeRequests: ({ filters }) =>
              Effect.gen(function* () {
                reads += 1;
                const older = filters?.checks === "failing";
                if (older) {
                  yield* Deferred.succeed(olderStarted, undefined);
                  yield* Deferred.await(releaseOlder);
                }
                return {
                  items: [
                    {
                      ...changeRequest(1, updatedAt),
                      checksState: older ? ("failing" as const) : ("passing" as const),
                      mergeability: older ? ("mergeable" as const) : ("conflicting" as const),
                    },
                  ],
                  truncated: false,
                  continues: false,
                };
              }),
          }),
        ],
      });
      const olderInput = { state: "open" as const, filters: { checks: "failing" as const } };
      const newerInput = { state: "open" as const, filters: { checks: "passing" as const } };

      const olderRead = yield* service.list(olderInput).pipe(Effect.forkChild());
      yield* Deferred.await(olderStarted);
      yield* TestClock.adjust("1 second");
      const newer = yield* service.list(newerInput);
      yield* Deferred.succeed(releaseOlder, undefined);
      const older = yield* Fiber.join(olderRead);

      assert.strictEqual(older.entries[0]?.checksState, "failing");
      assert.strictEqual(older.entries[0]?.mergeability, "mergeable");
      assert.strictEqual(newer.entries[0]?.checksState, "passing");
      assert.strictEqual(newer.entries[0]?.mergeability, "conflicting");
      assert.strictEqual(typeof older.entries[0]?.observedAt, "number");
      assert.strictEqual(typeof newer.entries[0]?.observedAt, "number");
      assert.isBelow(older.entries[0]!.observedAt!, newer.entries[0]!.observedAt!);

      const cachedOlder = yield* service.list(olderInput);
      assert.strictEqual(cachedOlder.entries[0]?.observedAt, older.entries[0]?.observedAt);
      assert.strictEqual(reads, 2);
    }),
);

it.effect("does not revive old summaries when project epochs are evicted", () =>
  Effect.gen(function* () {
    let title = "old";
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () => Effect.succeed({ ...hostedChangeRequest("body"), title }),
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    assert.strictEqual((yield* service.summary(ref))?.title, "old");
    title = "new";
    yield* service.refreshAfterTurn(ref.projectId);
    assert.strictEqual((yield* service.summary(ref))?.title, "new");
    for (let index = 0; index < 2048; index++)
      yield* service.refreshAfterTurn(`project-${index}` as ProjectId);
    assert.strictEqual((yield* service.summary(ref))?.title, "new");
  }),
);

it.effect("close and reopen notify subscribed readers after invalidating their cached state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let hostCalls = 0;
      let state: "open" | "closed" = "open";
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequestSummary: () =>
              Effect.succeed({ ...changeRequest(1, "2026-09-16T00:00:00.000Z"), state }),
            runAction: (input) =>
              Effect.sync(() => {
                state = input.action === "close" ? "closed" : "open";
              }),
            listChangeRequests: () => {
              hostCalls += 1;
              return Effect.succeed({ items: [], truncated: false, continues: false });
            },
          }),
        ],
      });

      yield* service.refreshAfterTurn(reference.projectId);
      yield* service.list({ state: "open" });
      assert.strictEqual((yield* service.summary(reference)).state, "open");
      for (const action of ["close", "reopen"] as const) {
        const refreshed = yield* service.subscribeRefreshes.pipe(
          Stream.drop(1),
          Stream.take(1),
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              yield* service.list({ state: "open" });
              return yield* service.summary(reference);
            }),
          ),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* service.runAction({ ...reference, action });
        assert.strictEqual(
          Option.getOrThrow(yield* Fiber.join(refreshed)).state,
          action === "close" ? "closed" : "open",
        );
      }
      assert.strictEqual(hostCalls, 3);
    }),
  ),
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
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequestsAcross: () =>
            Effect.succeed({
              items: [
                batchedChangeRequest(1, "acme/web", "2026-07-03T00:00:00Z"),
                batchedChangeRequest(2, "pingdotgg/t3code", "2026-07-02T00:00:00Z"),
                batchedChangeRequest(3, "acme/web", "2026-07-02T00:00:00Z"),
              ],
              truncated: true,
              unresolved: ["acme/docs"],
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

    assert.deepStrictEqual(cursors, [{ updatedBefore: "2026-07-02T00:00:00Z", delivered: 1 }]);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [4],
    );
    assert.deepStrictEqual(result.nextCursors, {
      "github.com acme/web": "2026-07-02T00:00:00Z|2|3,4",
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
it.effect("asks on its own for a repository a search could not vouch for", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
              unresolved: ["acme/docs"],
            }),
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

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
it.effect("believes a search's silence about a repository it vouches for", () =>
  Effect.gen(function* () {
    const separately: string[] = [];
    const service = yield* makeService({
      projects: [
        project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        project({ id: "p2", title: "docs", workspaceRoot: "/b", repository: "acme/docs" }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: ({ repository }) => {
            separately.push(repository);
            return Effect.succeed({ items: [], truncated: false, continues: true });
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

    assert.deepStrictEqual(separately, []);
    assert.deepStrictEqual(
      result.entries.map((entry) => entry.number),
      [1],
    );
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
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequestStats: (input) => {
            asked.push(input.changeRequests);
            return Effect.succeed([
              { repository: "acme/web", number: 1, additions: 12, deletions: 3 },
            ]);
          },
        }),
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab")),
      ],
    });

    const result = yield* service.listStats({
      refs: [
        { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 },
        { projectId: "p1" as ProjectId, repository: "acme/web", number: 2 },
        { projectId: "p2" as ProjectId, repository: "group/project", number: 3 },
        { projectId: "p1" as ProjectId, repository: "evil/repo", number: 4 },
      ],
    });

    assert.deepStrictEqual(asked, [
      [
        { repository: "acme/web", number: 1 },
        { repository: "acme/web", number: 2 },
      ],
    ]);
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

it.effect("reads the fresh diff when detail or summary discovers a changed revision", () =>
  Effect.gen(function* () {
    const summaryStarted = yield* Deferred.make<void>();
    const releaseSummary = yield* Deferred.make<void>();
    let revision = "2026-07-02T00:00:00Z";
    let patch = "old patch";
    let diffCalls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.sync(() => ({ ...hostedChangeRequest("body"), updatedAt: revision })),
          getChangeRequestSummary: () =>
            Effect.gen(function* () {
              const result = changeRequest(1, revision);
              yield* Deferred.succeed(summaryStarted, undefined);
              yield* Deferred.await(releaseSummary);
              return result;
            }),
          getDiff: () =>
            Effect.sync(() => {
              diffCalls += 1;
              return { patch, truncated: false, nextCursor: null };
            }),
        }),
      ],
    });

    const coldSummary = yield* service.summary(reference).pipe(Effect.forkChild());
    yield* Deferred.await(summaryStarted);
    yield* service.detail(reference);
    assert.strictEqual((yield* service.diff(reference)).patch, "old patch");
    revision = "2026-07-02T00:01:00Z";
    patch = "new patch";
    yield* TestClock.adjust("61 seconds");
    yield* service.detail(reference);
    yield* Effect.yieldNow;
    assert.strictEqual((yield* service.detail(reference)).updatedAt, revision);
    yield* Deferred.succeed(releaseSummary, undefined);
    yield* Fiber.join(coldSummary);
    yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual((yield* service.diff(reference)).patch, "new patch");
    assert.strictEqual(diffCalls, 2);

    revision = "2026-07-02T00:02:00Z";
    patch = "summary-discovered patch";
    yield* TestClock.adjust("61 seconds");
    yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual((yield* service.diff(reference)).patch, patch);
    assert.strictEqual(diffCalls, 3);
  }),
);

it.effect("keeps routed reads separate when the GitHub account changes", () =>
  Effect.gen(function* () {
    for (const operation of ["summary", "detail", "checks", "diff", "filesViewed"] as const) {
      let failing = false;
      let calls = 0;
      const read = () =>
        Effect.suspend(() => {
          calls += 1;
          return failing
            ? Effect.fail(requestFailed)
            : Effect.succeed(hostedChangeRequest("account A content"));
        });
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            capabilities: {
              ...fakePullRequestProvider(SourceControlProviderKind.make("github")).capabilities,
              viewedFiles: "host",
            },
            getFilesViewed: () =>
              read().pipe(
                Effect.as({
                  files: [{ path: "private.ts", state: "viewed" as const }],
                  truncated: false,
                }),
              ),
            getChangeRequestSummary: read,
            getChangeRequestChecks: read,
            getChangeRequest: read,
            getDiff: () =>
              read().pipe(
                Effect.as({ patch: "private patch", truncated: false, nextCursor: null }),
              ),
          }),
        ],
      });
      const readOperation = (input: Parameters<typeof service.diff>[0]) =>
        // @effect-diagnostics-next-line unnecessaryEffectGen:off - the generator unifies the per-operation union of Effect types, which Effect.asVoid cannot infer through.
        Effect.gen(function* () {
          yield* service[operation](input);
        });
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      yield* readOperation({ ...reference, expectedAccountId: "101" });
      failing = true;

      for (const allowStale of [false, true]) {
        const error = yield* Effect.flip(
          readOperation({ ...reference, expectedAccountId: "202", allowStale }),
        );
        assert.strictEqual(error._tag, "PullRequestOperationError");
      }
      assert.strictEqual(calls, 3);
    }
  }),
);

it.effect("isolates routed caches for two credentials belonging to the same account", () =>
  Effect.gen(function* () {
    for (const operation of [
      "summary",
      "detail",
      "checks",
      "diff",
      "preview",
      "filesViewed",
    ] as const) {
      let credential = "broad";
      let calls = 0;
      const read = () =>
        Effect.suspend(() => {
          calls += 1;
          return credential === "broad"
            ? Effect.succeed(hostedChangeRequest("private content"))
            : Effect.fail(requestFailed);
        });
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            capabilities: {
              ...fakePullRequestProvider(SourceControlProviderKind.make("github")).capabilities,
              viewedFiles: "host",
            },
            getFilesViewed: () =>
              read().pipe(
                Effect.as({
                  files: [{ path: "private.ts", state: "viewed" as const }],
                  truncated: false,
                }),
              ),
            withVerifiedCredential: (_, use) =>
              Effect.suspend(() =>
                use({
                  accountId: "101",
                  viewer: "octocat",
                  credentialFingerprint: credential,
                }),
              ),
            getChangeRequest: read,
            getChangeRequestChecks: read,
            getChangeRequestSummary: read,
            getDiff: () =>
              read().pipe(
                Effect.as({ patch: "private patch", truncated: false, nextCursor: null }),
              ),
            getChangeRequestPreview: read,
          }),
        ],
      });
      const readOperation = (input: Parameters<typeof service.diff>[0]) =>
        // @effect-diagnostics-next-line unnecessaryEffectGen:off - the generator unifies the per-operation union of Effect types, which Effect.asVoid cannot infer through.
        Effect.gen(function* () {
          yield* service[operation](input);
        });
      const reference = {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        host: "github.com",
        expectedAccountId: "101",
      };
      yield* service.withRoutingCredential(reference, readOperation(reference));
      credential = "restricted";
      for (const allowStale of [false, true]) {
        const error = yield* Effect.flip(
          service.withRoutingCredential(reference, readOperation({ ...reference, allowStale })),
        );
        assert.strictEqual(error._tag, "PullRequestOperationError");
      }
      assert.strictEqual(calls, 3);
    }
  }),
);

it.effect("rejects mismatched routing credentials before use and preserves action errors", () =>
  Effect.gen(function* () {
    let operations = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getRoutingIdentity: () => Effect.succeed({ accountId: "101", viewer: "octocat" }),
          withVerifiedCredential: (_, use) =>
            use({
              accountId: "101",
              viewer: "octocat",
              credentialFingerprint: "credential-a",
            }),
        }),
      ],
    });
    const reference = {
      projectId: "p1" as ProjectId,
      repository: "acme/web",
      number: 1,
      host: "github.com",
      expectedAccountId: "202",
    };
    const actionError = new PullRequestOperationError({
      operation: "runAction",
      detail: "ambiguous",
    });
    const operation = Effect.sync(() => {
      operations += 1;
    }).pipe(Effect.andThen(Effect.fail(actionError)));
    const rejected = yield* Effect.flip(service.withRoutingCredential(reference, operation));
    assert.strictEqual(rejected._tag, "PullRequestOperationError");
    if (rejected._tag === "PullRequestOperationError")
      assert.strictEqual(rejected.operation, "routeIdentity");
    assert.strictEqual(operations, 0);
    assert.strictEqual(
      yield* Effect.flip(
        service.withRoutingCredential({ ...reference, expectedAccountId: "101" }, operation),
      ),
      actionError,
    );
    assert.strictEqual(operations, 1);
    assert.deepStrictEqual(yield* service.routingIdentity({ host: "github.com" }), {
      accountId: "101",
      viewer: "octocat",
      host: "github.com",
      provider: "github",
    });
  }),
);

it.effect(
  "opening detail preserves enriched linked summaries and updates draft and diff fields",
  () =>
    Effect.gen(function* () {
      const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getChangeRequestSummary: () =>
              Effect.succeed({
                ...changeRequest(1, "2026-07-02T00:00:00Z"),
                isDraft: true,
                reviewDecision: "approved",
                checksState: "passing",
              }),
            getChangeRequest: () =>
              Effect.succeed({
                ...hostedChangeRequest("body", 14),
                deletions: 3,
                changedFiles: 5,
                mergeability: "conflicting",
              }),
          }),
        ],
      });
      yield* service.summary(reference);
      const detail = yield* service.detail(reference);
      const summary = yield* service.summary(reference);
      assert.strictEqual(summary.isDraft, false);
      assert.deepStrictEqual(summary.author, detail.author);
      assert.strictEqual(summary.additions, 14);
      assert.strictEqual(summary.deletions, 3);
      assert.strictEqual(summary.changedFiles, 5);
      assert.strictEqual(summary.mergeability, "conflicting");
      assert.strictEqual(summary.reviewDecision, "approved");
      assert.strictEqual(summary.checksState, "passing");
    }),
);

it.effect("notifies linked threads when detail changes draft status in either direction", () =>
  Effect.gen(function* () {
    let isDraft = true;
    let updatedAt = "2026-07-02T00:00:00Z";
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.sync(() => ({ ...hostedChangeRequest("body"), isDraft, updatedAt })),
        }),
      ],
    });
    const changes = yield* service.subscribeStateChanges;
    const read = () => service.detail({ ...reference, allowStale: false });
    yield* read();
    yield* read();
    isDraft = false;
    yield* service.invalidate({ reference });
    yield* read();
    yield* read();
    isDraft = true;
    yield* service.invalidate({ reference });
    yield* read();

    isDraft = false;
    updatedAt = "2026-07-01T00:00:00Z";
    yield* service.invalidate({ reference });
    yield* read();

    // A different PR ends collection after all the synchronous notifications above.
    yield* service.reportState({ reference: { ...reference, number: 2 }, state: "open" });
    const events = yield* Stream.runCollect(
      changes.pipe(Stream.takeUntil((event) => event.number === 2, { excludeLast: true })),
    );
    assert.deepStrictEqual(events, [
      { host: "github.com", repository: "acme/web", number: 1 },
      { host: "github.com", repository: "acme/web", number: 1 },
      { host: "github.com", repository: "acme/web", number: 1 },
    ]);
  }),
);

it.effect("deduplicates routed PR reports without dropping draft changes", () =>
  Effect.gen(function* () {
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [fakePullRequestProvider(SourceControlProviderKind.make("github"))],
    });
    const changes = yield* service.subscribeStateChanges;
    for (const isDraft of [true, true, false, false, true]) {
      yield* service.reportState({ reference, state: "open", isDraft });
    }
    yield* service.reportState({ reference, state: "open" });
    yield* service.reportState({ reference, state: "open" });
    yield* service.reportState({ reference: { ...reference, number: 2 }, state: "open" });
    const events = yield* Stream.runCollect(
      changes.pipe(Stream.takeUntil((event) => event.number === 2, { excludeLast: true })),
    );
    assert.deepStrictEqual(
      events.map((event) => event.number),
      [1, 1, 1, 1],
    );
  }),
);

it.effect("preserves check observation time on cache hits and advances it on refresh", () =>
  Effect.gen(function* () {
    let reads = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequestChecks: () =>
            Effect.sync(() => {
              reads += 1;
              return { state: "open" as const, checks: [] };
            }),
        }),
      ],
    });
    yield* TestClock.setTime(1_000);
    const first = yield* service.checks(reference);
    expect(first).toMatchObject({ observedAt: 1_000 });
    yield* TestClock.adjust("1 second");
    expect(yield* service.checks(reference)).toEqual(first);
    expect(reads).toBe(1);
    yield* TestClock.adjust("15 seconds");
    expect(yield* service.checks(reference)).toMatchObject({ observedAt: 17_000 });
    expect(reads).toBe(2);
  }),
);

it.effect("reuses an observed merged state for strict settlement reads", () =>
  Effect.gen(function* () {
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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

    summaryTitle = "updated after merge";
    yield* TestClock.adjust("61 seconds");
    assert.strictEqual((yield* service.summary(reference)).title, "merged title");
    const refreshed = yield* service.summary({ ...reference, allowStale: false });
    assert.strictEqual(refreshed.title, "updated after merge");
    assert.strictEqual(refreshed.state, "merged");
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
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
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

it.effect.each([false, true])(
  "authorizes stack rebases and refreshes sibling layers (cross-host: %s)",
  (crossHost) =>
    Effect.gen(function* () {
      let taken = 0;
      let summaryReads = 0;
      let mutationFails = false;
      let stackRebase = true;
      let stackActions = true;
      const capabilities = {
        diff: true,
        comment: true,
        actions: ["update-branch"] as const,
        mergeMethods: ["merge"] as const,
        updateMethods: ["rebase"] as const,
        get stackActions() {
          return stackActions;
        },
        search: true,
        reactions: true,
        review: FULL_REVIEW,
        reviewers: FULL_REVIEWERS,
      };
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
          project({
            id: "p2",
            title: "enterprise",
            workspaceRoot: "/b",
            repository: "acme/web",
            host: "enterprise.test",
          }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            capabilities,
            getViewerPermissions: () =>
              Effect.succeed({
                actions: [],
                stackRebase,
                comment: true,
                resolve: false,
                verdicts: [],
                requestReviewers: false,
              }),
            getChangeRequestSummary: () =>
              Effect.sync(() => {
                summaryReads++;
                return changeRequest(8, "2026-07-01T00:00:00Z");
              }),
            runAction: () =>
              Effect.gen(function* () {
                taken++;
                if (mutationFails) return yield* requestFailed;
              }),
          }),
        ],
      });
      const input = {
        ...(crossHost ? { host: "enterprise.test" } : {}),
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 3,
        action: "update-branch" as const,
        updateMethod: "rebase" as const,
        stackNumber: 50,
        expectedStackHeads: [{ number: 3, headSha: "ccc" }],
      };
      yield* service.runAction(input);
      assert.strictEqual(taken, 1);
      const unrelated = { ...input, number: 8 };
      yield* service.summary(unrelated);
      assert.strictEqual(summaryReads, 1);
      stackRebase = false;
      assert.strictEqual(
        (yield* Effect.flip(service.runAction(input)))._tag,
        "PullRequestOperationError",
      );
      stackRebase = true;
      stackActions = false;
      assert.strictEqual(
        (yield* Effect.flip(service.runAction(input)))._tag,
        "PullRequestOperationError",
      );
      assert.strictEqual(taken, 1);
      yield* service.summary(unrelated);
      assert.strictEqual(summaryReads, 1);
      stackActions = true;
      mutationFails = true;
      yield* Effect.flip(service.runAction(input));
      assert.strictEqual(taken, 2);
      yield* service.summary(unrelated);
      assert.strictEqual(summaryReads, 2);
    }),
);

it.effect("refuses a way of updating a branch that the host or the viewer does not allow", () =>
  Effect.gen(function* () {
    let taken: string | null = null;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge", "close", "update-branch"],
            mergeMethods: ["merge"],
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

    const error = yield* Effect.flip(
      service.runAction({ ...reference, action: "update-branch", updateMethod: "rebase" }),
    );
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.strictEqual(taken, null);

    yield* service.runAction({ ...reference, action: "update-branch", updateMethod: "merge" });
    assert.strictEqual(taken, "merge");
  }),
);

it.effect("keeps reading a host's thinned-out slices until a filtered page is full", () =>
  Effect.gen(function* () {
    const reads: Array<number> = [];
    const rows = Array.from({ length: 40 }, (_, index) => ({
      ...changeRequest(index + 1, `2026-07-${String(40 - index).padStart(2, "0")}T00:00:00Z`),
      labels: index % 2 === 0 ? [{ name: "bug", color: null }] : [],
    }));
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: (input) => {
            const delivered = input.cursor?.delivered ?? 0;
            reads.push(delivered);
            return Effect.succeed({
              items: rows.slice(delivered, delivered + input.limit),
              truncated: delivered + input.limit < rows.length,
              continues: true,
            });
          },
        }),
      ],
    });

    const bugs = yield* service.list({ state: "open", limit: 4, filters: { labels: [["bug"]] } });
    assert.deepStrictEqual(
      bugs.entries.map((entry) => entry.number),
      [1, 3, 5, 7],
    );
    assert.deepStrictEqual(reads, [0, 4]);

    reads.length = 0;
    const none = yield* service.list({
      state: "open",
      limit: 4,
      filters: { labels: [["missing"]] },
    });
    assert.deepStrictEqual(none.entries, []);
    assert.strictEqual(reads.length, 5);
    assert.match(Object.values(none.nextCursors)[0] ?? "", /\|20\|/);
  }),
);

it.effect("hands a host's own resume position back on the next read", () =>
  Effect.gen(function* () {
    const resumed: Array<string | undefined> = [];
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          listChangeRequests: (input) => {
            resumed.push(input.cursor?.resumeAfter);
            return Effect.succeed({
              items: [changeRequest(resumed.length, "2026-07-02T00:00:00Z")],
              truncated: true,
              continues: true,
              resumeAfter: `2026-07-01T00:00:00.000Z~${resumed.length}`,
            });
          },
        }),
      ],
    });

    const first = yield* service.list({ state: "open", limit: 1 });
    yield* service.list({ state: "open", limit: 1, cursors: first.nextCursors });
    assert.deepStrictEqual(resumed, [undefined, "2026-07-01T00:00:00.000Z~1"]);
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
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
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
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
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

it.effect("partial host viewed writes invalidate marks but keep the diff cached", () =>
  Effect.gen(function* () {
    let diffReads = 0;
    const states = new Map<string, "viewed" | "unviewed">([
      ["a.ts", "unviewed"],
      ["b.ts", "unviewed"],
    ]);
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          capabilities: {
            ...fakePullRequestProvider(SourceControlProviderKind.make("github")).capabilities,
            viewedFiles: "host",
          },
          getDiff: () =>
            Effect.sync(() => {
              diffReads += 1;
              return { patch: "@@", truncated: false, nextCursor: null };
            }),
          getFilesViewed: () =>
            Effect.sync(() => ({
              files: [...states].map(([path, state]) => ({ path, state })),
              truncated: false,
            })),
          setFilesViewed: () =>
            Effect.gen(function* () {
              states.set("a.ts", "viewed");
              return yield* new PullRequestProviderError({
                provider: SourceControlProviderKind.make("github"),
                operation: "setFilesViewed",
                reason: "failed",
                detail: "Second mutation refused",
              });
            }),
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 10 };
    yield* service.diff(ref);
    assert.deepStrictEqual((yield* service.filesViewed(ref)).files, [
      { path: "a.ts", state: "unviewed" },
      { path: "b.ts", state: "unviewed" },
    ]);
    yield* Effect.flip(
      service.setFilesViewed({
        ...ref,
        files: [...states.keys()].map((path) => ({ path, viewed: true })),
      }),
    );
    yield* service.diff(ref);
    assert.strictEqual(diffReads, 1);
    assert.deepStrictEqual((yield* service.filesViewed(ref)).files, [
      { path: "a.ts", state: "viewed" },
      { path: "b.ts", state: "unviewed" },
    ]);
  }),
);

const environmentViewedProvider = (
  revisions: Map<string, string>,
  asked: Array<ReadonlyArray<string>>,
  unreadable: ReadonlySet<string> = new Set(),
) =>
  fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
    capabilities: {
      diff: true,
      comment: true,
      actions: ["merge"],
      mergeMethods: ["merge"],
      search: true,
      reactions: true,
      viewedFiles: "environment",
      review: FULL_REVIEW,
      reviewers: FULL_REVIEWERS,
    },
    getFilesViewed: () => Effect.die("the host keeps no marks of its own"),
    setFilesViewed: () => Effect.die("the host keeps no marks of its own"),
    getChangeRequestSummary: () => Effect.succeed(changeRequest(1, "2026-07-02T00:00:00Z")),
    getFileRevisions: (input) => {
      asked.push(input.paths);
      return Effect.succeed({
        revisions: new Map(
          input.paths.flatMap((path) =>
            unreadable.has(path) ? [] : [[path, revisions.get(path) ?? ""] as const],
          ),
        ),
      });
    },
  });

const environmentViewedService = (
  revisions: Map<string, string>,
  asked: Array<ReadonlyArray<string>>,
  unreadable: ReadonlySet<string> = new Set(),
) =>
  makeService({
    projects: [
      project({
        id: "p1",
        title: "on gitlab",
        workspaceRoot: "/a",
        repository: "group/project",
        provider: SourceControlProviderKind.make("gitlab"),
      }),
    ],
    providers: [environmentViewedProvider(revisions, asked, unreadable)],
  });

const GITLAB_REFERENCE = {
  projectId: "p1" as ProjectId,
  repository: "group/project",
  number: 1,
};

it.effect("tracks environment viewed files by revision and refuses a baseline it cannot read", () =>
  Effect.gen(function* () {
    const revisions = new Map([
      ["alpha.ts", "b485fe5"],
      ["beta.ts", "5851425"],
      ["café notes.txt", "6dd9855"],
      ["deleted.txt", "0000000"],
      ["renamed.txt", ""],
    ]);
    let unreadable = false;
    let revisionReads = 0;
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        {
          ...environmentViewedProvider(revisions, []),
          getFileRevisions: (input) =>
            Effect.suspend(() => {
              revisionReads++;
              return unreadable
                ? Effect.fail(
                    new PullRequestProviderError({
                      provider: SourceControlProviderKind.make("gitlab"),
                      operation: "getFileRevisions",
                      reason: "failed",
                      detail: "The diff exceeded the output limit.",
                    }),
                  )
                : Effect.succeed({
                    revisions: new Map(
                      input.paths.map((path) => [path, revisions.get(path) ?? ""] as const),
                    ),
                    complete: true,
                  });
            }),
        },
      ],
    });
    const reference = GITLAB_REFERENCE;
    const paths = [...revisions.keys()];
    yield* service.setFilesViewed({
      ...reference,
      files: paths.map((path) => ({ path, viewed: true })),
    });
    assert.deepStrictEqual(
      new Map((yield* service.filesViewed(reference)).files.map((file) => [file.path, file.state])),
      new Map(paths.map((path) => [path, "viewed"])),
    );
    assert.strictEqual(revisionReads, 1);

    revisions.set("alpha.ts", "aabbccd");
    yield* service.invalidate({ reference });
    assert.deepStrictEqual(
      new Map((yield* service.filesViewed(reference)).files.map((file) => [file.path, file.state])),
      new Map(paths.map((path) => [path, path === "alpha.ts" ? "dismissed" : "viewed"])),
    );
    yield* service.setFilesViewed({
      ...reference,
      files: [{ path: "beta.ts", viewed: false }],
    });
    assert.isFalse(
      (yield* service.filesViewed(reference)).files.some((file) => file.path === "beta.ts"),
    );

    unreadable = true;
    yield* service.invalidate({ reference });
    yield* service.setFilesViewed({
      ...reference,
      files: [{ path: "beta.ts", viewed: true }],
    });
    unreadable = false;
    yield* service.invalidate({ reference });
    assert.deepStrictEqual(
      (yield* service.filesViewed(reference)).files.find((file) => file.path === "beta.ts"),
      { path: "beta.ts", state: "viewed" },
    );
  }),
);

it.effect("keeps hosted Forgejo marks with their repository instead of the serving checkout", () =>
  Effect.gen(function* () {
    const projects = [
      project({
        id: "p1",
        title: "first repository",
        workspaceRoot: "/first",
        repository: "reviewer/first",
        provider: SourceControlProviderKind.make("forgejo"),
        host: "forge.example",
        remoteUrl: "https://forge.example:3000/reviewer/first.git",
      }),
    ];
    const service = yield* makeService({
      projects,
      providers: [
        {
          ...environmentViewedProvider(new Map([["same.ts", "blob"]]), []),
          kind: SourceControlProviderKind.make("forgejo"),
        },
      ],
      resolveHandle: ({ context }) =>
        Effect.succeed({
          context: {
            ...context!,
            provider: {
              kind: SourceControlProviderKind.make("forgejo"),
              name: "Forgejo",
              baseUrl: "https://forge.example:3000",
            },
          },
          provider: undefined as never,
        }),
    });
    const first = {
      projectId: "p1" as ProjectId,
      host: "forge.example:3000",
      repository: "reviewer/first",
      number: 1,
    };
    const second = { ...first, repository: "reviewer/second" };
    const files = [{ path: "same.ts", viewed: true }];
    yield* service.setFilesViewed({ ...first, files });
    assert.deepStrictEqual((yield* service.filesViewed(second)).files, []);
    yield* service.setFilesViewed({ ...second, files });
    yield* service.setFilesViewed({ ...first, files: [{ path: "same.ts", viewed: false }] });
    assert.deepStrictEqual((yield* service.filesViewed(second)).files, [
      { path: "same.ts", state: "viewed" },
    ]);

    projects.push(
      project({
        id: "p2",
        title: "second repository",
        workspaceRoot: "/second",
        repository: "reviewer/second",
        provider: SourceControlProviderKind.make("forgejo"),
        host: "forge.example",
        remoteUrl: "https://forge.example:3000/reviewer/second.git",
      }),
    );
    assert.deepStrictEqual(
      (yield* service.filesViewed({ ...second, projectId: "p2" as ProjectId })).files,
      [{ path: "same.ts", state: "viewed" }],
    );
    projects.push(
      project({
        id: "ssh",
        title: "second repository over SSH",
        workspaceRoot: "/ssh",
        repository: "reviewer/second",
        provider: SourceControlProviderKind.make("forgejo"),
        host: "ssh.forge.example",
        remoteUrl: "git@ssh.forge.example:reviewer/second.git",
      }),
    );
    assert.deepStrictEqual(
      (yield* service.filesViewed({ ...second, projectId: "ssh" as ProjectId })).files,
      [{ path: "same.ts", state: "viewed" }],
    );
  }),
);

it.effect("keeps viewed files itself for a host that keeps none of its own", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const service = yield* environmentViewedService(
      new Map([
        ["src/a.ts", "blob-a"],
        ["src/b.ts", "blob-b"],
      ]),
      asked,
    );

    const empty = yield* service.filesViewed(GITLAB_REFERENCE);
    assert.deepStrictEqual(empty, { files: [], truncated: false });
    assert.deepStrictEqual(asked, []);

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [
        { path: "src/a.ts", viewed: true },
        { path: "src/b.ts", viewed: true },
      ],
    });
    const marked = yield* service.filesViewed(GITLAB_REFERENCE);

    assert.deepStrictEqual(
      [...marked.files].toSorted((left, right) => left.path.localeCompare(right.path)),
      [
        { path: "src/a.ts", state: "viewed" },
        { path: "src/b.ts", state: "viewed" },
      ],
    );
    assert.strictEqual(marked.truncated, false);
    assert.deepStrictEqual(
      asked.map((paths) => [...paths].toSorted()),
      [["src/a.ts", "src/b.ts"]],
    );
  }),
);

it.effect("reports a file pushed to since it was cleared as changed", () =>
  Effect.gen(function* () {
    const revisions = new Map([
      ["src/a.ts", "blob-a"],
      ["src/b.ts", "blob-b"],
    ]);
    const service = yield* environmentViewedService(revisions, []);

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [
        { path: "src/a.ts", viewed: true },
        { path: "src/b.ts", viewed: true },
      ],
    });
    revisions.set("src/a.ts", "blob-a-again");
    yield* service.invalidate({ reference: GITLAB_REFERENCE });
    const marked = yield* service.filesViewed(GITLAB_REFERENCE);

    assert.deepStrictEqual(
      [...marked.files].toSorted((left, right) => left.path.localeCompare(right.path)),
      [
        { path: "src/a.ts", state: "dismissed" },
        { path: "src/b.ts", state: "viewed" },
      ],
    );
  }),
);

it.effect("keeps a deleted file cleared, which the head has no version of at all", () =>
  Effect.gen(function* () {
    const service = yield* environmentViewedService(new Map(), []);

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [{ path: "src/gone.ts", viewed: true }],
    });
    yield* service.invalidate({ reference: GITLAB_REFERENCE });
    const marked = yield* service.filesViewed(GITLAB_REFERENCE);

    assert.deepStrictEqual(marked.files, [{ path: "src/gone.ts", state: "viewed" }]);
  }),
);

it.effect("leaves a mark alone when the host could not say what the head has of it", () =>
  Effect.gen(function* () {
    const revisions = new Map([
      ["src/a.ts", "blob-a"],
      ["src/past-the-cut.ts", "blob-b"],
    ]);
    const service = yield* environmentViewedService(
      revisions,
      [],
      new Set(["src/past-the-cut.ts"]),
    );

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [
        { path: "src/a.ts", viewed: true },
        { path: "src/past-the-cut.ts", viewed: true },
      ],
    });
    revisions.set("src/a.ts", "blob-a-again");
    yield* service.invalidate({ reference: GITLAB_REFERENCE });
    const marked = yield* service.filesViewed(GITLAB_REFERENCE);

    assert.deepStrictEqual(
      [...marked.files].toSorted((left, right) => left.path.localeCompare(right.path)),
      [
        { path: "src/a.ts", state: "dismissed" },
        { path: "src/past-the-cut.ts", state: "viewed" },
      ],
    );
  }),
);

it.effect("forgets what the head had of a marked file once a mutation moves the head", () =>
  Effect.gen(function* () {
    const revisions = new Map([["src/a.ts", "blob-a"]]);
    const service = yield* environmentViewedService(revisions, []);

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [{ path: "src/a.ts", viewed: true }],
    });
    revisions.set("src/a.ts", "blob-a-again");
    yield* service.runAction({ ...GITLAB_REFERENCE, action: "merge" });

    assert.deepStrictEqual((yield* service.filesViewed(GITLAB_REFERENCE)).files, [
      { path: "src/a.ts", state: "dismissed" },
    ]);
  }),
);

it.effect("finishes two presses on one file in the order they were made", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "on gitlab",
          workspaceRoot: "/a",
          repository: "group/project",
          provider: SourceControlProviderKind.make("gitlab"),
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            reactions: true,
            viewedFiles: "environment",
            review: FULL_REVIEW,
            reviewers: FULL_REVIEWERS,
          },
          getFilesViewed: () => Effect.die("the host keeps no marks of its own"),
          setFilesViewed: () => Effect.die("the host keeps no marks of its own"),
          getFileRevisions: (input) =>
            Deferred.await(held).pipe(
              Effect.as({ revisions: new Map(input.paths.map((path) => [path, "blob-a"])) }),
            ),
        }),
      ],
    });

    const tick = service
      .setFilesViewed({
        ...GITLAB_REFERENCE,
        files: [{ path: "src/a.ts", viewed: true }],
      })
      .pipe(Effect.runFork);
    yield* TestClock.adjust("1 second");
    const untick = service
      .setFilesViewed({
        ...GITLAB_REFERENCE,
        files: [{ path: "src/a.ts", viewed: false }],
      })
      .pipe(Effect.runFork);
    yield* TestClock.adjust("1 second");
    yield* Deferred.succeed(held, undefined);
    yield* Fiber.join(tick);
    yield* Fiber.join(untick);

    const marked = yield* service.filesViewed(GITLAB_REFERENCE);
    assert.deepStrictEqual(marked.files, []);
  }),
);

const azureViewedService = (projects: ReadonlyArray<OrchestrationProjectShell>) =>
  makeService({
    projects,
    providers: [
      fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
        ...keyedByCanonicalKey,
        capabilities: {
          diff: true,
          comment: true,
          actions: ["merge"],
          mergeMethods: ["merge"],
          search: true,
          reactions: true,
          viewedFiles: "environment",
          review: FULL_REVIEW,
          reviewers: FULL_REVIEWERS,
        },
        getFilesViewed: () => Effect.die("the host keeps no marks of this environment's own"),
        setFilesViewed: () => Effect.die("the host keeps no marks of this environment's own"),
        getFileRevisions: (input) =>
          Effect.succeed({ revisions: new Map(input.paths.map((path) => [path, "blob-a"])) }),
      }),
    ],
  });

const AZURE_PAIR = [
  project({
    id: "p1",
    title: "platform web",
    workspaceRoot: "/a",
    repository: "acme/platform/_git/web",
    provider: SourceControlProviderKind.make("azure-devops"),
    host: "dev.azure.com",
  }),
  project({
    id: "p2",
    title: "other web",
    workspaceRoot: "/b",
    repository: "acme/other/_git/web",
    provider: SourceControlProviderKind.make("azure-devops"),
    host: "dev.azure.com",
  }),
];

const AZURE_PLATFORM = { projectId: "p1" as ProjectId, repository: "web", number: 1 };
const AZURE_OTHER = { projectId: "p2" as ProjectId, repository: "web", number: 1 };

it.effect("keeps the marks of two Azure repositories of the same name apart", () =>
  Effect.gen(function* () {
    const service = yield* azureViewedService(AZURE_PAIR);

    yield* service.setFilesViewed({
      ...AZURE_PLATFORM,
      files: [{ path: "src/a.ts", viewed: true }],
    });

    assert.deepStrictEqual((yield* service.filesViewed(AZURE_PLATFORM)).files, [
      { path: "src/a.ts", state: "viewed" },
    ]);
    assert.deepStrictEqual((yield* service.filesViewed(AZURE_OTHER)).files, []);
  }),
);

it.effect("keeps environment marks apart from another change request's", () =>
  Effect.gen(function* () {
    const service = yield* environmentViewedService(new Map([["src/a.ts", "blob-a"]]), []);

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [{ path: "src/a.ts", viewed: true }],
    });
    const other = yield* service.filesViewed({ ...GITLAB_REFERENCE, number: 2 });

    assert.deepStrictEqual(other.files, []);
  }),
);

const environmentViewedServiceWithViewer = (
  revisions: Map<string, string>,
  getViewer: PullRequestProviderApi["getViewer"],
) =>
  makeService({
    projects: [
      project({
        id: "p1",
        title: "on gitlab",
        workspaceRoot: "/a",
        repository: "group/project",
        provider: SourceControlProviderKind.make("gitlab"),
      }),
    ],
    providers: [{ ...environmentViewedProvider(revisions, []), getViewer }],
  });

it.effect("keeps one reader's marks on a host that names nobody", () =>
  Effect.gen(function* () {
    const service = yield* environmentViewedServiceWithViewer(
      new Map([["src/a.ts", "blob-a"]]),
      () => Effect.succeed(""),
    );

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: [{ path: "src/a.ts", viewed: true }],
    });

    assert.deepStrictEqual((yield* service.filesViewed(GITLAB_REFERENCE)).files, [
      { path: "src/a.ts", state: "viewed" },
    ]);
  }),
);

it.effect("carries a bounded number of its own marks and says it held more", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const paths = Array.from(
      { length: PullRequestFilesViewed.MAX_FILES_VIEWED_ROWS + 40 },
      (_, at) => `src/f${String(at).padStart(4, "0")}.ts`,
    );
    const service = yield* environmentViewedService(
      new Map(paths.map((path) => [path, "blob"] as const)),
      asked,
    );

    yield* service.setFilesViewed({
      ...GITLAB_REFERENCE,
      files: paths.map((path) => ({ path, viewed: true })),
    });
    const read = yield* service.filesViewed(GITLAB_REFERENCE);

    assert.lengthOf(read.files, PullRequestFilesViewed.MAX_FILES_VIEWED_ROWS);
    assert.strictEqual(read.truncated, true);
  }),
);

it.effect("keeps Azure continuation cursors separate for repositories with the same name", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const service = yield* makeService({
      projects: ["org-a", "org-b"].map((organization) =>
        project({
          id: organization,
          title: organization,
          workspaceRoot: `/${organization}`,
          repository: `${organization}/project/_git/web`,
          provider: SourceControlProviderKind.make("azure-devops"),
          host: "dev.azure.com",
        }),
      ),
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("azure-devops"), {
          ...keyedByCanonicalKey,
          listChangeRequests: (input) =>
            Effect.sync(() => {
              seen.push(input.cwd);
              return {
                items: [changeRequest(7, "2026-07-02T00:00:00Z")],
                truncated: true,
                continues: true,
              };
            }),
        }),
      ],
    });
    const first = yield* service.list({ state: "open" });
    assert.lengthOf(Object.keys(first.nextCursors), 2);
    const key = Object.keys(first.nextCursors).find((key) => key.includes("org-b"))!;
    seen.length = 0;
    yield* service.list({ state: "open", cursors: { [key]: first.nextCursors[key]! } });
    assert.deepStrictEqual(seen, ["/org-b"]);
  }),
);

it.effect("pauses uncached activity on a host after one activity read is rate limited", () =>
  Effect.gen(function* () {
    let activityReads = 0;
    const service = yield* makeService({
      projects: [
        project({
          id: "p1",
          title: "web",
          workspaceRoot: "/repo",
          repository: "acme/web",
          provider: "gitlab",
          host: "gitlab.example.test",
        }),
      ],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("gitlab"), {
          getChangeRequestActivity: () =>
            Effect.suspend(() => {
              activityReads++;
              return Effect.fail(
                new PullRequestProviderError({
                  provider: SourceControlProviderKind.make("gitlab"),
                  operation: "getChangeRequestActivity",
                  reason: "rate-limited",
                  detail: "API rate limit exceeded.",
                }),
              );
            }),
        }),
      ],
    });
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };

    expect(yield* Effect.result(service.activity(reference))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "PullRequestOperationError",
        cause: { _tag: "PullRequestProviderError", reason: "rate-limited" },
      },
    });
    assert.strictEqual(activityReads, 1);

    // A different change request cannot reuse the first request's cached failure.
    expect(yield* Effect.result(service.activity({ ...reference, number: 2 }))).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "PullRequestOperationError",
        cause: {
          _tag: "PullRequestProviderError",
          reason: "rate-limited",
          cause: {
            _tag: "SourceControlRateLimitPausedError",
            host: "gitlab.example.test",
          },
        },
      },
    });
    assert.strictEqual(activityReads, 1);
  }),
);

it.effect(
  "reuses loaded oversized diff slices to expand only files the change request changes",
  () =>
    Effect.gen(function* () {
      const read: Array<string> = [];
      const diffReads: Array<string | undefined> = [];
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
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getDiff: (input) =>
              Effect.sync(() => {
                diffReads.push(input.cursor);
                return input.cursor === undefined
                  ? {
                      patch: [
                        "diff --git a/src/old.ts b/src/new.ts",
                        "rename from src/old.ts",
                        "rename to src/new.ts",
                        "--- a/src/old.ts",
                        "+++ b/src/new.ts",
                        `+${"x".repeat(300_000)}`,
                        "",
                      ].join("\n"),
                      truncated: false,
                      nextCursor: "2",
                    }
                  : {
                      patch: [
                        "diff --git a/gone.md b/gone.md",
                        "deleted file mode 100644",
                        "--- a/gone.md",
                        "+++ /dev/null",
                        `-${"x".repeat(300_000)}`,
                        "",
                      ].join("\n"),
                      truncated: false,
                      nextCursor: null,
                    };
              }),
            getDiffFileContents: (input) =>
              Effect.sync(() => {
                read.push(`${input.oldPath}->${input.newPath}`);
                return { oldContents: "old", newContents: "new" };
              }),
          }),
        ],
      });
      const ref = { projectId: "p1" as ProjectId, repository: "pingdotgg/t3code", number: 1 };

      yield* service.diff(ref);
      yield* service.diff({ ...ref, cursor: "2" });

      yield* service.diffFileContents({
        ...ref,
        changeType: "rename-changed",
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
      });
      yield* service.diffFileContents({
        ...ref,
        changeType: "deleted",
        oldPath: "gone.md",
        newPath: "gone.md",
      });
      const outside = yield* service
        .diffFileContents({ ...ref, changeType: "deleted", oldPath: ".env", newPath: ".env" })
        .pipe(Effect.flip);
      const halfRename = yield* service
        .diffFileContents({
          ...ref,
          changeType: "change",
          oldPath: "src/secret.ts",
          newPath: "src/new.ts",
        })
        .pipe(Effect.flip);

      assert.strictEqual(outside._tag, "PullRequestOperationError");
      assert.strictEqual(halfRename._tag, "PullRequestOperationError");
      assert.deepStrictEqual(read, ["src/old.ts->src/new.ts", "gone.md->gone.md"]);
      assert.deepStrictEqual(diffReads, [undefined, "2"]);
    }),
);

// Refresh and expiry are covered by the in-flight test below; repository and number share the ref key.
it.effect.each(["commit", "credential"] as const)(
  "does not reuse loaded diff membership after changing %s",
  (boundary) =>
    Effect.gen(function* () {
      let credential = "broad";
      let diffReads = 0;
      let contentReads = 0;
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            withVerifiedCredential: (_, use) =>
              Effect.suspend(() =>
                use({ accountId: "101", viewer: "octocat", credentialFingerprint: credential }),
              ),
            getDiff: () =>
              Effect.sync(() => ({
                patch:
                  ++diffReads === 1
                    ? `diff --git a/private.ts b/private.ts\n--- a/private.ts\n+++ b/private.ts\n+${"x".repeat(300_000)}\n`
                    : "",
                truncated: false,
                nextCursor: null,
              })),
            getDiffFileContents: () =>
              Effect.sync(() => {
                contentReads += 1;
                return { oldContents: "old", newContents: "new" };
              }),
          }),
        ],
      });
      const ref = {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        host: "github.com",
        expectedAccountId: "101",
      };
      // Load at a commit and expand without one so the commit must be part of the membership key.
      const loaded = boundary === "commit" ? { ...ref, commit: "a".repeat(40) } : ref;
      yield* service.withRoutingCredential(loaded, service.diff(loaded));
      if (boundary === "credential") credential = "restricted";
      const input = {
        ...ref,
        changeType: "change" as const,
        oldPath: "private.ts",
        newPath: "private.ts",
      };
      const error = yield* service
        .withRoutingCredential(input, service.diffFileContents(input))
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.strictEqual(error.reason, "not-found");
      assert.strictEqual(diffReads, 2);
      assert.strictEqual(contentReads, 0);
    }),
);

it.effect.each(["expiry", "refresh"] as const)(
  "keeps a loaded diff's original membership scope through an in-flight %s",
  (boundary) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let diffReads = 0;
      const service = yield* makeService({
        projects: [
          project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
        ],
        providers: [
          fakePullRequestProvider(SourceControlProviderKind.make("github"), {
            getDiff: () =>
              Effect.gen(function* () {
                if (++diffReads !== 1) return { patch: "", truncated: false, nextCursor: null };
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  patch: `diff --git a/private.ts b/private.ts\n--- a/private.ts\n+++ b/private.ts\n+${"x".repeat(300_000)}\n`,
                  truncated: false,
                  nextCursor: null,
                };
              }),
            getDiffFileContents: () => Effect.die("an expired file must not be read"),
          }),
        ],
      });
      const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
      const loading = yield* Effect.forkChild(service.diff(ref));
      yield* Deferred.await(started);
      if (boundary === "expiry") yield* TestClock.adjust("61 seconds");
      else yield* service.invalidate({ reference: ref });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(loading);
      const error = yield* service
        .diffFileContents({
          ...ref,
          changeType: "change",
          oldPath: "private.ts",
          newPath: "private.ts",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PullRequestOperationError");
      assert.strictEqual(error.reason, "not-found");
      assert.strictEqual(diffReads, 2);
    }),
);
