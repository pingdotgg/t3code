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
  FULL_REVIEW,
  FULL_REVIEWERS,
  keyedByCanonicalKey,
  makeService,
  environmentViewedProvider,
  environmentViewedService,
  GITLAB_REFERENCE,
  azureViewedService,
  AZURE_PAIR,
  AZURE_PLATFORM,
  AZURE_OTHER,
  environmentViewedServiceWithViewer,
} from "./PullRequestService-fixtures.testkit.ts";

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
it.effect("authorizes cold source reads with paginated paths without fetching patch hunks", () =>
  Effect.gen(function* () {
    const pages: Array<string | undefined> = [];
    const contents: Array<string> = [];
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getDiff: () => Effect.die("Membership must not fetch patch hunks"),
          getDiffFilePaths: (input) =>
            Effect.sync(() => {
              pages.push(input.cursor);
              return input.cursor === undefined
                ? { files: [{ oldPath: "before.ts", newPath: "after.ts" }], nextCursor: "next" }
                : { files: [{ oldPath: "gone.ts", newPath: "gone.ts" }], nextCursor: null };
            }),
          getDiffFileContents: (input) =>
            Effect.sync(() => {
              contents.push(`${input.oldPath}->${input.newPath}`);
              return { oldContents: "before", newContents: "after" };
            }),
        }),
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    yield* service.diffFileContents({
      ...ref,
      changeType: "rename-changed",
      oldPath: "before.ts",
      newPath: "after.ts",
    });
    yield* service.diffFileContents({
      ...ref,
      changeType: "deleted",
      oldPath: "gone.ts",
      newPath: "gone.ts",
    });
    for (const [oldPath, newPath] of [
      [".env", ".env"],
      ["../after.ts", "../after.ts"],
      ["secret.ts", "after.ts"],
    ] as const) {
      const error = yield* service
        .diffFileContents({ ...ref, changeType: "change", oldPath, newPath })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-found");
    }
    assert.deepStrictEqual(pages, [undefined, "next"]);
    assert.deepStrictEqual(contents, ["before.ts->after.ts", "gone.ts->gone.ts"]);
  }),
);
it.effect.each(["commit", "credential", "expiry", "refresh"] as const)(
  "keeps cold metadata membership in its original scope through an in-flight %s",
  (boundary) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let credential = "broad";
      let pathReads = 0;
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
            getDiff: () => Effect.die("Membership must not fetch patch hunks"),
            getDiffFilePaths: (input) =>
              Effect.gen(function* () {
                assert.strictEqual(input.cwd, "/a");
                assert.strictEqual(input.host, "github.com");
                assert.strictEqual(input.repository, "acme/web");
                if (++pathReads !== 1) return { files: [], nextCursor: null };
                assert.strictEqual(
                  input.commit,
                  boundary === "commit" ? "a".repeat(40) : undefined,
                );
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return {
                  files: [{ oldPath: "private.ts", newPath: "private.ts" }],
                  nextCursor: null,
                };
              }),
            getDiffFileContents: () =>
              Effect.sync(() => {
                contentReads += 1;
                return { oldContents: "old", newContents: "new" };
              }),
          }),
        ],
      });
      const input = {
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        host: "github.com",
        expectedAccountId: "101",
        changeType: "change" as const,
        oldPath: "private.ts",
        newPath: "private.ts",
      };
      const initial = boundary === "commit" ? { ...input, commit: "a".repeat(40) } : input;
      const loading = yield* Effect.forkChild(
        service.withRoutingCredential(initial, service.diffFileContents(initial)),
      );
      yield* Deferred.await(started);
      if (boundary === "expiry") yield* TestClock.adjust("61 seconds");
      if (boundary === "refresh") yield* service.invalidate({ reference: input });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(loading);
      if (boundary === "credential") credential = "restricted";
      const error = yield* service
        .withRoutingCredential(input, service.diffFileContents(input))
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "not-found");
      assert.strictEqual(pathReads, 2);
      assert.strictEqual(contentReads, 1);
    }),
);
