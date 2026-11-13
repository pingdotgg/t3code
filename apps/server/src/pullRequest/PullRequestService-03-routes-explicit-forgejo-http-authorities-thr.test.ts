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
  keyedByCanonicalKey,
  makeService,
  batchedChangeRequest,
} from "./PullRequestService-fixtures.testkit.ts";

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
    let projectReads = 0;
    const service = yield* makeService({
      onProjectRead: () => {
        projectReads += 1;
      },
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

    // A sync sweep resolves the project once for all of its references, then reads fresh again.
    const readsPerReference = projectReads;
    const read = (number: number) =>
      service.summary(
        { projectId: "frontend" as ProjectId, host: "github.com", repository: "acme/api", number },
        { recoverTransientFailure: false },
      );
    assert.isAbove(readsPerReference, 2);
    yield* service.withSharedProjectReads(Effect.all([read(8), read(9), read(10)]));
    // One read of the project and one of the host's projects, for all three references.
    assert.strictEqual(projectReads, readsPerReference + 2);
    yield* read(11);
    assert.strictEqual(projectReads, readsPerReference * 2 + 2);
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
