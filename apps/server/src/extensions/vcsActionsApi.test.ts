import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VcsUnsupportedOperationError,
  extensionWorkspaceRevision,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type SourceControlPublishRepositoryInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PRS_WRITE } from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import type { GitActionProgressReporter } from "../git/GitManager.ts";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import type { VcsDriverHandle, VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { createVcsActionsApiProvider } from "./vcsActionsApi.ts";

const isOperationError = Schema.is(ExtensionOperationError);
const READ_AND_OPERATE = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
const signal = new AbortController().signal;

class InvokeRejection extends Data.TaggedError("InvokeRejection")<{
  readonly cause: unknown;
}> {}

const ROOT = "/repo";
const OTHER_ROOT = "/other-repo";

const makeContext = (projectId = "project", threadId: string | null = "thread"): ViewContext => ({
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId,
    ...(threadId === null ? {} : { threadId }),
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision(projectId === "project" ? ROOT : OTHER_ROOT, null),
});

const meta = (
  provider: HostApiProvider,
  scopes: readonly string[] = READ_AND_OPERATE,
  callerGenerations: Parameters<HostApiProvider["invoke"]>[4]["callerGenerations"] = [],
): Parameters<HostApiProvider["invoke"]>[4] => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations,
  principal: {
    kind: "environment-session",
    id: "session",
    environmentId: "env",
    scopes,
  },
  assertAuthority: async () => {},
});

const gitCapabilities = {
  kind: "git",
  supportsWorktrees: true,
  supportsBookmarks: false,
  supportsAtomicSnapshot: true,
  supportsPushDefaultRemote: true,
  ignoreClassifier: "native",
} as const;

const statusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const makeHandle = (kind: "git" | "jj"): VcsDriverHandle => ({
  kind,
  // The adapter only ever reads `kind` and `driver.capabilities`.
  repository: { kind } as VcsDriverHandle["repository"],
  driver: {
    capabilities: { ...gitCapabilities, kind },
  } as VcsDriverHandle["driver"],
});

const threadShell: OrchestrationThreadShell = {
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const stackedResult = (
  overrides: Partial<GitRunStackedActionResult> = {},
): GitRunStackedActionResult => ({
  action: "commit_push_pr",
  branch: { status: "created", name: "feature" },
  commit: { status: "created", commitSha: "abc123", subject: "add thing" },
  push: {
    status: "pushed",
    branch: "feature",
    upstreamBranch: "origin/feature",
    setUpstream: true,
  },
  pr: {
    status: "created",
    url: "https://github.com/acme/web/pull/42",
    number: 42,
    baseBranch: "main",
    headBranch: "feature",
    title: "Add thing",
  },
  toast: { title: "Done", cta: { kind: "none" } },
  ...overrides,
});

interface RunCall {
  readonly input: Parameters<GitWorkflowService["Service"]["runStackedAction"]>[0];
  readonly reporter: GitActionProgressReporter | undefined;
}

type Deps = Parameters<typeof createVcsActionsApiProvider>[0];

interface TestDeps {
  readonly provider: HostApiProvider;
  readonly runCalls: RunCall[];
  readonly refreshes: string[];
  /** Completes with the cwd of the first detached post-mutation refresh. */
  readonly refreshed: Deferred.Deferred<string>;
  readonly published: SourceControlPublishRepositoryInput[];
  readonly dispatched: OrchestrationCommand[];
  readonly grants: Set<string>;
  readonly authorizeCalls: string[];
}

const makeProvider = (
  overrides: {
    readonly kind?: "git" | "jj" | null;
    readonly detect?: VcsDriverRegistry["Service"]["detect"];
    readonly resolve?: VcsDriverRegistry["Service"]["resolve"];
    readonly runStackedAction?: GitWorkflowService["Service"]["runStackedAction"];
    readonly resolvePullRequest?: GitWorkflowService["Service"]["resolvePullRequest"];
    readonly preparePullRequestThread?: GitWorkflowService["Service"]["preparePullRequestThread"];
    readonly publishRepository?: SourceControlRepositoryService["Service"]["publishRepository"];
    readonly threadShell?: OrchestrationThreadShell | null;
    readonly projectShell?: OrchestrationProjectShell | null;
    readonly grants?: ReadonlyArray<string>;
    readonly authorizeGrant?: Deps["authorizeGrant"];
    readonly workspaceRoots?: Record<string, string>;
  } = {},
): TestDeps => {
  const kind = overrides.kind === undefined ? "git" : overrides.kind;
  const handle = kind === null ? null : makeHandle(kind);
  const runCalls: RunCall[] = [];
  const refreshes: string[] = [];
  const published: SourceControlPublishRepositoryInput[] = [];
  const dispatched: OrchestrationCommand[] = [];
  const grants = new Set(overrides.grants ?? []);
  const authorizeCalls: string[] = [];
  const refreshed = Deferred.makeUnsafe<string>();
  const roots = overrides.workspaceRoots ?? { project: ROOT, other: OTHER_ROOT };

  const deps: Deps = {
    environmentId: "env",
    projects: {
      getById: ({ projectId }) =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make(projectId),
            workspaceRoot: roots[projectId] ?? ROOT,
            deletedAt: null,
          }),
        ),
    },
    threads: {
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: null,
            deletedAt: null,
          }),
        ),
    },
    vcsStatus: {
      refreshStatus: (cwd) =>
        Effect.sync(() => refreshes.push(cwd)).pipe(
          Effect.andThen(Deferred.succeed(refreshed, cwd)),
          Effect.ignoreCause({ log: true }),
          Effect.as(statusResult),
        ),
    },
    gitWorkflow: {
      // The adapter builds the work effect eagerly and runs it on a detached
      // fiber after preflight — suspend so the call records only when the
      // action actually starts.
      runStackedAction: (input, options) =>
        Effect.suspend(() => {
          runCalls.push({ input, reporter: options?.progressReporter });
          return (overrides.runStackedAction ?? (() => Effect.succeed(stackedResult())))(
            input,
            options,
          );
        }),
      resolvePullRequest:
        overrides.resolvePullRequest ??
        (() =>
          Effect.succeed({
            pullRequest: {
              number: 7,
              title: "Resolved",
              url: "https://github.com/acme/web/pull/7",
              baseBranch: "main",
              headBranch: "feature",
              state: "open" as const,
            },
          })),
      preparePullRequestThread:
        overrides.preparePullRequestThread ??
        (() =>
          Effect.succeed({
            pullRequest: {
              number: 7,
              title: "Resolved",
              url: "https://github.com/acme/web/pull/7",
              baseBranch: "main",
              headBranch: "feature",
              state: "open" as const,
            },
            branch: "pr-7",
            worktreePath: null,
            isOnPullRequestHead: true,
          })),
    },
    vcsRegistry: {
      detect: overrides.detect ?? (() => Effect.succeed(handle)),
      resolve:
        overrides.resolve ??
        (() =>
          handle === null
            ? Effect.fail(
                new VcsUnsupportedOperationError({
                  operation: "detect",
                  kind: "unknown",
                  detail: "No repository detected.",
                }),
              )
            : Effect.succeed(handle)),
    },
    sourceControlRepositories: {
      publishRepository:
        overrides.publishRepository ??
        ((input) => {
          published.push(input);
          return Effect.succeed({
            repository: {
              provider: input.provider,
              nameWithOwner: input.repository,
              url: `https://github.com/${input.repository}`,
              sshUrl: `git@github.com:${input.repository}.git`,
            },
            remoteName: input.remoteName ?? "origin",
            remoteUrl: `git@github.com:${input.repository}.git`,
            branch: "main",
            upstreamBranch: "origin/main",
            status: "pushed" as const,
          });
        }),
    },
    orchestrationEngine: {
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    },
    projectionSnapshotQuery: {
      getThreadShellById: () =>
        Effect.succeed(overrides.threadShell === null ? Option.none() : Option.some(threadShell)),
      getProjectShellById: () =>
        Effect.succeed(
          overrides.projectShell === undefined || overrides.projectShell === null
            ? Option.none()
            : Option.some(overrides.projectShell),
        ),
    },
    authorizeGrant:
      overrides.authorizeGrant ??
      ((callerId, grant) => {
        authorizeCalls.push(`${callerId}:${grant}`);
        return Promise.resolve(grants.has(grant));
      }),
  };
  return {
    provider: createVcsActionsApiProvider(deps),
    runCalls,
    refreshes,
    refreshed,
    published,
    dispatched,
    grants,
    authorizeCalls,
  };
};

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

const invokeError = (
  provider: HostApiProvider,
  method: string,
  input: Parameters<HostApiProvider["invoke"]>[1],
  context: ViewContext = makeContext(),
  scopes: readonly string[] = READ_AND_OPERATE,
) =>
  invoke(provider, method, input, context, scopes).pipe(
    Effect.flip,
    Effect.map((rejection) => {
      if (!isOperationError(rejection.cause)) {
        throw new Error(`expected ExtensionOperationError, got ${String(rejection.cause)}`);
      }
      return rejection.cause;
    }),
  );

const collectProgress = (
  provider: HostApiProvider,
  actionId: string,
  context: ViewContext = makeContext(),
  limit = 64,
) =>
  Effect.promise(async () => {
    const iterable = provider.subscribe!(
      "actionProgress",
      { actionId },
      context,
      signal,
      meta(provider),
    );
    const events: ApiStreamEvent[] = [];
    for await (const event of iterable) {
      events.push(event);
      if (events.length >= limit) break;
    }
    return events;
  });

const subscribeError = (
  provider: HostApiProvider,
  input: Parameters<NonNullable<HostApiProvider["subscribe"]>>[1],
  context: ViewContext = makeContext(),
) =>
  Effect.sync(() => {
    try {
      provider.subscribe!("actionProgress", input, context, signal, meta(provider));
      return null;
    } catch (cause) {
      return cause;
    }
  });

it.layer(NodeServices.layer)("t3.vcs/actions adapter", (it) => {
  it.effect("reports per-operation support for git, jj, and undetected workspaces", () =>
    Effect.gen(function* () {
      const git = makeProvider({ kind: "git" });
      const caps = (yield* invoke(git.provider, "getCapabilities", {})) as {
        detected: boolean;
        kind: string | null;
        driver: { kind: string } | null;
        operations: Record<string, boolean>;
      };
      expect(caps.detected).toBe(true);
      expect(caps.kind).toBe("git");
      expect(caps.driver?.kind).toBe("git");
      expect(Object.values(caps.operations).every(Boolean)).toBe(true);

      const jj = makeProvider({ kind: "jj" });
      const jjCaps = (yield* invoke(jj.provider, "getCapabilities", {})) as {
        kind: string | null;
        operations: Record<string, boolean>;
      };
      expect(jjCaps.kind).toBe("jj");
      expect(Object.values(jjCaps.operations).every((v) => !v)).toBe(true);

      const none = makeProvider({ kind: null });
      const noneCaps = (yield* invoke(none.provider, "getCapabilities", {})) as {
        detected: boolean;
        kind: string | null;
        operations: Record<string, boolean>;
      };
      expect(noneCaps.detected).toBe(false);
      expect(noneCaps.kind).toBeNull();
      expect(Object.values(noneCaps.operations).every((v) => !v)).toBe(true);
    }),
  );

  it.effect("runs a stacked action, streams ordered progress, and refreshes status", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        grants: [PRS_WRITE],
        runStackedAction: (input, options) =>
          Effect.gen(function* () {
            const reporter = options!.progressReporter!;
            yield* reporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_started",
              phases: ["branch", "commit", "push", "pr"],
            });
            yield* reporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "phase_started",
              phase: "commit",
              label: "Committing",
            });
            const result = stackedResult();
            yield* reporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_finished",
              result,
            });
            return result;
          }),
      });
      const context = makeContext();
      const started = (yield* invoke(t.provider, "run", {
        action: "commit_push_pr",
        commitMessage: "ship it",
        paths: ["a.txt"],
      })) as { actionId: string };
      expect(typeof started.actionId).toBe("string");

      const events = yield* collectProgress(t.provider, started.actionId, context);
      const kinds = events.map((event) => (event.value as { kind: string }).kind);
      expect(kinds).toEqual(["action_started", "phase_started", "action_finished"]);
      const finished = events[2]!.value as {
        kind: "action_finished";
        result: {
          commit: { messageSource: string };
          pr: { contentSource: string; number?: number };
        };
      };
      // Caller-supplied message, composite-generated PR text.
      expect(finished.result.commit.messageSource).toBe("caller");
      expect(finished.result.pr.contentSource).toBe("generated");
      expect(finished.result.pr.number).toBe(42);

      expect(t.runCalls).toHaveLength(1);
      const call = t.runCalls[0]!;
      expect(call.input.cwd).toBe(ROOT);
      expect(call.input.action).toBe("commit_push_pr");
      expect(call.input.commitMessage).toBe("ship it");
      expect(call.input.filePaths).toEqual(["a.txt"]);
      expect(call.input.threadId).toBe("thread");
      // The post-mutation refresh is detached like the ws.ts caller.
      expect(yield* Deferred.await(t.refreshed)).toBe(ROOT);
    }),
  );

  it.effect("marks blank commit messages as generated provenance", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        runStackedAction: (input, options) =>
          Effect.andThen(
            options!.progressReporter!.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_finished",
              result: stackedResult({ action: "commit" }),
            }),
            Effect.succeed(stackedResult({ action: "commit" })),
          ),
      });
      const started = (yield* invoke(t.provider, "run", { action: "commit" })) as {
        actionId: string;
      };
      const events = yield* collectProgress(t.provider, started.actionId);
      const finished = events.at(-1)!.value as {
        result: { commit: { messageSource: string } };
      };
      expect(finished.result.commit.messageSource).toBe("generated");
      // Blank messages are left blank — native auto-generate semantics.
      expect(t.runCalls[0]!.input.commitMessage).toBeUndefined();
    }),
  );

  it.effect("links a created pull request to the resolved thread", () =>
    Effect.gen(function* () {
      const t = makeProvider({ grants: [PRS_WRITE] });
      const started = (yield* invoke(t.provider, "run", { action: "commit_push_pr" })) as {
        actionId: string;
      };
      yield* collectProgress(t.provider, started.actionId);
      const link = t.dispatched.find((command) => command.type === "thread.pull-request.link");
      expect(link).toBeDefined();
      expect(link).toMatchObject({
        threadId: "thread",
        host: "github.com",
        repository: "acme/web",
        number: 42,
        source: "created",
      });
    }),
  );

  it.effect("rejects PR-producing actions when any caller lacks t3.prs/write", () =>
    Effect.gen(function* () {
      const denied = makeProvider();
      const error = yield* invokeError(denied.provider, "run", { action: "commit_push_pr" });
      expect(error.detail).toContain("VcsActionGrantDeniedError");
      expect(error.detail).toContain(PRS_WRITE);
      expect(denied.runCalls).toHaveLength(0);

      // The direct caller holds the grant but an upstream caller does not —
      // every link in the chain must carry it.
      const chained = makeProvider({
        authorizeGrant: (callerId) => Promise.resolve(callerId === "caller"),
      });
      const callerMeta = meta(chained.provider, READ_AND_OPERATE, [
        { pluginId: "upstream", contentHash: "h", installationGeneration: 1 },
      ]);
      const rejection = yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            chained.provider.invoke(
              "run",
              { action: "create_pr" },
              makeContext(),
              signal,
              callerMeta,
            ),
          ),
        catch: (cause) => new InvokeRejection({ cause }),
      }).pipe(Effect.flip);
      expect(isOperationError(rejection.cause)).toBe(true);
      expect((rejection.cause as ExtensionOperationError).detail).toContain(
        "VcsActionGrantDeniedError",
      );
      expect(chained.runCalls).toHaveLength(0);
    }),
  );

  it.effect("does not require t3.prs/write for non-PR actions", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      const started = (yield* invoke(t.provider, "run", { action: "push" })) as {
        actionId: string;
      };
      yield* collectProgress(t.provider, started.actionId);
      expect(t.authorizeCalls.filter((call) => call.endsWith(PRS_WRITE))).toHaveLength(0);
      expect(t.runCalls).toHaveLength(1);
    }),
  );

  it.effect("surfaces a denied in-flight grant recheck as a named action_failed", () =>
    Effect.gen(function* () {
      // The pre-run chain check passes; the forked work's preflight recheck
      // denies — the action fails by name instead of mutating silently.
      let checks = 0;
      const revoking = makeProvider({
        authorizeGrant: () => Promise.resolve(++checks === 1),
      });
      const started = (yield* invoke(revoking.provider, "run", {
        action: "commit_push_pr",
      })) as { actionId: string };
      const events = yield* collectProgress(revoking.provider, started.actionId);
      const failed = events.find(
        (event) => (event.value as { kind: string }).kind === "action_failed",
      );
      expect(failed).toBeDefined();
      expect((failed!.value as { phase: string | null }).phase).toBeNull();
      expect((failed!.value as { message: string }).message).toContain("VcsActionGrantDeniedError");
      expect(revoking.runCalls).toHaveLength(0);
    }),
  );

  it.effect(
    "rechecks the dynamic grant after detached work and names the revocation on the stream",
    () =>
      Effect.gen(function* () {
        // Admission and the in-fiber preflight both pass with PRS_WRITE
        // held; the grant is revoked while the composite runs, so the
        // post-service recheck must observe it. Under F-a the denial
        // lands AFTER action_finished as a named closed event — the git
        // effects persisted, so it names the check, not a phase — and the
        // link/refresh tail never runs.
        const workStarted = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        const t = makeProvider({
          grants: [PRS_WRITE],
          runStackedAction: (input, options) =>
            Effect.gen(function* () {
              yield* options!.progressReporter!.publish({
                actionId: input.actionId,
                cwd: input.cwd,
                action: input.action,
                kind: "action_started",
                phases: ["commit", "push", "pr"],
              });
              yield* Deferred.succeed(workStarted, undefined);
              yield* Deferred.await(release);
              yield* options!.progressReporter!.publish({
                actionId: input.actionId,
                cwd: input.cwd,
                action: input.action,
                kind: "action_finished",
                result: stackedResult({ action: input.action }),
              });
              return stackedResult({ action: input.action });
            }),
        });
        const started = (yield* invoke(t.provider, "run", { action: "commit_push_pr" })) as {
          actionId: string;
        };
        yield* Deferred.await(workStarted);
        t.grants.delete(PRS_WRITE);
        yield* Deferred.succeed(release, undefined);
        const events = yield* collectProgress(t.provider, started.actionId);
        const kinds = events.map((event) => (event.value as { kind: string }).kind);
        expect(kinds).toEqual(["action_started", "action_finished", "closed"]);
        expect((events[2]!.value as { reason: string }).reason).toBe("authorization-revoked");
        expect(t.dispatched).toHaveLength(0);
        expect(t.refreshes).toHaveLength(0);
      }),
  );

  it.effect("names the composite's own failure phase without double-terminating", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        runStackedAction: (input, options) =>
          Effect.gen(function* () {
            const reporter = options!.progressReporter!;
            yield* reporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_started",
              phases: ["commit", "push"],
            });
            yield* reporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "phase_started",
              phase: "push",
              label: "Pushing",
            });
            yield* reporter.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_failed",
              phase: "push",
              message: "rejected: non-fast-forward",
            });
            return yield* new GitManagerError({
              operation: "runStackedAction",
              cwd: input.cwd,
              detail: "push failed",
            });
          }),
      });
      const started = (yield* invoke(t.provider, "run", { action: "commit_push" })) as {
        actionId: string;
      };
      const events = yield* collectProgress(t.provider, started.actionId);
      const kinds = events.map((event) => (event.value as { kind: string }).kind);
      expect(kinds).toEqual(["action_started", "phase_started", "action_failed"]);
      const failed = events.at(-1)!.value as { phase: string | null; message: string };
      expect(failed.phase).toBe("push");
      expect(failed.message).toBe("rejected: non-fast-forward");
      // The failure still refreshes status? No — only success links+refreshes.
      expect(t.refreshes).toHaveLength(0);
    }),
  );

  it.effect("appends a named action_failed when the service dies silently", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        runStackedAction: (input) =>
          Effect.fail(
            new GitManagerError({
              operation: "runStackedAction",
              cwd: input.cwd,
              detail: "disk gone",
            }),
          ),
      });
      const started = (yield* invoke(t.provider, "run", { action: "commit" })) as {
        actionId: string;
      };
      const events = yield* collectProgress(t.provider, started.actionId);
      const failed = events.at(-1)!.value as {
        kind: string;
        phase: string | null;
        message: string;
      };
      expect(failed.kind).toBe("action_failed");
      expect(failed.phase).toBeNull();
      expect(failed.message).toContain("disk gone");
    }),
  );

  it.effect("requires Operate scope for run and Read for getCapabilities", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      const denied = yield* invokeError(t.provider, "run", { action: "commit" }, makeContext(), [
        AuthOrchestrationReadScope,
      ]);
      expect(denied.detail).toContain("authority");
      expect(t.runCalls).toHaveLength(0);

      const caps = yield* invoke(t.provider, "getCapabilities", {}, makeContext(), [
        AuthOrchestrationReadScope,
      ]);
      expect((caps as { detected: boolean }).detected).toBe(true);
    }),
  );

  it.effect("names unsupported drivers instead of empty success", () =>
    Effect.gen(function* () {
      const jj = makeProvider({ kind: "jj" });
      const run = yield* invokeError(jj.provider, "run", { action: "commit" });
      expect(run.detail).toContain("VcsUnsupportedOperationError");
      const resolved = yield* invokeError(jj.provider, "resolvePullRequest", {
        reference: "7",
      });
      expect(resolved.detail).toContain("VcsUnsupportedOperationError");
      const prepared = yield* invokeError(jj.provider, "preparePullRequestThread", {
        reference: "7",
        mode: "local",
      });
      expect(prepared.detail).toContain("VcsUnsupportedOperationError");
    }),
  );

  it.effect("resolves and prepares pull requests within public bounds", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      const resolved = (yield* invoke(t.provider, "resolvePullRequest", { reference: "7" })) as {
        pullRequest: { number: number; state: string };
      };
      expect(resolved.pullRequest.number).toBe(7);
      expect(resolved.pullRequest.state).toBe("open");

      const prepared = (yield* invoke(t.provider, "preparePullRequestThread", {
        reference: "7",
        mode: "worktree",
      })) as { branch: string; isOnPullRequestHead: boolean };
      expect(prepared.branch).toBe("pr-7");
      expect(prepared.isOnPullRequestHead).toBe(true);
      expect(yield* Deferred.await(t.refreshed)).toBe(ROOT);
    }),
  );

  it.effect("refuses oversized resolved pull requests by name", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        resolvePullRequest: () =>
          Effect.succeed({
            pullRequest: {
              number: 7,
              title: "x".repeat(3_000),
              url: "https://github.com/acme/web/pull/7",
              baseBranch: "main",
              headBranch: "feature",
              state: "open" as const,
            },
          }),
      });
      const error = yield* invokeError(t.provider, "resolvePullRequest", { reference: "7" });
      expect(error.detail).toContain("bounds");
    }),
  );

  it.effect("gates publishRepository on t3.prs/write and names the unknown provider", () =>
    Effect.gen(function* () {
      const denied = makeProvider();
      const deniedError = yield* invokeError(denied.provider, "publishRepository", {
        provider: "github",
        repository: "acme/web",
        visibility: "private",
      });
      expect(deniedError.detail).toContain("VcsActionGrantDeniedError");
      expect(denied.published).toHaveLength(0);

      const t = makeProvider({ grants: [PRS_WRITE] });
      const unknown = yield* invokeError(t.provider, "publishRepository", {
        provider: "unknown",
        repository: "acme/web",
        visibility: "private",
      });
      expect(unknown.detail).toContain("PullRequestUnavailableError");
      expect(unknown.detail).toContain("provider-unsupported");

      const ok = (yield* invoke(t.provider, "publishRepository", {
        provider: "github",
        repository: "acme/web",
        visibility: "private",
        protocol: "ssh",
      })) as { remoteName: string; status: string };
      expect(ok.status).toBe("pushed");
      expect(t.published).toHaveLength(1);
      expect(t.published[0]!.cwd).toBe(ROOT);
      expect(t.published[0]!.protocol).toBe("ssh");
      expect(yield* Deferred.await(t.refreshed)).toBe(ROOT);
    }),
  );

  it.effect("rejects unknown, resumed, and cross-workspace progress subscriptions", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      const unknown = yield* subscribeError(t.provider, { actionId: "nope" });
      expect(isOperationError(unknown)).toBe(true);

      const resumed = yield* Effect.sync(() => {
        try {
          t.provider.subscribe!(
            "actionProgress",
            { actionId: "x" },
            makeContext(),
            signal,
            meta(t.provider),
            "0",
          );
          return null;
        } catch (cause) {
          return cause;
        }
      });
      expect(isOperationError(resumed)).toBe(true);
      expect((resumed as ExtensionOperationError).detail).toContain("resume");

      // An action under ROOT is invisible to a subscription resolved to another workspace.
      const started = (yield* invoke(t.provider, "run", { action: "commit" })) as {
        actionId: string;
      };
      const cross = yield* Effect.tryPromise({
        try: async () => {
          const iterable = t.provider.subscribe!(
            "actionProgress",
            { actionId: started.actionId },
            makeContext("other", null),
            signal,
            meta(t.provider),
          );
          for await (const event of iterable) void event;
          return null;
        },
        catch: (cause) => new InvokeRejection({ cause }),
      }).pipe(Effect.flip);
      expect(isOperationError(cross.cause)).toBe(true);
      expect((cross.cause as ExtensionOperationError).detail).toContain("unavailable");
    }),
  );

  it.effect("replays finished action history to a late subscriber", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        runStackedAction: (input, options) =>
          Effect.gen(function* () {
            yield* options!.progressReporter!.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_started",
              phases: ["commit"],
            });
            yield* options!.progressReporter!.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_finished",
              result: stackedResult({ action: "commit" }),
            });
            return stackedResult({ action: "commit" });
          }),
      });
      const started = (yield* invoke(t.provider, "run", { action: "commit" })) as {
        actionId: string;
      };
      // First subscriber drains the action to terminal.
      yield* collectProgress(t.provider, started.actionId);
      // A subscriber attaching after completion replays history then ends.
      const events = yield* collectProgress(t.provider, started.actionId);
      const kinds = events.map((event) => (event.value as { kind: string }).kind);
      expect(kinds).toEqual(["action_started", "action_finished"]);
    }),
  );

  it.effect("settles a pending progress read when the subscription is cancelled", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        runStackedAction: (input, options) =>
          options!
            .progressReporter!.publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "action_started",
              phases: ["commit"],
            })
            .pipe(Effect.andThen(Effect.never)),
      });
      const started = (yield* invoke(t.provider, "run", { action: "commit" })) as {
        actionId: string;
      };
      const controller = new AbortController();
      const iterable = t.provider.subscribe!(
        "actionProgress",
        { actionId: started.actionId },
        makeContext(),
        controller.signal,
        meta(t.provider),
      );
      const iterator = iterable[Symbol.asyncIterator]();
      // The first read delivers action_started whenever the detached fiber
      // publishes it; the second parks — the action never terminates.
      const first = yield* Effect.promise(() => iterator.next());
      expect((first.value as ApiStreamEvent).type).toBe("data");
      const pending = iterator.next();
      controller.abort();
      const outcome = yield* Effect.race(
        Effect.promise(() =>
          pending.then(
            () => "resolved" as const,
            () => "rejected" as const,
          ),
        ),
        Effect.sleep("1 second").pipe(Effect.as("hung" as const)),
      );
      // The parked read must settle on cancel — a hung read would otherwise
      // linger until the broker abandons the call.
      expect(outcome).toBe("rejected");
    }),
  );

  it.effect("rejects invalid input and unknown methods by name", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      const bad = yield* invokeError(t.provider, "run", { action: "nonsense" });
      expect(bad.detail).toContain("Invalid VCS request input");
      const missing = yield* invokeError(t.provider, "nope", {});
      expect(missing.detail).toContain("unavailable");
    }),
  );
});
