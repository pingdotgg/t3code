// @effect-diagnostics nodeBuiltinImport:off - the broker deadline proof stages a package on disk.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CodexSettings,
  ExtensionOperationError,
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderError,
  ThreadId,
  VcsUnsupportedOperationError,
  extensionWorkspaceRevision,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type SourceControlPublishRepositoryInput,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  API_CALL_TIME_GRANTS,
  PRS_WRITE,
  VCS_ACTIONS_API,
  VCS_HANDOFF,
  VCS_MUTATE,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import {
  createExtensionRuntime,
  type HostApiProvider,
  type HostApiRootAuthority,
} from "@t3tools/extension-runtime";
import type { GitActionProgressReporter } from "../git/GitManager.ts";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { createModelSelection } from "@t3tools/shared/model";
import type { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import type { VcsDriverHandle, VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { createVcsActionsApiProvider } from "./vcsActionsApi.ts";

/** The grants the broker suggests for a package requiring only t3.vcs/actions. */
const VCS_ACTIONS_SUGGESTED = [
  ...new Set([
    ...(VCS_ACTIONS_API.methods ?? []).flatMap((method) => method.requiredGrants),
    ...(VCS_ACTIONS_API.streams ?? []).flatMap((stream) => stream.requiredGrants),
    ...(API_CALL_TIME_GRANTS[VCS_ACTIONS_API.id] ?? []),
  ]),
];

const isOperationError = Schema.is(ExtensionOperationError);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
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
  assertDetachedAuthority: async () => {},
});

/**
 * Live host state the broker's detached check reads. Each revocation flips
 * one field; `detached-authority.test.mjs` proves the real broker rejects
 * for each of them.
 */
interface LiveAuthority {
  /** True once `run` returned — the broker retires the invocation's assertion. */
  settled: boolean;
  session: boolean;
  mutateGrant: boolean;
  enabled: boolean;
  installed: boolean;
}

const REVOCATIONS: ReadonlyArray<readonly [string, (live: LiveAuthority) => void]> = [
  ["the root session is revoked", (live) => (live.session = false)],
  ["t3.vcs/mutate is removed", (live) => (live.mutateGrant = false)],
  ["the extension is disabled", (live) => (live.enabled = false)],
  ["the extension is uninstalled", (live) => (live.installed = false)],
];

const liveAuthority = (): LiveAuthority => ({
  settled: false,
  session: true,
  mutateGrant: true,
  enabled: true,
  installed: true,
});

const assertLive = async (live: LiveAuthority) => {
  if (!live.session || !live.mutateGrant || !live.enabled || !live.installed) {
    throw new Error("API capability denied");
  }
};

/** Invokes `run` as the broker would, retiring the invocation's assertion once it returns. */
const startRun = (
  provider: HostApiProvider,
  action: "commit_push" | "commit_push_pr",
  live: LiveAuthority,
  assertDetachedAuthority = () => assertLive(live),
) =>
  Effect.promise(async () => {
    const result = await provider.invoke("run", { action }, makeContext(), signal, {
      ...meta(provider),
      assertAuthority: async () => {
        if (live.settled) throw new Error("API invocation closed");
        await assertLive(live);
      },
      assertDetachedAuthority,
    });
    live.settled = true;
    return result as { actionId: string };
  });

/** A composite held at a barrier after it starts, finishing once released. */
const heldWorkflow = () => {
  const workStarted = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const runStackedAction: GitWorkflowService["Service"]["runStackedAction"] = (input, options) =>
    Effect.gen(function* () {
      yield* options!.progressReporter!.publish({
        actionId: input.actionId,
        cwd: input.cwd,
        action: input.action,
        kind: "action_started",
        phases: ["commit", "push"],
      });
      yield* Deferred.succeed(workStarted, undefined);
      yield* Deferred.await(release);
      const result = stackedResult({ action: input.action });
      yield* options!.progressReporter!.publish({
        actionId: input.actionId,
        cwd: input.cwd,
        action: input.action,
        kind: "action_finished",
        result,
      });
      return result;
    });
  return { workStarted, release, runStackedAction };
};

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
  /** Completes once a detached refresh has run for `cwd`. */
  readonly refreshedAt: (cwd: string) => Deferred.Deferred<void>;
  readonly published: SourceControlPublishRepositoryInput[];
  readonly dispatched: OrchestrationCommand[];
  readonly grants: Set<string>;
  readonly authorizeCalls: string[];
  /** Frames the adapter forwarded to the caller's own client handoff provider. */
  readonly handoffStarts: { readonly input: unknown; readonly context: ViewContext }[];
  readonly resolveCalls: string[];
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
    /** `null` leaves the adapter with no client bridge at all. */
    readonly prHandoffClient?: Deps["prHandoffClient"] | null;
    readonly handoffResult?: unknown;
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
  const refreshedByCwd = new Map<string, Deferred.Deferred<void>>();
  const refreshedAt = (cwd: string) => {
    let done = refreshedByCwd.get(cwd);
    if (done === undefined) {
      done = Deferred.makeUnsafe<void>();
      refreshedByCwd.set(cwd, done);
    }
    return done;
  };
  const roots = overrides.workspaceRoots ?? { project: ROOT, other: OTHER_ROOT };
  const handoffStarts: TestDeps["handoffStarts"] = [];
  const resolveCalls: string[] = [];
  const resolvePullRequest: GitWorkflowService["Service"]["resolvePullRequest"] =
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
      }));
  const prHandoffClient: Deps["prHandoffClient"] =
    overrides.prHandoffClient === null
      ? undefined
      : (overrides.prHandoffClient ?? {
          available: () => Effect.succeed(true),
          start: ({ input, context }) =>
            Effect.sync(() => {
              handoffStarts.push({ input, context });
              return (overrides.handoffResult ?? { status: "drafted" }) as never;
            }),
        });

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
          Effect.andThen(Deferred.succeed(refreshedAt(cwd), undefined)),
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
      resolvePullRequest: (input) =>
        Effect.suspend(() => {
          resolveCalls.push(input.reference);
          return resolvePullRequest(input);
        }),
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
            isTrackingPullRequestHead: false,
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
    ...(prHandoffClient === undefined ? {} : { prHandoffClient }),
  };
  return {
    provider: createVcsActionsApiProvider(deps),
    runCalls,
    refreshes,
    refreshed,
    refreshedAt,
    published,
    dispatched,
    grants,
    authorizeCalls,
    handoffStarts,
    resolveCalls,
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
      const git = makeProvider({ kind: "git", grants: [VCS_MUTATE, VCS_HANDOFF] });
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
        grants: VCS_ACTIONS_SUGGESTED,
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

  for (const action of ["create_pr", "commit_push_pr"] as const) {
    it.effect(`provides a Scope for detached ${action} text generation`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-actions-scope-",
        });
        const binaryPath = yield* Effect.sync(() =>
          writeFakeCli({
            directory,
            name: "codex",
            source: [
              'import { readFileSync, writeFileSync } from "node:fs";',
              "const args = process.argv.slice(2);",
              'const schema = JSON.parse(readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));',
              'const output = "subject" in schema.properties ? { subject: "Generated commit", body: "Commit body" } : { title: "Generated PR", body: "PR body" };',
              "for await (const chunk of process.stdin) {}",
              'writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(output));',
            ].join("\n"),
          }),
        );
        const textGeneration = yield* makeCodexTextGeneration(
          decodeCodexSettings({ binaryPath }),
          undefined,
          Effect.succeed([]),
        );
        const generationLayer = Layer.succeed(TextGeneration.TextGeneration, textGeneration);
        const modelSelection = createModelSelection(
          ProviderInstanceId.make("codex"),
          "scope-test-model",
        );
        const test = makeProvider({
          grants: VCS_ACTIONS_SUGGESTED,
          runStackedAction: (input, options) =>
            Effect.gen(function* () {
              const generation = yield* TextGeneration.TextGeneration;
              const result = stackedResult({ action: input.action });
              if (input.action === "commit_push_pr") {
                const commit = yield* generation.generateCommitMessage({
                  cwd: directory,
                  branch: "feature",
                  stagedSummary: "1 file changed",
                  stagedPatch: "",
                  modelSelection,
                });
                expect(commit.subject).toBe("Generated commit");
              }
              const pr = yield* generation.generatePrContent({
                cwd: directory,
                baseBranch: "main",
                headBranch: "feature",
                commitSummary: "A commit",
                diffSummary: "1 file changed",
                diffPatch: "",
                modelSelection,
              });
              expect(pr).toEqual({ title: "Generated PR", body: "PR body" });
              yield* options!.progressReporter!.publish({
                actionId: input.actionId,
                cwd: input.cwd,
                action: input.action,
                kind: "action_finished",
                result,
              });
              return result;
            }).pipe(Effect.provide(generationLayer)),
        });
        const started = (yield* invoke(test.provider, "run", { action })) as { actionId: string };
        const events = yield* collectProgress(test.provider, started.actionId);
        expect(events).toHaveLength(1);
        expect(events[0]!.value).toMatchObject({ kind: "action_finished" });
        expect(test.dispatched.some((command) => command.type === "thread.pull-request.link")).toBe(
          true,
        );
        expect(yield* Deferred.await(test.refreshed)).toBe(ROOT);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-vcs-actions-scope-config-",
          }),
        ),
      ),
    );
  }

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
      const t = makeProvider({ grants: VCS_ACTIONS_SUGGESTED });
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

  it.effect("runs detached work after the broker retires the invocation's assertion", () =>
    Effect.gen(function* () {
      // The broker aborts a unary invocation's `assertAuthority` once the
      // call settles; the composite outlives the call, so it must not reuse it.
      const t = makeProvider({ grants: VCS_ACTIONS_SUGGESTED });
      let settled = false;
      const metadata = {
        ...meta(t.provider),
        assertAuthority: async () => {
          if (settled) throw new Error("API invocation closed");
        },
      };
      const started = (yield* Effect.promise(async () => {
        const result = await t.provider.invoke(
          "run",
          { action: "commit_push_pr", commitMessage: "ship it" },
          makeContext(),
          signal,
          metadata,
        );
        settled = true;
        return result;
      })) as { actionId: string };
      const events = yield* collectProgress(t.provider, started.actionId);
      const kinds = events.map((event) => (event.value as { kind: string }).kind);
      expect(kinds).not.toContain("action_failed");
      expect(kinds).not.toContain("closed");
      expect(t.runCalls).toHaveLength(1);
      expect(yield* Deferred.await(t.refreshed)).toBe(ROOT);
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
          grants: VCS_ACTIONS_SUGGESTED,
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

  for (const action of ["commit_push", "commit_push_pr"] as const) {
    for (const [label, revoke] of REVOCATIONS) {
      it.effect(`${action} skips the PR link and refresh when ${label} mid-action`, () =>
        Effect.gen(function* () {
          const held = heldWorkflow();
          const live = liveAuthority();
          const t = makeProvider({
            grants: VCS_ACTIONS_SUGGESTED,
            runStackedAction: held.runStackedAction,
          });
          const started = yield* startRun(t.provider, action, live);
          yield* Deferred.await(held.workStarted);
          revoke(live);
          yield* Deferred.succeed(held.release, undefined);
          const events = yield* collectProgress(t.provider, started.actionId);
          expect(events.map((event) => event.value)).toEqual([
            expect.objectContaining({ kind: "action_started" }),
            expect.objectContaining({ kind: "action_finished" }),
            { kind: "closed", reason: "authorization-revoked" },
          ]);
          expect(t.dispatched).toHaveLength(0);
          expect(t.refreshes).toHaveLength(0);
        }),
      );
    }
  }

  for (const [label, revoke] of REVOCATIONS) {
    it.effect(`never starts the composite when ${label} before the detached work runs`, () =>
      Effect.gen(function* () {
        const live = liveAuthority();
        const t = makeProvider({ grants: VCS_ACTIONS_SUGGESTED });
        // Revoked between the broker's admission and the detached fiber's first check.
        let checks = 0;
        const started = yield* startRun(t.provider, "commit_push", live, () => {
          if (++checks === 1) revoke(live);
          return assertLive(live);
        });
        const events = yield* collectProgress(t.provider, started.actionId);
        expect(events.map((event) => (event.value as { kind: string }).kind)).toEqual([
          "action_failed",
        ]);
        expect(t.runCalls).toHaveLength(0);
        expect(t.refreshes).toHaveLength(0);
      }),
    );
  }

  it.effect("skips the status refresh when authority is revoked after the PR link", () =>
    Effect.gen(function* () {
      const t = makeProvider({ grants: VCS_ACTIONS_SUGGESTED });
      const live = liveAuthority();
      // The session ends the moment the link lands.
      const started = yield* startRun(t.provider, "commit_push_pr", live, () => {
        if (t.dispatched.length > 0) live.session = false;
        return assertLive(live);
      });
      const events = yield* collectProgress(t.provider, started.actionId);
      expect(events.at(-1)?.value).toEqual({ kind: "closed", reason: "authorization-revoked" });
      expect(t.dispatched).toHaveLength(1);
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

  it.effect.each(["local", "worktree"] as const)(
    "returns actionable checkout detail without provider tags (%s)",
    (mode) =>
      Effect.gen(function* () {
        const detail =
          "If private, run `glab auth login --hostname gitlab.example --api-host gitlab.example:8443` and retry. Merge request !1 was not found or is inaccessible on gitlab.example.";
        const t = makeProvider({
          preparePullRequestThread: () =>
            Effect.fail(
              new SourceControlProviderError({
                provider: "gitlab",
                operation: "getChangeRequest",
                cwd: ROOT,
                detail,
                cause: new Error("provider diagnostic retained server-side"),
              }),
            ),
        });
        const error = yield* invokeError(t.provider, "preparePullRequestThread", {
          reference: "1",
          mode,
        });
        expect(error.detail).toBe(detail);
        expect(t.refreshes).toEqual([]);
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
      // The SDK's result schema is closed to fields it does not declare.
      expect(Object.keys(prepared).sort()).toEqual([
        "branch",
        "isOnPullRequestHead",
        "pullRequest",
        "worktreePath",
      ]);
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

      const t = makeProvider({ grants: VCS_ACTIONS_SUGGESTED });
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
  it.effect(
    "hands the host-resolved pull request and a closed task to the caller's own client",
    () =>
      Effect.gen(function* () {
        const t = makeProvider({
          handoffResult: {
            status: "ready",
            branch: "feature",
            worktreePath: "/repo/.t3/worktrees/feature",
            isOnPullRequestHead: true,
          },
        });
        const result = yield* invoke(t.provider, "handoffPullRequest", {
          reference: "https://github.com/acme/web/pull/7",
          task: "resolve-conflicts",
        });
        expect(result).toEqual({
          status: "ready",
          branch: "feature",
          worktreePath: "/repo/.t3/worktrees/feature",
          isOnPullRequestHead: true,
        });
        expect(t.resolveCalls).toEqual(["https://github.com/acme/web/pull/7"]);
        // Only what the host resolved crosses to the client — never pack text.
        expect(t.handoffStarts.map((start) => start.input)).toEqual([
          {
            task: "resolve-conflicts",
            // Native resolves conflicts in a worktree only.
            mode: "worktree",
            pullRequest: {
              number: 7,
              url: "https://github.com/acme/web/pull/7",
              headBranch: "feature",
              baseBranch: "main",
            },
          },
        ]);
        expect(t.handoffStarts[0]?.context.resource.projectId).toBe("project");
      }),
  );

  // Native's preparation RPC refreshes after a checkout; a composer draft or a
  // failure before checkout touches nothing, so the adapter refreshes never.
  it.effect("never refreshes Git status itself, whatever the handoff returned", () =>
    Effect.gen(function* () {
      for (const handoffResult of [
        { status: "drafted" },
        { status: "failed", stage: "thread", detail: "No thread." },
        { status: "failed", stage: "checkout", detail: "No checkout." },
      ]) {
        const t = makeProvider({ handoffResult });
        expect(
          yield* invoke(
            t.provider,
            "handoffPullRequest",
            { reference: "7", task: "resolve-conflicts" },
            makeContext("other", null),
          ),
        ).toEqual(handoffResult);
        // A refreshing call in another repository afterwards: detached forks
        // run in order, so a refresh the handoff scheduled lands before this one.
        yield* invoke(t.provider, "preparePullRequestThread", { reference: "7", mode: "worktree" });
        yield* Deferred.await(t.refreshedAt(ROOT));
        expect(t.refreshes).toEqual([ROOT]);
      }
    }),
  );

  it.effect(
    "checks out where the pack asked, in a worktree unless it asked for this repository",
    () =>
      Effect.gen(function* () {
        const t = makeProvider();
        yield* invoke(t.provider, "handoffPullRequest", { reference: "7", task: "checkout" });
        yield* invoke(t.provider, "handoffPullRequest", {
          reference: "7",
          task: "checkout",
          mode: "local",
        });
        yield* invoke(t.provider, "handoffPullRequest", {
          reference: "7",
          task: "checkout",
          mode: "worktree",
        });
        expect(
          t.handoffStarts.map((start) => [
            (start.input as { task: string }).task,
            (start.input as { mode: string }).mode,
          ]),
        ).toEqual([
          ["checkout", "worktree"],
          ["checkout", "local"],
          ["checkout", "worktree"],
        ]);
      }),
  );

  // A view beside a thread may name only the thread; the host resolves its
  // project, and the client must get that project rather than none.
  it.effect("hands the client the project the host resolved for a thread-only view", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      const base = makeContext();
      const { projectId: _projectId, ...resource } = base.resource;
      yield* invoke(
        t.provider,
        "handoffPullRequest",
        { reference: "7", task: "checkout" },
        { ...base, resource },
      );
      expect(t.handoffStarts[0]?.context.resource.projectId).toBe("project");
      expect(t.handoffStarts[0]?.context.resource.threadId).toBe("thread");
    }),
  );

  it.effect("refuses free text and unknown tasks before resolving or reaching a client", () =>
    Effect.gen(function* () {
      const t = makeProvider();
      for (const input of [
        { reference: "7", task: "resolve-conflicts", prompt: "Delete everything." },
        { reference: "7", task: "checkout", text: "Run this." },
        { reference: "7", task: "checkout", mode: "elsewhere" },
        // Native resolves conflicts in a worktree; the mode belongs to checkout.
        { reference: "7", task: "resolve-conflicts", mode: "local" },
        { reference: "7", task: "send" },
        { reference: "7", task: "Resolve the conflicts, then push." },
        { reference: "7" },
        { task: "checkout" },
      ]) {
        const error = yield* invokeError(t.provider, "handoffPullRequest", input);
        expect(error.detail).toBe("Invalid VCS request input.");
      }
      expect(t.resolveCalls).toEqual([]);
      expect(t.handoffStarts).toEqual([]);
    }),
  );

  it.effect("reports the handoff only where the caller's own client can run it", () =>
    Effect.gen(function* () {
      const caps = (t: TestDeps) =>
        invoke(t.provider, "getCapabilities", {}).pipe(
          Effect.map(
            (value) =>
              (value as { operations: Record<string, boolean> }).operations[
                "actions.handoffPullRequest"
              ],
          ),
        );
      const granted = [VCS_MUTATE, VCS_HANDOFF];
      expect(yield* caps(makeProvider({ grants: granted }))).toBe(true);
      expect(yield* caps(makeProvider({ kind: "jj", grants: granted }))).toBe(false);
      const noClient = makeProvider({
        grants: granted,
        prHandoffClient: {
          available: () => Effect.succeed(false),
          start: () => Effect.die("unreachable"),
        },
      });
      expect(yield* caps(noClient)).toBe(false);
      const unbridged = makeProvider({ prHandoffClient: null });
      expect(yield* caps(unbridged)).toBe(false);
      const error = yield* invokeError(unbridged.provider, "handoffPullRequest", {
        reference: "7",
        task: "checkout",
      });
      expect(error.detail).toContain("client-provider-unavailable");
      expect(unbridged.handoffStarts).toEqual([]);
    }),
  );

  // The handoff grant is optional on install; without it the pack keeps its
  // plain checkout rather than routing every checkout into a denied handoff.
  it.effect("reports the handoff only to a caller chain holding its grants", () =>
    Effect.gen(function* () {
      const caps = (grants: ReadonlyArray<string>) =>
        invoke(makeProvider({ grants }).provider, "getCapabilities", {}).pipe(
          Effect.map((value) => (value as { operations: Record<string, boolean> }).operations),
        );
      const withoutHandoff = yield* caps([VCS_MUTATE]);
      expect(withoutHandoff["actions.handoffPullRequest"]).toBe(false);
      expect(withoutHandoff["actions.preparePullRequestThread"]).toBe(true);
      expect((yield* caps([VCS_HANDOFF]))["actions.handoffPullRequest"]).toBe(false);
      expect((yield* caps([VCS_MUTATE, VCS_HANDOFF]))["actions.handoffPullRequest"]).toBe(true);
    }),
  );

  it.effect("names a client that cannot take the handoff instead of reporting success", () =>
    Effect.gen(function* () {
      const t = makeProvider({
        prHandoffClient: {
          available: () => Effect.succeed(false),
          start: () => Effect.die("unreachable"),
        },
      });
      const error = yield* invokeError(t.provider, "handoffPullRequest", {
        reference: "7",
        task: "checkout",
      });
      expect(error.detail).toContain("client-provider-unavailable");
      expect(t.resolveCalls).toEqual([]);
    }),
  );
});

/** The API deadline `EnvironmentExtensions` gives the broker for ordinary calls. */
const ORDINARY_API_DEADLINE_MS = 15_000;
const HANDOFF_CONSUMER_MANIFEST =
  '{"format":2,"manifest":{"id":"test.vcs-handoff","apiVersion":1,"version":"1.0.0","surfaces":[]},' +
  '"serverEntry":"server.mjs","tools":[],"provides":[],' +
  '"requires":[{"id":"t3.vcs/actions","versionRange":"^1.1.0"}],"dependencies":[]}';

// Native's handoff has no short deadline: a cold worktree or a slow fetch can
// take longer than an ordinary API call, and the broker must not report a
// failure while the checkout carries on.
it("a handoff through the broker outlives the ordinary API deadline", async () => {
  const dir = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vcs-handoff-broker-")),
  );
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const t = makeProvider({
    prHandoffClient: {
      available: () => Effect.succeed(true),
      start: () =>
        Effect.promise(() => {
          markStarted();
          return released;
        }).pipe(Effect.as({ status: "drafted" as const })),
    },
  });
  const root: HostApiRootAuthority = {
    principal: meta(t.provider).principal!,
    allowWrite: true,
    revalidate: () => {},
  };
  try {
    const source = NodePath.join(dir, "source");
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(NodePath.join(source, "t3-extension.json"), HANDOFF_CONSUMER_MANIFEST);
    await NodeFSP.writeFile(
      NodePath.join(source, "server.mjs"),
      "export default {tools:[],apis:[]};",
    );
    const runtime = await createExtensionRuntime({
      rootDir: NodePath.join(dir, "state"),
      environmentId: "env",
      services: [],
      apiProviders: [t.provider],
      authorize: (installation, grant) => installation.grants.capabilities.includes(grant),
      timeoutMs: ORDINARY_API_DEADLINE_MS,
    });
    try {
      const installed = await runtime.install(source, {
        capabilities: [VCS_MUTATE, VCS_HANDOFF],
        projectIds: ["project"],
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const handoff = runtime
          .invokeApi(
            installed.id,
            installed.contentHash,
            {
              id: "t3.vcs/actions",
              versionRange: "^1.1.0",
              method: "handoffPullRequest",
              input: { reference: "7", task: "checkout" },
              context: makeContext(),
            },
            new AbortController().signal,
            root,
          )
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
          );
        await started;
        vi.advanceTimersByTime(ORDINARY_API_DEADLINE_MS * 4);
        release();
        expect(await handoff).toEqual({ value: { status: "drafted" } });
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
