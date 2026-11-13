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
  hostedChangeRequest,
  unusable,
  requestFailed,
  keyedByCanonicalKey,
  makeService,
} from "./PullRequestService-fixtures.testkit.ts";

it.effect("reads maintainer edits and changes them through the update command", () =>
  Effect.gen(function* () {
    let enabled = true;
    const provider = fakePullRequestProvider(SourceControlProviderKind.make("github"), {
      getChangeRequest: () =>
        Effect.succeed({ ...hostedChangeRequest("Body"), maintainerCanModify: enabled }),
      updateChangeRequest: (input) =>
        Effect.sync(() => {
          assert.strictEqual(input.title, undefined);
          assert.strictEqual(input.body, undefined);
          enabled = input.maintainerCanModify!;
        }),
    });
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/w", repository: "acme/web" })],
      providers: [
        {
          ...provider,
          capabilities: {
            ...provider.capabilities,
            edit: { changeRequest: true, comment: true, maintainerEdits: true },
          },
        },
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    assert.strictEqual((yield* service.detail(ref)).maintainerCanModify, true);
    yield* service.update({ ...ref, maintainerCanModify: false });
    assert.strictEqual((yield* service.detail(ref)).maintainerCanModify, false);
  }),
);
it.effect("refuses maintainer edits on a host without the capability", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/w", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          updateChangeRequest: () =>
            Effect.sync(() => {
              writes += 1;
            }),
        }),
      ],
    });
    const result = yield* service
      .update({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        maintainerCanModify: false,
      })
      .pipe(Effect.flip);
    assert.strictEqual(result._tag, "PullRequestOperationError");
    assert.strictEqual(writes, 0);
  }),
);
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
it.effect("reads nothing from a host its provider does not serve, but reports it", () =>
  Effect.gen(function* () {
    const reached = new Set<string>();
    const bitbucket = (id: string, host: string) =>
      project({
        id,
        title: host,
        workspaceRoot: `/${id}`,
        repository: "proj/repo",
        provider: SourceControlProviderKind.make("bitbucket"),
        host,
      });
    const service = yield* makeService({
      projects: [bitbucket("p1", "bitbucket.org"), bitbucket("p2", "bitbucket.example.com")],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("bitbucket"), {
          servesHost: (host) => host === "bitbucket.org",
          getViewer: ({ host }) => {
            reached.add(host ?? "");
            return Effect.succeed("bilal");
          },
          listChangeRequests: ({ host }) => {
            reached.add(host);
            return Effect.succeed({ items: [], truncated: false, continues: false });
          },
        }),
      ],
    });

    const result = yield* service.list({ state: "open" });

    assert.deepStrictEqual([...reached], ["bitbucket.org"]);
    assert.deepStrictEqual(
      result.providers.map(({ host, configured, detail }) => ({ host, configured, detail })),
      [
        { host: "bitbucket.org", configured: true, detail: null },
        {
          host: "bitbucket.example.com",
          configured: false,
          detail: "This host cannot be browsed here yet.",
        },
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
