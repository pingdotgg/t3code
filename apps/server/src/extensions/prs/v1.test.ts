import {
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  PullRequestUnavailableError,
  extensionWorkspaceRevision,
  type OrchestrationProjectShell,
  type PullRequestActivity as NativePullRequestActivity,
  type PullRequestDetail as NativePullRequestDetail,
  type PullRequestDiffResult as NativePullRequestDiffResult,
  type PullRequestListResult as NativePullRequestListResult,
  type PullRequestRef as NativePullRequestRef,
} from "@t3tools/contracts";
import {
  PRS_READ_API,
  type PrsDiffStreamEvent,
  type PrsFilesViewedResult,
} from "@t3tools/extension-sdk/catalogue";
import { Ajv } from "ajv";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { it, expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Persistence from "effect/unstable/persistence/Persistence";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "../../pullRequest/PullRequestProvider.ts";
import {
  PullRequestProviderRegistry,
  fromProviders,
} from "../../pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "../../pullRequest/PullRequestReadCache.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../../sourceControl/SourceControlRateLimit.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PullRequestFilesViewed from "../../persistence/PullRequestFilesViewed.ts";
import { createPrsApiProvider } from "./v1.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const READ_ONLY = [AuthOrchestrationReadScope] as const;
const signal = new AbortController().signal;

const PROJECT_ID = ProjectId.make("project");
const WORKSPACE_ROOT = "/workspace/project";
const NOW = "2026-01-01T00:00:00.000Z";

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{
  readonly cause: unknown;
}> {}

const makeContext = (): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(WORKSPACE_ROOT, null),
});

const meta = (
  provider: HostApiProvider,
  scopes: readonly string[] = READ_ONLY,
): Parameters<HostApiProvider["invoke"]>[4] => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes,
  },
  assertAuthority: async () => {},
});

const invoke = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1],
  context: ViewContext,
  scopes: readonly string[] = READ_ONLY,
) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(provider.invoke(method, input, context, signal, meta(provider, scopes))),
    catch: (cause) => new InvokeRejection({ cause }),
  });

const invokeError = (...args: Parameters<typeof invoke>) =>
  invoke(...args).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) {
        throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
      }
      return rejection.cause;
    }),
  );

const collectStream = (
  provider: HostApiProvider,
  name: string,
  input: unknown,
  context: ViewContext,
  scopes: readonly string[] = READ_ONLY,
  resumeCursor?: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const iterable = provider.subscribe!(
        name,
        input as Parameters<NonNullable<HostApiProvider["subscribe"]>>[1],
        context,
        signal,
        meta(provider, scopes),
        resumeCursor,
      );
      const events: ApiStreamEvent[] = [];
      for await (const event of iterable) events.push(event);
      return events;
    },
    catch: (cause) => new InvokeRejection({ cause }),
  });

const collectStreamError = (...args: Parameters<typeof collectStream>) =>
  collectStream(...args).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) {
        throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
      }
      return rejection.cause;
    }),
  );

const REF = { repository: "owner/repo", number: 42 } as const;

const listEntry = {
  provider: "github" as const,
  host: "github.com",
  projectId: PROJECT_ID,
  projectTitle: "Project",
  repository: "owner/repo",
  number: 42,
  title: "Ship it",
  url: "https://github.com/owner/repo/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feature",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  additions: 3,
  deletions: 1,
  createdAt: NOW,
  updatedAt: NOW,
  viewerReviewRequested: false,
  labels: [],
};

const listResult = {
  viewers: { "github.com": "octocat" },
  providers: [
    {
      host: "github.com",
      kind: "github" as const,
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
  ],
  entries: [listEntry],
  errors: [],
  truncated: false,
  nextCursors: {},
} satisfies NativePullRequestListResult;

const detail = {
  provider: "github" as const,
  capabilities: {
    diff: true,
    comment: true,
    actions: ["merge" as const],
    mergeMethods: ["merge" as const],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: ["approve" as const] },
    reviewers: { request: true, listCandidates: true },
  },
  viewerPermissions: {
    actions: ["merge" as const],
    comment: true,
    resolve: true,
    verdicts: ["approve" as const],
    requestReviewers: true,
  },
  projectId: PROJECT_ID,
  projectTitle: "Project",
  workspaceRoot: WORKSPACE_ROOT,
  repository: "owner/repo",
  number: 42,
  title: "Ship it",
  body: "the body",
  url: "https://github.com/owner/repo/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: false, rebase: false },
} satisfies NativePullRequestDetail;

const activity: NativePullRequestActivity = {
  comments: [
    {
      id: "c1",
      kind: "issue-comment" as const,
      author: { login: "octocat", name: null, avatarUrl: null },
      body: "looks good",
      createdAt: NOW,
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  commentCount: 1,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [
    {
      oid: "abc123",
      messageHeadline: "ship it",
      committedDate: NOW,
    },
  ],
};

type Deps = Parameters<typeof createPrsApiProvider>[0];
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const githubProviderApi = (
  overrides: Partial<PullRequestProviderApi["capabilities"]> = {},
  extras: {
    [K in keyof PullRequestProviderApi]?: PullRequestProviderApi[K] | undefined;
  } = {},
): PullRequestProviderApi =>
  ({
    kind: "github",
    capabilities: {
      diff: true,
      comment: true,
      actions: [],
      mergeMethods: ["merge"],
      search: true,
      review: { inlineComment: true, reply: true, resolve: true, verdicts: ["approve"] },
      reviewers: { request: true, listCandidates: true },
      labels: true,
      ...overrides,
    },
    getReviewThreadComments: () => Effect.die("unused"),
    getChangeRequestStack: () => Effect.die("unused"),
    getDiffFileContents: () => Effect.die("unused"),
    listChangeRequestStats: () => Effect.die("unused"),
    listLabelCandidates: () => Effect.die("unused"),
    ...extras,
  }) as PullRequestProviderApi;

const GITHUB_IDENTITY: NonNullable<OrchestrationProjectShell["repositoryIdentity"]> = {
  canonicalKey: "github.com/owner/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "https://github.com/owner/repo.git",
  },
  provider: "github",
  displayName: "owner/repo",
};

const projectShell = (
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = GITHUB_IDENTITY,
  id: string = PROJECT_ID,
): OrchestrationProjectShell =>
  ({
    id: ProjectId.make(id),
    title: "Project",
    workspaceRoot: WORKSPACE_ROOT,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) as OrchestrationProjectShell;

const makeDeps = (
  pullRequests: Partial<Deps["pullRequests"]>,
  options: {
    readonly registry?: Deps["prRegistry"];
    readonly shells?: ReadonlyArray<OrchestrationProjectShell>;
    readonly shell?: OrchestrationProjectShell;
    readonly sql?: SqlClient.SqlClient;
  } = {},
): Deps => ({
  environmentId: "env",
  projects: {
    getById: () =>
      Effect.succeed(
        Option.some({
          projectId: PROJECT_ID,
          workspaceRoot: WORKSPACE_ROOT,
          deletedAt: null,
        }),
      ),
  },
  threads: {
    getById: () =>
      Effect.succeed(Option.some({ projectId: PROJECT_ID, worktreePath: null, deletedAt: null })),
  },
  pullRequests: {
    list: () => Effect.die("unused"),
    listStats: () => Effect.die("unused"),
    summary: () => Effect.die("unused"),
    stack: () => Effect.die("unused"),
    detail: () => Effect.die("unused"),
    filesViewed: () => Effect.succeed({ files: [], truncated: false }),
    activity: () => Effect.die("unused"),
    threadComments: () => Effect.die("unused"),
    diff: () => Effect.die("unused"),
    diffFileContents: () => Effect.die("unused"),
    reviewerCandidates: () => Effect.die("unused"),
    labelCandidates: () => Effect.die("unused"),
    invalidate: () => Effect.die("unused"),
    subscribeRefreshes: Stream.never,
    ...pullRequests,
  },
  prRegistry: options.registry ?? fromProviders([githubProviderApi()]),
  projectionSnapshotQuery: {
    getProjectShellById: (projectId) =>
      Effect.succeed(
        Option.fromNullishOr(
          options.shells !== undefined
            ? options.shells.find((shell) => shell.id === projectId)
            : (options.shell ?? projectShell()),
        ),
      ),
  },
  sql: options.sql ?? ({} as SqlClient.SqlClient),
});

it.layer(NodeServices.layer)("t3.prs/read adapter", (it) => {
  it.effect("list forces the scoped project and round-trips rows", () =>
    Effect.gen(function* () {
      const calls: { method: string; input: unknown }[] = [];
      const provider = createPrsApiProvider(
        makeDeps({
          list: (input) => {
            calls.push({ method: "list", input });
            return Effect.succeed(listResult);
          },
        }),
      );
      const result = (yield* invoke(provider, "list", { state: "open" }, makeContext())) as {
        entries: readonly { number: number }[];
        nextCursors: Record<string, string>;
      };
      // projectIds is not part of the public input; the scope's project is
      // always the one queried.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toMatchObject({
        state: "open",
        projectIds: ["project"],
      });
      expect(result.entries[0]!.number).toBe(42);
      expect(result.nextCursors).toEqual({});

      // A smuggled projectIds cannot widen the scope: the strict decoder
      // refuses it by operation name.
      const widened = yield* invokeError(
        provider,
        "list",
        { state: "open", projectIds: ["other"] },
        makeContext(),
      );
      expect(widened.operation).toBe("prs.list");
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("detail and activity round-trip the native shapes", () =>
    Effect.gen(function* () {
      const calls: { method: string; input: unknown }[] = [];
      const provider = createPrsApiProvider(
        makeDeps({
          detail: (input) => {
            calls.push({ method: "detail", input });
            return Effect.succeed(detail);
          },
          activity: (input) => {
            calls.push({ method: "activity", input });
            return Effect.succeed(activity);
          },
        }),
      );
      const context = makeContext();
      const got = (yield* invoke(provider, "detail", REF, context)) as { title: string };
      expect(got.title).toBe("Ship it");
      const nativeRef = calls[0]!.input as NativePullRequestRef;
      expect(nativeRef).toEqual({ projectId: PROJECT_ID, repository: "owner/repo", number: 42 });

      const gotActivity = (yield* invoke(provider, "activity", REF, context)) as {
        comments: readonly { body: string }[];
        truncated: boolean;
      };
      expect(gotActivity.comments[0]!.body).toBe("looks good");
      expect(gotActivity.truncated).toBe(false);
    }),
  );

  it.effect("projects native detail additions onto the SDK output schema", () =>
    Effect.gen(function* () {
      const nativeDetail = {
        ...detail,
        capabilities: {
          ...detail.capabilities,
          viewedFiles: "host" as const,
          futureCapability: true,
          review: { ...detail.capabilities.review, futureReviewCapability: true },
        },
        viewerPermissions: { ...detail.viewerPermissions, futurePermission: true },
        author: { ...detail.author, nativeId: 123 },
        checks: [
          { name: "CI", status: "success" as const, description: null, url: null, nativeId: 1 },
        ],
        mergeCapabilities: { ...detail.mergeCapabilities, futureMergeMethod: true },
      };
      const provider = createPrsApiProvider(
        makeDeps({ detail: () => Effect.succeed(nativeDetail) }),
      );
      const result = yield* invoke(provider, "detail", REF, makeContext());
      const validate = new Ajv({ strict: true, addUsedSchema: false }).compile(
        PRS_READ_API.methods!.find((method) => method.name === "detail")!.outputSchema,
      );
      expect(
        validate(result),
        validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("\n"),
      ).toBe(true);
      expect(result).toMatchObject({ title: detail.title, capabilities: detail.capabilities });
      expect(result).not.toHaveProperty("nativeOnly");
      expect(result).toHaveProperty("capabilities.viewedFiles", "host");
      expect(nativeDetail.capabilities.viewedFiles).toBe("host");
      expect(nativeDetail.author.nativeId).toBe(123);
    }),
  );

  it.effect("reads viewed states separately without charging detail for the read", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const filesViewed = {
        files: [
          { path: "src/a.ts", state: "viewed" as const },
          { path: "src/b.ts", state: "dismissed" as const },
        ],
        truncated: true,
      };
      for (const store of ["host", "environment", undefined] as const) {
        const provider = createPrsApiProvider(
          makeDeps({
            detail: () =>
              Effect.succeed({
                ...detail,
                capabilities: { ...detail.capabilities, viewedFiles: store },
              }),
            filesViewed: (input) => {
              calls.push(input);
              return Effect.succeed(filesViewed);
            },
          }),
        );
        const result = yield* invoke(provider, "detail", REF, makeContext());
        if (store === undefined) {
          expect(result).not.toHaveProperty("filesViewed");
          expect(result).not.toHaveProperty("capabilities.viewedFiles");
        } else {
          expect(result).toMatchObject({ capabilities: { viewedFiles: store } });
        }
        const schema = PRS_READ_API.methods!.find(
          (method) => method.name === "detail",
        )!.outputSchema;
        expect(new Ajv({ strict: true, addUsedSchema: false }).compile(schema)(result)).toBe(true);
        expect(result).not.toHaveProperty("filesViewed");
        expect(result).not.toHaveProperty("filesViewedError");
        expect(calls).toHaveLength(store === "host" ? 0 : store === "environment" ? 1 : 2);
        if (store !== undefined) {
          expect(yield* invoke(provider, "filesViewed", REF, makeContext())).toMatchObject({
            ...filesViewed,
            nextCursor: null,
          });
        }
      }
      expect(calls).toEqual([
        { projectId: PROJECT_ID, repository: REF.repository, number: REF.number },
        { projectId: PROJECT_ID, repository: REF.repository, number: REF.number },
      ]);
    }),
  );

  it.effect("advertises viewed reads only when the scoped provider supports them", () =>
    Effect.gen(function* () {
      for (const store of [undefined, "host", "environment"] as const) {
        const provider = createPrsApiProvider(
          makeDeps(
            { list: () => Effect.succeed(listResult) },
            {
              registry: fromProviders([githubProviderApi({ viewedFiles: store })]),
            },
          ),
        );
        const capabilities = yield* invoke(provider, "getCapabilities", {}, makeContext());
        expect(capabilities).toMatchObject({
          operations: { "prs.filesViewed": store === "environment" },
        });
      }
      const provider = createPrsApiProvider(
        makeDeps(
          { list: () => Effect.succeed(listResult) },
          {
            registry: fromProviders([
              githubProviderApi(
                { viewedFiles: "host" },
                {
                  getFilesViewed: () => Effect.succeed({ files: [], truncated: false }),
                },
              ),
            ]),
          },
        ),
      );
      expect(yield* invoke(provider, "getCapabilities", {}, makeContext())).toMatchObject({
        operations: { "prs.filesViewed": true },
      });
    }),
  );

  it.effect("keeps detail independent while a separate viewed-state read fails by name", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          detail: () =>
            Effect.succeed({
              ...detail,
              capabilities: { ...detail.capabilities, viewedFiles: "host" as const },
            }),
          filesViewed: () =>
            Effect.fail(new PullRequestUnavailableError({ reason: "cli-unauthenticated" })),
        }),
      );
      const result = yield* invoke(provider, "detail", REF, makeContext());
      expect(result).toHaveProperty("title", detail.title);
      expect(result).not.toHaveProperty("filesViewed");
      expect(result).not.toHaveProperty("filesViewedError");
      const error = yield* invokeError(provider, "filesViewed", REF, makeContext());
      expect(error.operation).toBe("prs.filesViewed");
      expect(error.detail).toContain("authenticated");
    }),
  );

  it.effect("pages all 500 viewed paths within their own envelope without truncating them", () =>
    Effect.gen(function* () {
      const filesViewed = {
        files: Array.from({ length: 500 }, (_, index) => ({
          path: `${index}/${"x".repeat(4090)}`,
          state: "viewed" as const,
        })),
        truncated: false,
      };
      const provider = createPrsApiProvider(
        makeDeps({
          detail: () =>
            Effect.succeed({
              ...detail,
              capabilities: { ...detail.capabilities, viewedFiles: "environment" as const },
            }),
          filesViewed: () => Effect.succeed(filesViewed),
        }),
      );
      const delivered: typeof filesViewed.files = [];
      let cursor: string | null = null;
      do {
        const result = (yield* invoke(
          provider,
          "filesViewed",
          { ...REF, ...(cursor === null ? {} : { cursor }) },
          makeContext(),
        )) as { files: typeof filesViewed.files; truncated: boolean; nextCursor: string | null };
        expect(result.truncated).toBe(false);
        const encoded = yield* encodeJson(result);
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(48 * 1024);
        expect(
          new Ajv({ strict: true, addUsedSchema: false }).compile(
            PRS_READ_API.methods!.find((method) => method.name === "filesViewed")!.outputSchema,
          )(result),
        ).toBe(true);
        delivered.push(...result.files);
        cursor = result.nextCursor;
      } while (cursor !== null);
      expect(delivered).toEqual(filesViewed.files);
      expect(filesViewed.files).toHaveLength(500);
      expect(filesViewed.truncated).toBe(false);
    }),
  );

  it.effect("identifies the whole viewed snapshot across pages and native cache turnover", () =>
    Effect.gen(function* () {
      const files = Array.from({ length: 20 }, (_, index) => ({
        path: `${index}/${"x".repeat(4090)}`,
        state: "viewed" as const,
      }));
      let result: { files: { path: string; state: "viewed" | "dismissed" }[]; truncated: boolean } =
        {
          files,
          truncated: false,
        };
      const provider = createPrsApiProvider(
        makeDeps({ filesViewed: () => Effect.succeed(result) }),
      );
      const first = (yield* invoke(
        provider,
        "filesViewed",
        REF,
        makeContext(),
      )) as PrsFilesViewedResult;
      expect(first.snapshot).toMatch(/^[a-f0-9]{64}$/);
      expect(first.nextCursor).not.toBeNull();
      const next = (yield* invoke(
        provider,
        "filesViewed",
        { ...REF, cursor: first.nextCursor },
        makeContext(),
      )) as PrsFilesViewedResult;
      expect(next.snapshot).toBe(first.snapshot);
      for (const changed of [
        { files: files.slice(1), truncated: false },
        { files: files.toReversed(), truncated: false },
        {
          files: files.map((file, index) =>
            index === 19 ? { ...file, state: "dismissed" as const } : file,
          ),
          truncated: false,
        },
        { files, truncated: true },
      ]) {
        result = changed;
        const page = (yield* invoke(
          provider,
          "filesViewed",
          { ...REF, cursor: first.nextCursor },
          makeContext(),
        )) as PrsFilesViewedResult;
        expect(page.snapshot).not.toBe(first.snapshot);
      }
    }),
  );

  it.effect("a refresh can invalidate just viewed state through the native service", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const provider = createPrsApiProvider(
        makeDeps({
          invalidate: (input) => {
            calls.push(input);
            return Effect.void;
          },
        }),
      );
      yield* invoke(
        provider,
        "invalidate",
        { reference: REF, filesViewedOnly: true },
        makeContext(),
      );
      expect(calls).toEqual([
        {
          reference: { projectId: PROJECT_ID, repository: REF.repository, number: REF.number },
          filesViewedOnly: true,
        },
      ]);
    }),
  );

  it.effect("projects native additions in other PR reads without dropping SDK data", () =>
    Effect.gen(function* () {
      const nativeList = {
        ...listResult,
        nativeOnly: true,
        providers: listResult.providers.map((provider) => ({ ...provider, nativeOnly: true })),
        entries: [
          {
            ...listEntry,
            nativeOnly: "x".repeat(200_000),
            author: { ...listEntry.author, nativeId: 123 },
          },
        ],
        viewers: { "github.com": "octocat" },
        nextCursors: { "github.com": "next-page" },
      };
      const nativeActivity = {
        ...activity,
        nativeOnly: true,
        comments: activity.comments.map((comment) => ({ ...comment, nativeOnly: true })),
        commits: activity.commits.map((commit) => ({ ...commit, nativeOnly: true })),
      };
      const nativeStack = {
        id: "stack",
        number: 1,
        url: "https://github.com/owner/repo/stack/1",
        base: "main",
        nativeOnly: true,
        layers: [{ number: 42, headBranch: "feature", state: "open" as const, nativeOnly: true }],
      };
      const nativeThreadComments = {
        comments: [
          {
            id: "tc1",
            author: detail.author,
            body: "A reply",
            createdAt: NOW,
            url: null,
            nativeOnly: true,
          },
        ],
        nextCursor: "next-comments",
        nativeOnly: true,
      };
      const nativeReviewerCandidates = {
        candidates: [
          {
            ...detail.author,
            id: "octocat",
            kind: "user" as const,
            isRequested: false,
            nativeOnly: true,
          },
        ],
        truncated: false,
        nativeOnly: true,
      };
      const nativeLabelCandidates = {
        candidates: [
          { name: "bug", color: "abc123", description: null, isApplied: false, nativeOnly: true },
        ],
        truncated: false,
        nativeOnly: true,
      };
      const provider = createPrsApiProvider(
        makeDeps(
          {
            list: () => Effect.succeed(nativeList),
            summary: () => Effect.succeed({ ...detail, nativeOnly: true }),
            activity: () => Effect.succeed(nativeActivity),
            stack: () => Effect.succeed(nativeStack),
            threadComments: () => Effect.succeed(nativeThreadComments),
            reviewerCandidates: () => Effect.succeed(nativeReviewerCandidates),
            labelCandidates: () => Effect.succeed(nativeLabelCandidates),
          },
          {
            registry: fromProviders([
              githubProviderApi(
                {},
                {
                  getChangeRequestStack: () => Effect.succeed(nativeStack),
                },
              ),
            ]),
          },
        ),
      );
      const ajv = new Ajv({ strict: true, addUsedSchema: false });
      for (const method of [
        "list",
        "summary",
        "activity",
        "stack",
        "threadComments",
        "reviewerCandidates",
        "labelCandidates",
      ]) {
        const result = yield* invoke(
          provider,
          method,
          method === "list"
            ? { state: "open" }
            : method === "threadComments"
              ? { ...REF, threadId: "review-thread", cursor: "comments" }
              : REF,
          makeContext(),
        );
        const validate = ajv.compile(
          PRS_READ_API.methods!.find((definition) => definition.name === method)!.outputSchema,
        );
        expect(
          validate(result),
          `${method}: ${validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("\n")}`,
        ).toBe(true);
        expect(result).not.toHaveProperty("nativeOnly");
        if (method === "list")
          expect(result).toMatchObject({
            viewers: nativeList.viewers,
            nextCursors: nativeList.nextCursors,
            truncated: false,
          });
        if (method === "activity")
          expect(result).toMatchObject({ comments: activity.comments, commits: activity.commits });
      }
      expect(nativeList.entries[0]!.nativeOnly).toHaveLength(200_000);
    }),
  );

  it.effect("denies each operation by name without the read scope", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({}));
      const context = makeContext();
      for (const [method, input] of [
        ["list", { state: "open" }],
        ["detail", REF],
        ["activity", REF],
        ["getCapabilities", {}],
      ] as const) {
        const error = yield* invokeError(provider, method, input, context, []);
        expect(error.operation).toBe(`prs.${method}`);
      }
    }),
  );

  it.effect("denies a principal from another environment", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({}));
      const context = makeContext();
      const wrongEnvironment = {
        ...meta(provider),
        principal: {
          kind: "environment-session" as const,
          id: "session",
          environmentId: "other-env",
          scopes: [AuthOrchestrationReadScope],
        },
      };
      const error = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            provider.invoke("list", { state: "open" }, context, signal, wrongEnvironment),
          ),
        catch: (cause) => new InvokeRejection({ cause }),
      }).pipe(
        Effect.flip,
        Effect.map((rejection) => {
          if (!isOperationError(rejection.cause)) {
            throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
          }
          return rejection.cause;
        }),
      );
      expect(error.operation).toBe("prs.list");
    }),
  );

  it.effect("rejects invalid input by operation name", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({}));
      const error = yield* invokeError(provider, "list", { state: "bogus" }, makeContext());
      expect(error.operation).toBe("prs.list");
    }),
  );

  it.effect("getCapabilities reports a hostless project honestly", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps(
          { list: () => Effect.succeed({ ...listResult, providers: [], entries: [] }) },
          { shell: projectShell(null), registry: fromProviders([]) },
        ),
      );
      const capabilities = (yield* invoke(provider, "getCapabilities", {}, makeContext())) as {
        hosted: boolean;
        reason: string | null;
        detail: string | null;
        providers: readonly unknown[];
        operations: Record<string, boolean>;
      };
      expect(capabilities.hosted).toBe(false);
      expect(capabilities.reason).toBe("provider-unsupported");
      expect(capabilities.providers).toEqual([]);
      expect(capabilities.operations["prs.list"]).toBe(false);
      expect(capabilities.operations["prs.listStats"]).toBe(false);
      expect(capabilities.operations["prs.detail"]).toBe(false);
      expect(capabilities.operations["prs.streamDiff"]).toBe(false);
      // Environment-local operations do not need a host.
      expect(capabilities.operations["prs.linkedThreads"]).toBe(true);
      expect(capabilities.operations["prs.invalidate"]).toBe(true);
      expect(capabilities.operations["prs.subscribeRefreshes"]).toBe(true);
    }),
  );

  it.effect("getCapabilities keeps the stable reason when the host is unreachable", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          list: () =>
            Effect.fail(
              new PullRequestUnavailableError({ reason: "cli-missing", provider: "github" }),
            ),
        }),
      );
      const capabilities = (yield* invoke(provider, "getCapabilities", {}, makeContext())) as {
        hosted: boolean;
        reason: string | null;
        detail: string | null;
        operations: Record<string, boolean>;
      };
      // The host is declared — the project's provider exists — while the
      // credential/tool probe reports the stable reason it cannot run.
      expect(capabilities.hosted).toBe(true);
      expect(capabilities.reason).toBe("cli-missing");
      expect(capabilities.detail).toContain("GitHub CLI");
      expect(capabilities.operations["prs.list"]).toBe(true);
    }),
  );

  it.effect("getCapabilities derives operation support from the configured provider api", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({ list: () => Effect.succeed(listResult) }));
      const capabilities = (yield* invoke(provider, "getCapabilities", {}, makeContext())) as {
        hosted: boolean;
        reason: string | null;
        operations: Record<string, boolean>;
      };
      expect(capabilities.hosted).toBe(true);
      expect(capabilities.reason).toBeNull();
      expect(capabilities.operations["prs.list"]).toBe(true);
      expect(capabilities.operations["prs.listStats"]).toBe(true);
      expect(capabilities.operations["prs.detail"]).toBe(true);
      expect(capabilities.operations["prs.threadComments"]).toBe(true);
      expect(capabilities.operations["prs.stack"]).toBe(true);
      expect(capabilities.operations["prs.reviewerCandidates"]).toBe(true);
      expect(capabilities.operations["prs.labelCandidates"]).toBe(true);
      expect(capabilities.operations["prs.streamDiff"]).toBe(true);
      expect(capabilities.operations["prs.streamDiffFileContents"]).toBe(true);
    }),
  );

  it.effect("a provider without optional methods reports those operations unsupported", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps(
          { list: () => Effect.succeed(listResult) },
          {
            registry: fromProviders([
              githubProviderApi(
                { diff: false, reviewers: { request: true, listCandidates: false } },
                {
                  getReviewThreadComments: undefined,
                  getChangeRequestStack: undefined,
                  getDiffFileContents: undefined,
                  listChangeRequestStats: undefined,
                  listLabelCandidates: undefined,
                },
              ),
            ]),
          },
        ),
      );
      const capabilities = (yield* invoke(provider, "getCapabilities", {}, makeContext())) as {
        operations: Record<string, boolean>;
      };
      expect(capabilities.operations["prs.list"]).toBe(true);
      expect(capabilities.operations["prs.listStats"]).toBe(false);
      expect(capabilities.operations["prs.threadComments"]).toBe(false);
      expect(capabilities.operations["prs.stack"]).toBe(false);
      expect(capabilities.operations["prs.reviewerCandidates"]).toBe(false);
      expect(capabilities.operations["prs.labelCandidates"]).toBe(false);
      expect(capabilities.operations["prs.streamDiff"]).toBe(false);
      expect(capabilities.operations["prs.streamDiffFileContents"]).toBe(false);
    }),
  );

  it.effect("detail caps an oversized body and flags it", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          detail: () => Effect.succeed({ ...detail, body: "x".repeat(32 * 1024) }),
        }),
      );
      const got = (yield* invoke(provider, "detail", REF, makeContext())) as {
        body: string;
        bodyTruncated?: boolean;
      };
      expect(got.bodyTruncated).toBe(true);
      expect(got.body.length).toBe(16_384);
    }),
  );

  it.effect("detail carries the scoped project's merge-method setting", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const provider = createPrsApiProvider({
        ...makeDeps({ detail: () => Effect.succeed(detail) }),
        projectMergeMethod: (projectId) => {
          asked.push(projectId);
          return Effect.succeed("squash");
        },
      });
      const got = (yield* invoke(provider, "detail", REF, makeContext())) as {
        preferredMergeMethod?: string;
      };
      expect(got.preferredMergeMethod).toBe("squash");
      expect(asked).toEqual([PROJECT_ID]);

      const unset = createPrsApiProvider({
        ...makeDeps({ detail: () => Effect.succeed(detail) }),
        projectMergeMethod: () => Effect.succeed(null),
      });
      const plain = (yield* invoke(unset, "detail", REF, makeContext())) as object;
      expect("preferredMergeMethod" in plain).toBe(false);
    }),
  );

  it.effect("activity truncates a long conversation with honest flags", () =>
    Effect.gen(function* () {
      const many = {
        ...activity,
        comments: Array.from({ length: 150 }, (_, index) => ({
          id: `c${index}`,
          kind: "issue-comment" as const,
          author: null,
          body: `comment ${index}`,
          createdAt: NOW,
          url: null,
          path: null,
          reviewState: null,
        })),
        commentCount: 150,
      } satisfies NativePullRequestActivity;
      const provider = createPrsApiProvider(makeDeps({ activity: () => Effect.succeed(many) }));
      const got = (yield* invoke(provider, "activity", REF, makeContext())) as {
        comments: readonly unknown[];
        commentsTruncated: boolean;
        truncated: boolean;
      };
      expect(got.comments).toHaveLength(100);
      expect(got.commentsTruncated).toBe(true);
      expect(got.truncated).toBe(true);
    }),
  );

  it.effect("threadComments, stack, candidates, and invalidate round-trip", () =>
    Effect.gen(function* () {
      const calls: { method: string; input: unknown }[] = [];
      const provider = createPrsApiProvider(
        makeDeps({
          threadComments: (input) => {
            calls.push({ method: "threadComments", input });
            return Effect.succeed({
              comments: [
                {
                  id: "t1",
                  author: null,
                  body: "thread reply",
                  createdAt: NOW,
                  url: null,
                },
              ],
              nextCursor: null,
            });
          },
          stack: () => Effect.succeed(null),
          reviewerCandidates: () =>
            Effect.succeed({
              candidates: [
                {
                  login: "hubot",
                  name: null,
                  avatarUrl: null,
                  id: "hubot",
                  kind: "user" as const,
                  isRequested: false,
                },
              ],
              truncated: false,
            }),
          labelCandidates: () =>
            Effect.succeed({
              candidates: [{ name: "bug", color: "ff0000", description: null, isApplied: false }],
              truncated: false,
            }),
          invalidate: (input) => {
            calls.push({ method: "invalidate", input });
            return Effect.void;
          },
        }),
      );
      const context = makeContext();
      const comments = (yield* invoke(
        provider,
        "threadComments",
        { ...REF, threadId: "thread-1", cursor: "c0" },
        context,
      )) as { comments: readonly { body: string }[] };
      expect(comments.comments[0]!.body).toBe("thread reply");
      expect(calls[0]!.input).toMatchObject({
        projectId: PROJECT_ID,
        threadId: "thread-1",
        cursor: "c0",
      });

      expect(yield* invoke(provider, "stack", REF, context)).toBeNull();
      const reviewers = (yield* invoke(provider, "reviewerCandidates", REF, context)) as {
        candidates: readonly { login: string }[];
      };
      expect(reviewers.candidates[0]!.login).toBe("hubot");
      const labels = (yield* invoke(provider, "labelCandidates", REF, context)) as {
        candidates: readonly { name: string }[];
      };
      expect(labels.candidates[0]!.name).toBe("bug");

      yield* invoke(provider, "invalidate", {}, context);
      const invalidated = calls.find((call) => call.method === "invalidate");
      expect(invalidated!.input).toEqual({});
    }),
  );

  it.effect("streamDiff frames whole slices and verifies the delivered sha256", () =>
    Effect.gen(function* () {
      const first = "diff --git a/a.txt b/a.txt\n+one\n";
      const second = "diff --git a/b.txt b/b.txt\n+two\n";
      const slices: Record<string, NativePullRequestDiffResult> = {
        start: { patch: first, truncated: false, nextCursor: "c1" },
        c1: { patch: second, truncated: false, nextCursor: null },
      };
      const diffCalls: unknown[] = [];
      const provider = createPrsApiProvider(
        makeDeps({
          diff: (input) => {
            diffCalls.push(input);
            const slice = slices[input.cursor ?? "start"];
            return slice === undefined
              ? Effect.die(`unexpected cursor ${String(input.cursor)}`)
              : Effect.succeed(slice);
          },
        }),
      );
      const events = yield* collectStream(provider, "streamDiff", REF, makeContext());
      expect(diffCalls).toHaveLength(2);

      const manifest = events[0]!;
      expect(manifest.type).toBe("snapshot");
      const manifestValue = manifest.value as Extract<PrsDiffStreamEvent, { kind: "manifest" }>;
      expect(manifestValue.kind).toBe("manifest");
      expect(manifestValue.chunkCount).toBe(1);
      expect(manifestValue.truncated).toBe(false);
      expect(manifestValue.nextCursor).toBeNull();
      expect(manifestValue.diffHash).toBe(
        NodeCrypto.createHash("sha256")
          .update(first + second, "utf8")
          .digest("hex"),
      );

      const chunk = events[1]!.value as Extract<PrsDiffStreamEvent, { kind: "chunk" }>;
      expect(chunk.data).toBe(first + second);
      const complete = events[2]!.value as Extract<PrsDiffStreamEvent, { kind: "complete" }>;
      expect(complete.payloadSha256).toBe(manifestValue.diffHash);
      expect(events).toHaveLength(3);
    }),
  );

  it.effect("streamDiffFileContents frames both sides with verifiable hashes", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          diffFileContents: () =>
            Effect.succeed({ oldContents: "before\n", newContents: "after\n" }),
        }),
      );
      const events = yield* collectStream(
        provider,
        "streamDiffFileContents",
        { ...REF, changeType: "change", oldPath: "a.txt", newPath: "a.txt" },
        makeContext(),
      );
      const manifest = events[0]!.value as {
        kind: string;
        oldChunkCount: number;
        newChunkCount: number;
      };
      expect(manifest.kind).toBe("manifest");
      const chunks = events
        .slice(1, -1)
        .map((event) => event.value as { kind: string; side: string; data: string });
      expect(chunks.map((chunk) => chunk.side)).toEqual(["old", "new"]);
      expect(chunks.map((chunk) => chunk.data)).toEqual(["before\n", "after\n"]);
      const complete = events.at(-1)!.value as {
        kind: string;
        oldSha256: string;
        newSha256: string;
      };
      expect(complete.oldSha256).toBe(
        NodeCrypto.createHash("sha256").update("before\n", "utf8").digest("hex"),
      );
      expect(complete.newSha256).toBe(
        NodeCrypto.createHash("sha256").update("after\n", "utf8").digest("hex"),
      );
    }),
  );

  it.effect("denies streams by name without the read scope", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({}));
      const error = yield* collectStreamError(provider, "streamDiff", REF, makeContext(), []);
      expect(error.operation).toBe("prs.streamDiff");
      const resumed = yield* collectStreamError(
        provider,
        "streamDiff",
        REF,
        makeContext(),
        READ_ONLY,
        "cursor",
      );
      expect(resumed.operation).toBe("prs.streamDiff");
      const unknown = yield* collectStreamError(provider, "nope", {}, makeContext());
      expect(unknown.operation).toBe("prs.nope");
    }),
  );

  it.effect("subscribeRefreshes forwards native invalidations as refreshed events", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({ subscribeRefreshes: Stream.make(4, 5, 6) }));
      const events = yield* collectStream(provider, "subscribeRefreshes", {}, makeContext());
      expect(events.map((event) => event.value as { kind: string; revision: number })).toEqual([
        { kind: "refreshed", revision: 4 },
        { kind: "refreshed", revision: 5 },
        { kind: "refreshed", revision: 6 },
      ]);
    }),
  );

  it.effect("subscribeRefreshes closes with a named reason when the native stream fails", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          // The service member is infallible (`SubscriptionRef.changes`); a
          // failing stream exercises the adapter's defensive closed-frame.
          subscribeRefreshes: Stream.fail(new Error("boom")).pipe(Stream.orDie),
        }),
      );
      const events = yield* collectStream(provider, "subscribeRefreshes", {}, makeContext());
      expect(events).toHaveLength(1);
      expect(events[0]!.value).toEqual({ kind: "closed", reason: "refresh-error" });
    }),
  );

  it.effect("linkedThreads answers seeded links and only the granted project's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at, deleted_at
        ) VALUES
          ('thread-1', 'project', 'Linked thread', '{"instanceId":"codex","model":"gpt-5.4"}',
           ${NOW}, ${NOW}, NULL),
          ('thread-2', 'other', 'Foreign thread', '{"instanceId":"codex","model":"gpt-5.4"}',
           ${NOW}, ${NOW}, NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at
        ) VALUES
          ('thread-1', 'github.com', 'owner/repo', 42,
           'https://github.com/owner/repo/pull/42', 'linked', ${NOW}),
          ('thread-2', 'github.com', 'owner/repo', 42,
           'https://github.com/owner/repo/pull/42', 'linked', ${NOW})
      `;
      const provider = createPrsApiProvider(makeDeps({}, { sql }));
      const context = makeContext();
      const linked = (yield* invoke(
        provider,
        "linkedThreads",
        { host: "GitHub.com", repository: "Owner/Repo", number: 42 },
        context,
      )) as { threads: readonly { id: string; projectId: string }[]; truncated: boolean };
      // Same host/repository/number — but the other project's thread is
      // never disclosed.
      expect(linked.truncated).toBe(false);
      expect(linked.threads).toHaveLength(1);
      expect(linked.threads[0]!.id).toBe("thread-1");
      expect(linked.threads[0]!.projectId).toBe("project");

      // A ref naming any other repository or host is refused before the
      // link key is even derived.
      const foreign = yield* invokeError(
        provider,
        "linkedThreads",
        { repository: "other/repo", number: 7 },
        context,
      );
      expect(foreign.operation).toBe("prs.linkedThreads");
      const foreignHost = yield* invokeError(
        provider,
        "linkedThreads",
        { host: "ghe.example.com", repository: "owner/repo", number: 42 },
        context,
      );
      expect(foreignHost.operation).toBe("prs.linkedThreads");

      // A local-only granted project has no server-side identity to bind:
      // the caller's own host/repository form the key, and rows are still
      // restricted to its own threads.
      const local = createPrsApiProvider(
        makeDeps({}, { shell: projectShell(null), registry: fromProviders([]), sql }),
      );
      const localLinked = (yield* invoke(
        local,
        "linkedThreads",
        { host: "github.com", repository: "owner/repo", number: 42 },
        context,
      )) as { threads: readonly { id: string }[] };
      expect(localLinked.threads.map((thread) => thread.id)).toEqual(["thread-1"]);

      // Without a host or an identity there is no host-level key — empty,
      // not an error.
      const unhosted = (yield* invoke(
        local,
        "linkedThreads",
        { repository: "owner/repo", number: 42 },
        context,
      )) as { threads: readonly unknown[]; truncated: boolean };
      expect(unhosted.threads).toEqual([]);
      expect(unhosted.truncated).toBe(false);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("denies references naming another repository or host before the native service", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const record = (method: string) => (input: unknown) => {
        calls.push({ method, input });
        return Effect.die("must not reach the native service");
      };
      const provider = createPrsApiProvider(
        makeDeps({
          summary: record("summary"),
          detail: record("detail"),
          activity: record("activity"),
          threadComments: record("threadComments"),
          stack: record("stack"),
          diff: record("diff"),
          diffFileContents: record("diffFileContents"),
          reviewerCandidates: record("reviewerCandidates"),
          labelCandidates: record("labelCandidates"),
          invalidate: record("invalidate"),
          listStats: record("listStats"),
        }),
      );
      const context = makeContext();

      // Another repository on the same host.
      const otherRepo = { repository: "other/repo", number: 7 };
      for (const [method, input] of [
        ["summary", otherRepo],
        ["detail", otherRepo],
        ["activity", otherRepo],
        ["threadComments", { ...otherRepo, threadId: "t", cursor: "c" }],
        ["stack", otherRepo],
        ["reviewerCandidates", otherRepo],
        ["labelCandidates", otherRepo],
        ["listStats", { refs: [otherRepo] }],
        ["invalidate", { reference: otherRepo }],
      ] as const) {
        const error = yield* invokeError(provider, method, input, context);
        expect(error.operation).toBe(`prs.${method}`);
      }

      // The granted repository on another configured host.
      const otherHost = { host: "ghe.example.com", repository: "owner/repo", number: 42 };
      for (const method of ["detail", "stack", "reviewerCandidates"] as const) {
        const error = yield* invokeError(provider, method, otherHost, context);
        expect(error.operation).toBe(`prs.${method}`);
      }

      // The streams take the same boundary.
      const diffError = yield* collectStreamError(provider, "streamDiff", otherRepo, context);
      expect(diffError.operation).toBe("prs.streamDiff");
      const contentsError = yield* collectStreamError(
        provider,
        "streamDiffFileContents",
        { ...otherRepo, changeType: "change", oldPath: "a", newPath: "a" },
        context,
      );
      expect(contentsError.operation).toBe("prs.streamDiffFileContents");

      // list's optional host filter may only name this project's own host.
      const listForeign = yield* invokeError(
        provider,
        "list",
        { state: "open", host: "ghe.example.com" },
        context,
      );
      expect(listForeign.operation).toBe("prs.list");

      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("a local-only granted project fails host-bound operations by name", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const provider = createPrsApiProvider(
        makeDeps(
          {
            detail: (input) => {
              calls.push(input);
              return Effect.succeed(detail);
            },
            list: (input) => {
              calls.push(input);
              return Effect.succeed(listResult);
            },
          },
          { shell: projectShell(null), registry: fromProviders([]) },
        ),
      );
      const context = makeContext();
      for (const [method, input] of [
        ["list", { state: "open" }],
        ["detail", REF],
        ["summary", REF],
        ["activity", REF],
        ["stack", REF],
      ] as const) {
        const error = yield* invokeError(provider, method, input, context);
        expect(error.operation).toBe(`prs.${method}`);
        expect(error.message).toContain("provider-unsupported");
      }
      const diffError = yield* collectStreamError(provider, "streamDiff", REF, context);
      expect(diffError.operation).toBe("prs.streamDiff");
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("listStats and stack fail by name when the provider lacks the optional api", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps(
          {
            listStats: () => Effect.die("must not reach the service"),
            stack: () => Effect.die("must not reach the service"),
          },
          {
            registry: fromProviders([
              githubProviderApi(
                {},
                {
                  listChangeRequestStats: undefined,
                  getChangeRequestStack: undefined,
                },
              ),
            ]),
          },
        ),
      );
      const context = makeContext();
      const stats = yield* invokeError(provider, "listStats", { refs: [REF] }, context);
      expect(stats.operation).toBe("prs.listStats");
      expect(stats.message).toContain("listStats");
      const stack = yield* invokeError(provider, "stack", REF, context);
      expect(stack.operation).toBe("prs.stack");
      expect(stack.message).toContain("stack");
    }),
  );

  it.effect("listStats reads stats strictly through the bound provider", () =>
    Effect.gen(function* () {
      const calls: { cwd: string; host: string; changeRequests: readonly unknown[] }[] = [];
      const provider = createPrsApiProvider(
        makeDeps(
          {
            // The strict path never reaches the service — the service would
            // erase a provider failure into an empty page.
            listStats: () => Effect.die("must not reach the service"),
          },
          {
            registry: fromProviders([
              githubProviderApi(
                {},
                {
                  listChangeRequestStats: (input) => {
                    calls.push(input);
                    return Effect.succeed([
                      { repository: "owner/repo", number: 42, additions: 10, deletions: 2 },
                      // A row the caller never asked for is filtered out.
                      { repository: "owner/repo", number: 99, additions: 1, deletions: 1 },
                    ]);
                  },
                },
              ),
            ]),
          },
        ),
      );
      const result = (yield* invoke(provider, "listStats", { refs: [REF] }, makeContext())) as {
        stats: readonly {
          projectId: string;
          repository: string;
          number: number;
          additions: number;
          deletions: number;
        }[];
      };
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cwd).toBe(WORKSPACE_ROOT);
      expect(calls[0]!.host).toBe("github.com");
      expect(calls[0]!.changeRequests).toEqual([{ repository: "owner/repo", number: 42 }]);
      expect(result.stats).toEqual([
        {
          projectId: "project",
          repository: "owner/repo",
          number: 42,
          additions: 10,
          deletions: 2,
        },
      ]);
    }),
  );

  it.effect(
    "listStats fails by name with the stable reason when the provider is unusable (real service)",
    () =>
      Effect.gen(function* () {
        /**
         * A provider whose stats call fails with
         * an unusable-host reason must NOT produce `{stats: []}` — the
         * native service's best-effort page semantics — but fail
         * `prs.listStats` with cli-unauthenticated / cli-missing named.
         */
        for (const [reason, stable] of [
          ["unauthenticated", "cli-unauthenticated"],
          ["missing-tool", "cli-missing"],
        ] as const) {
          const attempts: unknown[] = [];
          const api = githubProviderApi(
            {},
            {
              getViewer: () => Effect.succeed("bilal"),
              listChangeRequestStats: (input) => {
                attempts.push(input);
                return Effect.fail(
                  new PullRequestProviderError({
                    provider: "github",
                    operation: "listChangeRequestStats",
                    reason,
                    detail:
                      reason === "unauthenticated"
                        ? "HTTP 401: Bad credentials"
                        : "gh: command not found",
                  }),
                );
              },
            },
          );
          // Built into the test scope: the viewed-files store owns a database that
          // `Effect.provide` would close as soon as the service was returned.
          const service = yield* Layer.build(
            Layer.mergeAll(
              Layer.succeed(PullRequestProviderRegistry, fromProviders([api])),
              Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
                resolveLink: () => undefined,
                resolveHandle: () => Effect.die("Unexpected provider refinement"),
              }),
              Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
                getProjectShells: (projectIds) =>
                  Effect.succeed(
                    [projectShell()].filter((project) => projectIds?.includes(project.id) ?? true),
                  ),
                getProjectShellById: (projectId) =>
                  Effect.succeed(
                    Option.fromNullishOr(
                      [projectShell()].find((project) => project.id === projectId),
                    ),
                  ),
              }),
              SourceControlRateLimit.layer,
              PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
              Layer.effect(
                PullRequestReadCache.PullRequestReadCache,
                PullRequestReadCache.make,
              ).pipe(
                Layer.provide(Persistence.layerKvs),
                Layer.provide(KeyValueStore.layerMemory),
                Layer.provide(NodeServices.layer),
              ),
            ),
          ).pipe(
            Effect.flatMap((context) =>
              PullRequestService.make.pipe(Effect.provideContext(context)),
            ),
          );
          const provider = createPrsApiProvider({
            ...makeDeps({}, { registry: fromProviders([api]) }),
            pullRequests: service,
          });
          const error = yield* invokeError(provider, "listStats", { refs: [REF] }, makeContext());
          expect(error.operation).toBe("prs.listStats");
          expect(error.message).toContain(stable);
          // One real failing provider attempt — never an empty success.
          expect(attempts).toHaveLength(1);
        }
      }),
  );

  it.effect("threadComments discloses truncation and drops an unsafe continuation", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          threadComments: () =>
            Effect.succeed({
              comments: Array.from({ length: 140 }, (_, index) => ({
                id: `t${index}`,
                author: null,
                body: `reply ${index}`,
                createdAt: NOW,
                url: null,
              })),
              nextCursor: "page-2",
            }),
        }),
      );
      const got = (yield* invoke(
        provider,
        "threadComments",
        { ...REF, threadId: "thread-1", cursor: "c0" },
        makeContext(),
      )) as {
        comments: readonly unknown[];
        nextCursor: string | null;
        truncated: boolean;
      };
      expect(got.comments).toHaveLength(100);
      expect(got.truncated).toBe(true);
      // "page-2" resumes past comments the caller never saw — it must not
      // be handed out on a cut page.
      expect(got.nextCursor).toBeNull();
    }),
  );

  it.effect("oversized singletons terminate instead of stalling the trim loop", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          activity: () =>
            Effect.succeed({
              ...activity,
              // One commit whose headline alone exceeds the whole envelope:
              // the old `max(1, floor(n/2))` loop never progressed here.
              commits: [
                {
                  oid: "abc123",
                  messageHeadline: "x".repeat(64 * 1024),
                  committedDate: NOW,
                },
              ],
            }),
        }),
      );
      const got = (yield* invoke(provider, "activity", REF, makeContext())) as {
        commits: readonly unknown[];
        truncated: boolean;
      };
      expect(got.commits).toHaveLength(0);
      expect(got.truncated).toBe(true);
    }),
  );

  it.effect("the least-informative collections empty before comments do", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          activity: () =>
            Effect.succeed({
              ...activity,
              reviewers: Array.from({ length: 30 }, (_, index) => ({
                login: `r${index}`,
                name: null,
                avatarUrl: null,
              })),
              reactions: Array.from({ length: 30 }, (_, index) => ({
                content: "heart" as const,
                count: 1,
                actors: [`u${index}`],
                viewerHasReacted: false,
              })),
              commits: Array.from({ length: 30 }, (_, index) => ({
                oid: `oid${index}`,
                messageHeadline: `commit ${index} ${"y".repeat(4096)}`,
                committedDate: NOW,
              })),
            }),
        }),
      );
      const got = (yield* invoke(provider, "activity", REF, makeContext())) as {
        reviewers?: readonly unknown[];
        reactions?: readonly unknown[];
        commits: readonly unknown[];
        comments: readonly unknown[];
        truncated: boolean;
      };
      expect(got.truncated).toBe(true);
      // Reactions/reviewers go first; the single comment survives.
      expect(got.reactions ?? []).toHaveLength(0);
      expect(got.reviewers ?? []).toHaveLength(0);
      expect(got.comments).toHaveLength(1);
    }),
  );

  it.effect("an irreducible result fails the operation by name rather than hanging", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          // No collection remains once detail's own fields exceed the
          // envelope — the bound cannot be satisfied, so the operation
          // fails by name instead of looping or returning past the limit.
          detail: () =>
            Effect.succeed({
              ...detail,
              checks: Array.from({ length: 300 }, (_, index) => ({
                name: `check ${index} ${"z".repeat(512)}`,
                status: "success" as const,
                description: null,
                url: null,
              })),
            }),
        }),
      );
      const error = yield* invokeError(provider, "detail", REF, makeContext());
      expect(error.operation).toBe("prs.detail");
      expect(error.message).toContain("byte limit");
    }),
  );

  it.effect("explicitly-undefined optional members are normalized, not rejected", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(
        makeDeps({
          detail: () => Effect.succeed({ ...detail, viewer: undefined }),
        }),
      );
      const got = (yield* invoke(provider, "detail", REF, makeContext())) as Record<
        string,
        unknown
      >;
      expect(got.title).toBe("Ship it");
      expect("viewer" in got).toBe(false);
    }),
  );

  it.effect("binds every reference to the granted project through the real service", () =>
    Effect.gen(function* () {
      const calls: {
        readonly cwd: string;
        readonly repository: string;
        readonly number: number;
      }[] = [];
      const projectA = projectShell(GITHUB_IDENTITY);
      const projectB = projectShell(
        {
          canonicalKey: "github.com/other/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/other/repo.git",
          },
          provider: "github",
          displayName: "other/repo",
        },
        "other",
      );
      const api = githubProviderApi(
        {},
        {
          getViewer: () => Effect.succeed("bilal"),
          getChangeRequest: (input) => {
            calls.push(input);
            return Effect.succeed({
              number: input.number,
              title: `Change request ${input.number}`,
              url: `https://github.com/owner/repo/pull/${input.number}`,
              author: { login: "octocat", name: null, avatarUrl: null },
              headBranch: "feature",
              baseBranch: "main",
              state: "open" as const,
              isDraft: false,
              mergeability: "mergeable" as const,
              additions: 1,
              deletions: 0,
              createdAt: NOW,
              updatedAt: NOW,
              reviewRequestLogins: [],
              labels: [],
              body: "the body",
              changedFiles: 1,
              mergedAt: null,
              closedAt: null,
              reviewers: [],
              checks: [],
              mergeCapabilities: { merge: true, squash: true, rebase: true },
              viewerPermissions: {
                actions: ["merge" as const],
                comment: true,
                resolve: true,
                verdicts: ["approve" as const],
                requestReviewers: true,
              },
            });
          },
          getDiff: () =>
            Effect.succeed({
              patch: "diff --git a/a b/a\n+x\n",
              truncated: false,
              nextCursor: null,
            }),
          getDiffFileContents: () => Effect.succeed({ oldContents: "a\n", newContents: "b\n" }),
        },
      );
      // Built into the test scope: the viewed-files store owns a database that
      // `Effect.provide` would close as soon as the service was returned.
      const service = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(PullRequestProviderRegistry, fromProviders([api])),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
            resolveHandle: () => Effect.die("Unexpected provider refinement"),
          }),
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getProjectShells: (projectIds) =>
              Effect.succeed(
                [projectA, projectB].filter((project) => projectIds?.includes(project.id) ?? true),
              ),
            getProjectShellById: (projectId) =>
              Effect.succeed(
                Option.fromNullishOr(
                  [projectA, projectB].find((project) => project.id === projectId),
                ),
              ),
          }),
          SourceControlRateLimit.layer,
          PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
          Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
            Layer.provide(Persistence.layerKvs),
            Layer.provide(KeyValueStore.layerMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ).pipe(
        Effect.flatMap((context) => PullRequestService.make.pipe(Effect.provideContext(context))),
      );
      const provider = createPrsApiProvider({
        ...makeDeps({}, { shells: [projectA, projectB], registry: fromProviders([api]) }),
        pullRequests: service,
      });
      const context = makeContext();

      // The project's own repository routes to its own checkout.
      const own = (yield* invoke(provider, "detail", REF, context)) as { number: number };
      expect(own.number).toBe(42);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cwd).toBe(WORKSPACE_ROOT);
      expect(calls[0]!.repository).toBe("owner/repo");

      // Another repository on the same host — which the unguarded host path
      // would have resolved to project B's checkout — is refused before the
      // service sees it.
      const otherRepo = yield* invokeError(
        provider,
        "detail",
        { repository: "other/repo", number: 7 },
        context,
      );
      expect(otherRepo.operation).toBe("prs.detail");

      // The granted repository named under another host is refused too.
      const otherHost = yield* invokeError(
        provider,
        "detail",
        { host: "ghe.example.com", repository: "owner/repo", number: 42 },
        context,
      );
      expect(otherHost.operation).toBe("prs.detail");

      // Reference-taking streams hold the same boundary.
      const streamDenied = yield* collectStreamError(
        provider,
        "streamDiff",
        { repository: "other/repo", number: 7 },
        context,
      );
      expect(streamDenied.operation).toBe("prs.streamDiff");
      expect(calls).toHaveLength(1);

      // A hosted ref spelled differently still binds: case-insensitive
      // host/repository equivalence routes to the same own checkout.
      const ownAgain = (yield* invoke(
        provider,
        "detail",
        { host: "GitHub.com", repository: "Owner/Repo", number: 43 },
        context,
      )) as { number: number };
      expect(ownAgain.number).toBe(43);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.cwd).toBe(WORKSPACE_ROOT);
    }),
  );

  it.effect("a cancelled getCapabilities never fails a concurrent one for a non-repo project", () =>
    Effect.gen(function* () {
      // The real resolver over a workspace that is not a repository: `git rev-parse` fails, so
      // nothing is cached and every call is a live, shared lookup. The first one blocks, and
      // like a real `git` its interruption only completes once the process is gone (release).
      const release = yield* Deferred.make<void>();
      const unwinding = yield* Deferred.make<void>();
      let revParses = 0;
      const notARepository = {
        stdout: "",
        stderr: "fatal: not a git repository",
        code: ChildProcessSpawner.ExitCode(128),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
      const resolver = yield* Layer.build(
        Layer.effect(
          RepositoryIdentityResolver.RepositoryIdentityResolver,
          RepositoryIdentityResolver.make(),
        ).pipe(
          Layer.provide(
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: (input) => {
                if (!input.args.includes("rev-parse")) return Effect.die("unexpected git call");
                revParses++;
                if (revParses > 1) return Effect.succeed(notARepository);
                return Deferred.await(release).pipe(
                  Effect.onInterrupt(() =>
                    Deferred.succeed(unwinding, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                  Effect.as(notARepository),
                );
              },
            }),
          ),
        ),
      ).pipe(
        Effect.map((context) =>
          Context.get(context, RepositoryIdentityResolver.RepositoryIdentityResolver),
        ),
      );
      // As the real projection query does: the stored row, with its identity resolved live.
      const shell = resolver
        .resolve(WORKSPACE_ROOT)
        .pipe(Effect.map((identity) => projectShell(identity)));
      const service = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(PullRequestProviderRegistry, fromProviders([githubProviderApi()])),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
            resolveHandle: () => Effect.die("Unexpected provider refinement"),
          }),
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getProjectShells: () => shell.pipe(Effect.map((project) => [project])),
            getProjectShellById: () => shell.pipe(Effect.map(Option.some)),
          }),
          SourceControlRateLimit.layer,
          PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
          Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
            Layer.provide(Persistence.layerKvs),
            Layer.provide(KeyValueStore.layerMemory),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ).pipe(
        Effect.flatMap((context) => PullRequestService.make.pipe(Effect.provideContext(context))),
      );
      const provider = createPrsApiProvider({
        ...makeDeps({}),
        projectionSnapshotQuery: { getProjectShellById: () => shell.pipe(Effect.map(Option.some)) },
        pullRequests: service,
      });
      const context = makeContext();
      // The pack's StrictMode double mount: invoking runs synchronously up to the first wait,
      // so each caller is inside the shared lookup by the time `invoke` returns.
      const call = (controller: AbortController) =>
        Promise.resolve(
          provider.invoke("getCapabilities", {}, context, controller.signal, meta(provider)),
        );

      const cancelled = new AbortController();
      const first = call(cancelled).then(
        () => "completed",
        () => "rejected",
      );
      cancelled.abort();
      // The first caller has left: either it is unwinding the shared lookup, or it never owned
      // the lookup and has already returned.
      yield* Effect.raceFirst(
        Deferred.await(unwinding),
        Effect.promise(() => first),
      );
      const second = call(new AbortController());
      yield* Deferred.succeed(release, undefined);

      const capabilities = (yield* Effect.tryPromise({
        try: () => second,
        catch: (cause) => new InvokeRejection({ cause }),
      })) as { hosted: boolean; reason: string | null };
      expect(capabilities.hosted).toBe(false);
      expect(capabilities.reason).toBe("provider-unsupported");
      expect(yield* Effect.promise(() => first)).toBe("rejected");
    }),
  );

  it.effect("a read another caller's cancellation interrupted is read again, not failed", () =>
    Effect.gen(function* () {
      // Joining a shared lookup that another caller cancelled hands this caller that lookup's
      // interrupt, although this caller was never cancelled.
      let reads = 0;
      const provider = createPrsApiProvider(
        makeDeps({
          list: () => {
            reads++;
            return reads === 1
              ? Effect.forkDetach(Effect.never).pipe(
                  Effect.tap(Fiber.interrupt),
                  Effect.flatMap(Fiber.join),
                )
              : Effect.succeed(listResult);
          },
        }),
      );
      const capabilities = (yield* invoke(provider, "getCapabilities", {}, makeContext())) as {
        hosted: boolean;
        providers: readonly unknown[];
      };
      expect(capabilities.hosted).toBe(true);
      expect(capabilities.providers).toEqual(listResult.providers);
      expect(reads).toBe(2);
    }),
  );

  it.effect("re-checks authority after the native read", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({ list: () => Effect.succeed(listResult) }));
      let asserted = 0;
      const metadata = {
        ...meta(provider),
        assertAuthority: async () => {
          asserted += 1;
        },
      };
      yield* Effect.promise(() =>
        Promise.resolve(
          provider.invoke("list", { state: "open" }, makeContext(), signal, metadata),
        ),
      );
      expect(asserted).toBeGreaterThan(0);
    }),
  );

  it.effect("revoked authority fails the operation by name", () =>
    Effect.gen(function* () {
      const provider = createPrsApiProvider(makeDeps({ list: () => Effect.succeed(listResult) }));
      const metadata = {
        ...meta(provider),
        assertAuthority: () => Promise.reject(new Error("revoked")),
      };
      const error = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            provider.invoke("list", { state: "open" }, makeContext(), signal, metadata),
          ),
        catch: (cause) => new InvokeRejection({ cause }),
      }).pipe(Effect.flip);
      expect(isOperationError(error.cause)).toBe(true);
      if (isOperationError(error.cause)) {
        expect(error.cause.operation).toBe("prs.list");
      }
    }),
  );
});
