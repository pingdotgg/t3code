import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  ProjectId,
  PullRequestUnavailableError,
  extensionWorkspaceRevision,
  type OrchestrationProjectShell,
  type PullRequestListResult as NativePullRequestListResult,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { PullRequestProviderApi } from "../../pullRequest/PullRequestProvider.ts";
import { fromProviders } from "../../pullRequest/PullRequestProviderRegistry.ts";
import type { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { createPrsWriteApiProvider } from "./write.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const READ_AND_OPERATE = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
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
  scopes: readonly string[] = READ_AND_OPERATE,
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
  context: ViewContext = makeContext(),
  scopes: readonly string[] = READ_AND_OPERATE,
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

const REF = { repository: "owner/repo", number: 42 } as const;

const listResult = {
  viewers: {},
  providers: [],
  entries: [],
  errors: [],
  truncated: false,
  nextCursors: {},
} satisfies NativePullRequestListResult;

type WriteService = Pick<
  PullRequestService["Service"],
  | "runAction"
  | "update"
  | "comment"
  | "updateComment"
  | "submitReview"
  | "replyToThread"
  | "setThreadResolution"
  | "setReaction"
  | "requestReviewers"
  | "setLabels"
  | "list"
>;
type Deps = Parameters<typeof createPrsWriteApiProvider>[0];

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
      actions: ["merge", "close", "ready"],
      mergeMethods: ["merge", "squash"],
      updateMethods: ["merge"],
      search: true,
      reactions: true,
      review: {
        inlineComment: true,
        reply: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
      },
      reviewers: { request: true, listCandidates: true },
      edit: { changeRequest: true, comment: true },
      labels: true,
      ...overrides,
    },
    setLabels: () => Effect.die("unused"),
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
): OrchestrationProjectShell =>
  ({
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: WORKSPACE_ROOT,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) as OrchestrationProjectShell;

interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}

const makeDeps = (
  pullRequests: Partial<WriteService> = {},
  options: {
    readonly registry?: Deps["prRegistry"];
    readonly shell?: OrchestrationProjectShell | null;
  } = {},
): Deps & { readonly calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const record = <A, E>(method: string, impl: (input: never) => Effect.Effect<A, E>) =>
    ((input: unknown) => {
      calls.push({ method, input });
      return impl(input as never);
    }) as never;
  return {
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
      list: record("list", pullRequests.list ?? (() => Effect.succeed(listResult))),
      runAction: record("runAction", pullRequests.runAction ?? (() => Effect.void)),
      update: record("update", pullRequests.update ?? (() => Effect.void)),
      comment: record("comment", pullRequests.comment ?? (() => Effect.void)),
      updateComment: record("updateComment", pullRequests.updateComment ?? (() => Effect.void)),
      submitReview: record("submitReview", pullRequests.submitReview ?? (() => Effect.void)),
      replyToThread: record("replyToThread", pullRequests.replyToThread ?? (() => Effect.void)),
      setThreadResolution: record(
        "setThreadResolution",
        pullRequests.setThreadResolution ?? (() => Effect.void),
      ),
      setReaction: record("setReaction", pullRequests.setReaction ?? (() => Effect.void)),
      requestReviewers: record(
        "requestReviewers",
        pullRequests.requestReviewers ?? (() => Effect.void),
      ),
      setLabels: record("setLabels", pullRequests.setLabels ?? (() => Effect.void)),
    },
    prRegistry: options.registry ?? fromProviders([githubProviderApi()]),
    projectionSnapshotQuery: {
      getProjectShellById: () =>
        Effect.succeed(
          options.shell === null ? Option.none() : Option.some(options.shell ?? projectShell()),
        ),
    },
    calls,
  };
};

it.layer(NodeServices.layer)("t3.prs/write adapter", (it) => {
  it.effect("reports declared write support from the bound project's provider", () =>
    Effect.gen(function* () {
      const deps = makeDeps();
      const provider = createPrsWriteApiProvider(deps);
      const caps = (yield* invoke(provider, "getCapabilities", {})) as {
        hosted: boolean;
        reason: string | null;
        operations: Record<string, boolean>;
        actions: readonly string[];
        mergeMethods: readonly string[];
        updateMethods: readonly string[];
        verdicts: readonly string[];
      };
      expect(caps.hosted).toBe(true);
      expect(caps.reason).toBeNull();
      expect(caps.operations).toEqual({
        "prs.runAction": true,
        "prs.update": true,
        "prs.comment": true,
        "prs.updateComment": true,
        "prs.submitReview": true,
        "prs.replyToThread": true,
        "prs.setThreadResolution": true,
        "prs.setReaction": true,
        "prs.requestReviewers": true,
        "prs.setLabels": true,
      });
      expect(caps.actions).toEqual(["merge", "close", "ready"]);
      expect(caps.mergeMethods).toEqual(["merge", "squash"]);
      expect(caps.updateMethods).toEqual(["merge"]);
      expect(caps.verdicts).toEqual(["comment", "approve", "request-changes"]);
    }),
  );

  it.effect("reports unhosted projects and a failed host probe by name", () =>
    Effect.gen(function* () {
      const unhosted = createPrsWriteApiProvider(
        makeDeps({}, { shell: projectShell(null), registry: fromProviders([]) }),
      );
      const caps = (yield* invoke(unhosted, "getCapabilities", {})) as {
        hosted: boolean;
        reason: string | null;
        operations: Record<string, boolean>;
      };
      expect(caps.hosted).toBe(false);
      expect(caps.reason).toBe("provider-unsupported");
      expect(Object.values(caps.operations).every((v) => !v)).toBe(true);

      const probed = createPrsWriteApiProvider(
        makeDeps({
          list: () =>
            Effect.fail(
              new PullRequestUnavailableError({
                reason: "cli-unauthenticated",
                provider: "github",
              }),
            ),
        }),
      );
      const probedCaps = (yield* invoke(probed, "getCapabilities", {})) as {
        hosted: boolean;
        reason: string | null;
        detail: string | null;
      };
      expect(probedCaps.hosted).toBe(true);
      expect(probedCaps.reason).toBe("cli-unauthenticated");
      expect(probedCaps.detail).toBeTruthy();
    }),
  );

  it.effect("forwards write operations against the bound repository ref", () =>
    Effect.gen(function* () {
      const deps = makeDeps();
      const provider = createPrsWriteApiProvider(deps);
      const context = makeContext();

      yield* invoke(provider, "comment", { ...REF, body: "looks good" }, context);
      yield* invoke(provider, "runAction", { ...REF, action: "merge", mergeMethod: "squash" });
      yield* invoke(provider, "update", { ...REF, title: "new title" });
      yield* invoke(provider, "updateComment", {
        ...REF,
        commentId: "c1",
        kind: "issue-comment",
        body: "edited",
      });
      yield* invoke(provider, "submitReview", {
        ...REF,
        verdict: "approve",
        body: "",
        comments: [{ path: "a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
      });
      yield* invoke(provider, "replyToThread", { ...REF, threadId: "t1", body: "done" });
      yield* invoke(provider, "setThreadResolution", { ...REF, threadId: "t1", resolved: true });
      yield* invoke(provider, "setReaction", { ...REF, content: "thumbs-up", reacted: true });
      yield* invoke(provider, "requestReviewers", {
        ...REF,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: true,
      });
      yield* invoke(provider, "setLabels", { ...REF, labels: ["bug"], applied: true });

      const byMethod = Object.fromEntries(deps.calls.map((call) => [call.method, call.input]));
      // The bound ref is hostless: projectId + the granted project's own
      // repository selector — a plugin cannot route to another host.
      const ref = { projectId: PROJECT_ID, repository: "owner/repo", number: 42 };
      expect(byMethod["comment"]).toEqual({ ...ref, body: "looks good" });
      expect(byMethod["runAction"]).toEqual({ ...ref, action: "merge", mergeMethod: "squash" });
      expect(byMethod["update"]).toEqual({ ...ref, title: "new title" });
      expect(byMethod["updateComment"]).toEqual({
        ...ref,
        commentId: "c1",
        kind: "issue-comment",
        body: "edited",
      });
      expect(byMethod["submitReview"]).toEqual({
        ...ref,
        verdict: "approve",
        body: "",
        comments: [{ path: "a.ts", position: { kind: "added", newLine: 4 }, body: "nit" }],
      });
      expect(byMethod["replyToThread"]).toEqual({ ...ref, threadId: "t1", body: "done" });
      expect(byMethod["setThreadResolution"]).toEqual({ ...ref, threadId: "t1", resolved: true });
      expect(byMethod["setReaction"]).toEqual({
        ...ref,
        content: "thumbs-up",
        reacted: true,
      });
      expect(byMethod["requestReviewers"]).toEqual({
        ...ref,
        reviewers: [{ id: "octocat", kind: "user" }],
        requested: true,
      });
      expect(byMethod["setLabels"]).toEqual({ ...ref, labels: ["bug"], applied: true });
    }),
  );

  it.effect("refuses refs naming another repository or host", () =>
    Effect.gen(function* () {
      const deps = makeDeps();
      const provider = createPrsWriteApiProvider(deps);

      const foreignRepo = yield* invokeError(provider, "comment", {
        repository: "other/repo",
        number: 42,
        body: "hi",
      });
      expect(foreignRepo.detail).toContain("does not belong");

      const foreignHost = yield* invokeError(provider, "comment", {
        host: "gitlab.example.com",
        repository: "owner/repo",
        number: 42,
        body: "hi",
      });
      expect(foreignHost.detail).toContain("does not belong");

      expect(deps.calls).toHaveLength(0);
    }),
  );

  it.effect("names provider-unsupported when the project has no hosted repository", () =>
    Effect.gen(function* () {
      const deps = makeDeps({}, { shell: projectShell(null), registry: fromProviders([]) });
      const provider = createPrsWriteApiProvider(deps);
      const error = yield* invokeError(provider, "comment", { ...REF, body: "hi" });
      expect(error.detail).toContain("PullRequestUnavailableError");
      expect(error.detail).toContain("provider-unsupported");
      expect(deps.calls).toHaveLength(0);
    }),
  );

  it.effect("requires Operate scope for every write including getCapabilities", () =>
    Effect.gen(function* () {
      const deps = makeDeps();
      const provider = createPrsWriteApiProvider(deps);
      const denied = yield* invokeError(
        provider,
        "comment",
        { ...REF, body: "hi" },
        makeContext(),
        [AuthOrchestrationReadScope],
      );
      expect(denied.detail).toContain("authority");
      const deniedCaps = yield* invokeError(provider, "getCapabilities", {}, makeContext(), [
        AuthOrchestrationReadScope,
      ]);
      expect(deniedCaps.detail).toContain("authority");
      expect(deps.calls).toHaveLength(0);
    }),
  );

  it.effect("preserves named service errors instead of flattening them", () =>
    Effect.gen(function* () {
      const deps = makeDeps({
        comment: () =>
          Effect.fail(
            new PullRequestUnavailableError({
              reason: "cli-missing",
              provider: "github",
            }),
          ),
      });
      const provider = createPrsWriteApiProvider(deps);
      const error = yield* invokeError(provider, "comment", { ...REF, body: "hi" });
      expect(error.detail).toContain("PullRequestUnavailableError");
      expect(error.detail).toContain("cli-missing");
    }),
  );

  it.effect("rejects malformed input and unknown methods by name", () =>
    Effect.gen(function* () {
      const deps = makeDeps();
      const provider = createPrsWriteApiProvider(deps);
      const blank = yield* invokeError(provider, "comment", { ...REF, body: "" });
      expect(blank.detail).toContain("Invalid pull request request input");
      const excess = yield* invokeError(provider, "comment", {
        ...REF,
        body: "hi",
        threadId: "smuggled",
      });
      expect(excess.detail).toContain("Invalid pull request request input");
      const missing = yield* invokeError(provider, "nope", {});
      expect(missing.detail).toContain("unavailable");
      expect(deps.calls).toHaveLength(0);
    }),
  );
});
