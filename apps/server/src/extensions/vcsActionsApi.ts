// @effect-diagnostics nodeBuiltinImport:off - the action registry is a plain Map outside a service context.
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ExtensionOperationError,
  PullRequestUnavailableError,
  ThreadId,
  VcsUnsupportedOperationError,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type VcsDriverKind,
} from "@t3tools/contracts";
import {
  PRS_WRITE,
  VCS_ACTIONS_API,
  type VcsActionProgressEvent,
  type VcsActionPublishResult,
  type VcsActionResolvePullRequestResult,
  type VcsActionPrepareThreadResult,
  type VcsActionResult,
  type VcsActionRunResult,
  type VcsActionsCapabilitiesResult,
  type VcsActionsOperationsSupport,
} from "@t3tools/extension-sdk/catalogue";
import type { ApiStreamEvent } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import type {
  HostApiInvocationMetadata,
  HostApiPrincipal,
  HostApiProvider,
} from "@t3tools/extension-runtime";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { GitActionProgressReporter } from "../git/GitManager.ts";
import { linkCreatedPullRequest } from "../git/linkCreatedPullRequest.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

/**
 * t3.vcs/actions — the native stacked-action composite plus the
 * Operate-scoped git seams. `run` starts `gitRunStackedAction` under a
 * server-minted actionId and returns it; progress travels on the separate
 * `actionProgress` read stream (T2 — the broker's streams are read-only,
 * so the composite's progress cannot ride the write call itself).
 *
 * The action registry is the T2 prerequisite: actionId → buffered history
 * for subscribers that attach mid-flight, per-subscriber bounded queues,
 * terminal retention, and lazy reaping. An actionId is a correlation key
 * minted here, never caller input.
 */

/** Retained history a late subscriber replays; past this the stream must end by name. */
const MAX_HISTORY_EVENTS = 1_024;
/** Per-subscriber backlog before that subscriber is closed with `overflow`. */
const MAX_QUEUED_EVENTS = 256;
/** Concurrent live actions per provider instance — a runaway caller cannot grow it unboundedly. */
const MAX_LIVE_ACTIONS = 64;
/** A terminal action stays subscribable this long, then its id is unknown again. */
const TERMINAL_RETENTION_MS = 5 * 60_000;
/** Registry entries are pruned on access — no timers, nothing to leak. */
const MAX_ACTION_AGE_MS = 60 * 60_000;

const MAX_REFERENCE = 2_048;
const MAX_PR_TITLE = 2_048;
const MAX_BRANCH_NAME = 4_096;
const MAX_PR_URL = 4_096;
const MAX_WORKTREE_PATH = 32_768;

const decode = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });
const emptyInput = decode(Schema.Struct({}));
const pathSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const runInput = decode(
  Schema.Struct({
    action: Schema.Literals(["commit", "push", "create_pr", "commit_push", "commit_push_pr"]),
    commitMessage: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
    featureBranch: Schema.optional(Schema.Boolean),
    paths: Schema.optional(
      Schema.Array(pathSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
  }),
);
const referenceInput = decode(
  Schema.Struct({
    reference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_REFERENCE)),
  }),
);
const prepareInput = decode(
  Schema.Struct({
    reference: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_REFERENCE)),
    mode: Schema.Literals(["local", "worktree"]),
  }),
);
const publishInput = decode(
  Schema.Struct({
    provider: Schema.Literals([
      "github",
      "gitlab",
      "azure-devops",
      "bitbucket",
      "forgejo",
      "unknown",
    ]),
    repository: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    visibility: Schema.Literals(["private", "public"]),
    remoteName: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    ),
    protocol: Schema.optional(Schema.Literals(["auto", "ssh", "https"])),
  }),
);
const progressInput = decode(
  Schema.Struct({
    actionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
);

const failure = (operation: string, detail: string) =>
  new ExtensionOperationError({ operation, detail });
const isOperationError = Schema.is(ExtensionOperationError);

/**
 * Tag-preserving error mapping — `VcsUnsupportedOperationError` and the
 * `PullRequestUnavailableError` reasons (cli-missing / cli-unauthenticated /
 * provider-unsupported) surface by name, never flattened into a generic
 * "failed".
 */
const operationError = (operation: string) => (cause: unknown) => {
  if (isOperationError(cause)) return cause;
  const tag =
    cause !== null &&
    typeof cause === "object" &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
      ? (cause as { _tag: string })._tag
      : cause instanceof Error
        ? cause.name
        : undefined;
  const reason =
    cause !== null &&
    typeof cause === "object" &&
    "reason" in cause &&
    typeof (cause as { reason: unknown }).reason === "string"
      ? (cause as { reason: string }).reason
      : undefined;
  const message = cause instanceof Error ? cause.message : "VCS operation failed.";
  const label = tag === undefined ? "" : reason === undefined ? `${tag}: ` : `${tag}(${reason}): `;
  return failure(operation, `${label}${message}`.slice(0, 512));
};

const unsupported = (operation: string, kind: VcsDriverKind, detail: string) =>
  new VcsUnsupportedOperationError({ operation, kind, detail });

const grantDenied = (operation: string, grant: string) =>
  failure(operation, `VcsActionGrantDeniedError: grant '${grant}' is required.`);

const describeCause = (cause: Cause.Cause<unknown>): string => {
  const found = Cause.findErrorOption(cause);
  if (Option.isSome(found) && found.value instanceof Error) {
    const tag =
      "_tag" in found.value && typeof found.value._tag === "string" ? `${found.value._tag}: ` : "";
    return `${tag}${found.value.message}`.slice(0, 512);
  }
  return Cause.pretty(cause).slice(0, 512);
};

interface ActionSubscriber {
  readonly queue: ApiStreamEvent[];
  wake: (() => void) | null;
  overflowed: boolean;
}

interface ActionRecord {
  readonly actionId: string;
  /** The resolved workspace the action mutates — the progress stream binds to the same cwd. */
  readonly cwd: string;
  readonly events: VcsActionProgressEvent[];
  historyTruncated: boolean;
  /** True once `action_finished` or `action_failed` was appended — no second terminal. */
  terminated: boolean;
  /** True once the link/refresh tail settled (or the action failed) — the stream may end. */
  done: boolean;
  readonly startedAt: number;
  doneAt: number;
  readonly subscribers: Set<ActionSubscriber>;
}

interface ScopeDependencies {
  readonly environmentId: string;
  readonly projects: Parameters<typeof makeExtensionScopeResolver>[0]["projects"];
  readonly threads: Parameters<typeof makeExtensionScopeResolver>[0]["threads"];
}

interface VcsActionsApiDependencies extends ScopeDependencies {
  readonly vcsStatus: Pick<VcsStatusBroadcaster["Service"], "refreshStatus">;
  readonly gitWorkflow: Pick<
    GitWorkflowService["Service"],
    "runStackedAction" | "resolvePullRequest" | "preparePullRequestThread"
  >;
  readonly vcsRegistry: Pick<VcsDriverRegistry["Service"], "detect" | "resolve">;
  readonly sourceControlRepositories: Pick<
    SourceControlRepositoryService["Service"],
    "publishRepository"
  >;
  /** Only `dispatch` — the L1 link tail's sole engine seam. */
  readonly orchestrationEngine: Pick<OrchestrationEngine.OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQuery["Service"],
    "getThreadShellById" | "getProjectShellById"
  >;
  /**
   * The broker's per-caller authorize check, reachable by installation id —
   * the same late-bound wiring resourcesLeaseApi uses. The composite's pr
   * phase and publishRepository caller-chain-check `t3.prs/write` because a
   * declared `requiredGrants` cannot express "grant follows the input".
   */
  readonly authorizeGrant: (
    callerId: string,
    grant: string,
    context: ViewContext,
  ) => Promise<boolean>;
}

type Scope = Effect.Success<ReturnType<ReturnType<typeof makeExtensionScopeResolver>>>;
type MethodHandler = (call: {
  readonly input: unknown;
  readonly context: ViewContext;
  readonly signal: AbortSignal;
  readonly metadata: HostApiInvocationMetadata;
}) => Effect.Effect<Json, ExtensionOperationError>;

export function createVcsActionsApiProvider(
  dependencies: VcsActionsApiDependencies,
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  const authorized = (
    principal: HostApiPrincipal | undefined,
    scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  ) =>
    principal !== undefined &&
    principal.environmentId === dependencies.environmentId &&
    principal.scopes.includes(scope);

  /** Capability gate for git-only operations — undetected or non-git drivers fail by name. */
  const requireGit = Effect.fn("VcsActionsApi.requireGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* dependencies.vcsRegistry
      .resolve({ cwd })
      .pipe(Effect.mapError(operationError(operation)));
    if (handle.kind !== "git") {
      return yield* unsupported(
        operation,
        handle.kind,
        `The ${operation} operation currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
    return handle;
  });

  /** Mirrors ws.ts `refreshGitStatus`: detached so callers never wait on it. */
  const refreshAfterMutation = (cwd: string) =>
    dependencies.vcsStatus
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  /**
   * Every caller in the chain must hold the grant — the broker's
   * `requiredGrants` loop mirrored for the input-dependent `t3.prs/write`
   * check (G3/P-a). A thrown check is a host fault, not a missing grant.
   */
  const requireChainGrant = (
    operation: string,
    grant: string,
    context: ViewContext,
    metadata: HostApiInvocationMetadata,
  ): Effect.Effect<void, ExtensionOperationError> =>
    Effect.tryPromise({
      try: async () => {
        const callerIds = new Set([
          metadata.callerId,
          ...metadata.callerGenerations.map((entry) => entry.pluginId),
        ]);
        for (const callerId of callerIds) {
          if (!(await dependencies.authorizeGrant(callerId, grant, context))) return false;
        }
        return true;
      },
      catch: () =>
        failure(operation, `VcsActionGrantCheckError: could not evaluate grant '${grant}'.`),
    }).pipe(
      Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(grantDenied(operation, grant)))),
    );

  const actions = new Map<string, ActionRecord>();

  const pruneActions = (now = performance.now()) => {
    for (const [actionId, record] of actions) {
      if (
        (record.done && now - record.doneAt > TERMINAL_RETENTION_MS) ||
        now - record.startedAt > MAX_ACTION_AGE_MS
      ) {
        record.done = true;
        record.terminated = true;
        for (const subscriber of record.subscribers) {
          subscriber.overflowed = true;
          subscriber.wake?.();
          subscriber.wake = null;
        }
        actions.delete(actionId);
      }
    }
  };

  const appendEvent = (record: ActionRecord, event: VcsActionProgressEvent) => {
    record.events.push(event);
    if (record.events.length > MAX_HISTORY_EVENTS) {
      record.events.shift();
      record.historyTruncated = true;
    }
    if (event.kind === "action_finished" || event.kind === "action_failed") {
      record.terminated = true;
    }
    for (const subscriber of record.subscribers) {
      if (subscriber.queue.length >= MAX_QUEUED_EVENTS) {
        subscriber.overflowed = true;
      } else {
        subscriber.queue.push({ type: "data", value: event });
      }
      subscriber.wake?.();
      subscriber.wake = null;
    }
  };

  const markDone = (record: ActionRecord) => {
    record.done = true;
    record.doneAt = performance.now();
    for (const subscriber of record.subscribers) {
      subscriber.wake?.();
      subscriber.wake = null;
    }
  };

  /**
   * P1 success provenance: the committed message is `caller` only when the
   * caller supplied a non-blank commitMessage (blank keeps native
   * auto-generate), and a created PR's text is composite-`generated` while
   * `opened_existing` is somebody's existing words. Not a durable marker —
   * partial-failure provenance is named by the `action_failed` phase instead.
   */
  const annotateResult = (
    result: GitRunStackedActionResult,
    callerSuppliedMessage: boolean,
  ): VcsActionResult => ({
    action: result.action,
    branch: {
      status: result.branch.status,
      ...(result.branch.name === undefined ? {} : { name: result.branch.name }),
    },
    commit: {
      status: result.commit.status,
      ...(result.commit.commitSha === undefined ? {} : { commitSha: result.commit.commitSha }),
      ...(result.commit.subject === undefined ? {} : { subject: result.commit.subject }),
      messageSource:
        result.commit.status === "created"
          ? callerSuppliedMessage
            ? "caller"
            : "generated"
          : "not_applicable",
    },
    push: {
      status: result.push.status,
      ...(result.push.branch === undefined ? {} : { branch: result.push.branch }),
      ...(result.push.upstreamBranch === undefined
        ? {}
        : { upstreamBranch: result.push.upstreamBranch }),
      ...(result.push.setUpstream === undefined ? {} : { setUpstream: result.push.setUpstream }),
    },
    pr: {
      status: result.pr.status,
      ...(result.pr.url === undefined ? {} : { url: result.pr.url }),
      ...(result.pr.number === undefined ? {} : { number: result.pr.number }),
      ...(result.pr.baseBranch === undefined ? {} : { baseBranch: result.pr.baseBranch }),
      ...(result.pr.headBranch === undefined ? {} : { headBranch: result.pr.headBranch }),
      ...(result.pr.title === undefined ? {} : { title: result.pr.title }),
      contentSource:
        result.pr.status === "created"
          ? "generated"
          : result.pr.status === "opened_existing"
            ? "existing"
            : "not_applicable",
    },
    toast: {
      title: result.toast.title,
      ...(result.toast.description === undefined ? {} : { description: result.toast.description }),
      cta:
        result.toast.cta.kind === "none"
          ? { kind: "none" }
          : result.toast.cta.kind === "open_pr"
            ? { kind: "open_pr", label: result.toast.cta.label, url: result.toast.cta.url }
            : {
                kind: "run_action",
                label: result.toast.cta.label,
                action: { kind: result.toast.cta.action.kind },
              },
    },
  });

  const toPublicProgressEvent = (
    event: GitActionProgressEvent,
    callerSuppliedMessage: boolean,
  ): VcsActionProgressEvent => {
    switch (event.kind) {
      case "action_started":
        return { kind: "action_started", action: event.action, phases: event.phases };
      case "phase_started":
        return {
          kind: "phase_started",
          action: event.action,
          phase: event.phase,
          label: event.label,
        };
      case "hook_started":
        return { kind: "hook_started", action: event.action, hookName: event.hookName };
      case "hook_output":
        return {
          kind: "hook_output",
          action: event.action,
          hookName: event.hookName,
          stream: event.stream,
          text: event.text,
        };
      case "hook_finished":
        return {
          kind: "hook_finished",
          action: event.action,
          hookName: event.hookName,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
        };
      case "action_finished":
        return {
          kind: "action_finished",
          action: event.action,
          result: annotateResult(event.result, callerSuppliedMessage),
        };
      case "action_failed":
        return {
          kind: "action_failed",
          action: event.action,
          phase: event.phase,
          message: event.message,
        };
    }
  };

  const runMethod = <Input, Output extends Json>(args: {
    readonly operation: string;
    readonly requiredScope:
      | typeof AuthOrchestrationReadScope
      | typeof AuthOrchestrationOperateScope;
    readonly decode: (input: unknown) => Input;
    readonly run: (
      safe: Input,
      scope: Scope,
      call: {
        readonly context: ViewContext;
        readonly metadata: HostApiInvocationMetadata;
      },
    ) => Effect.Effect<Output, Error>;
    readonly refreshAfter?: boolean;
    /** Input-dependent grant every caller in the chain must hold — checked pre and post. */
    readonly chainGrant?: string;
  }): MethodHandler =>
    Effect.fn("VcsActionsApi.invoke")(function* ({ input, context, signal, metadata }) {
      signal.throwIfAborted();
      if (!authorized(metadata.principal, args.requiredScope)) {
        return yield* failure(args.operation, "VCS authority is unavailable.");
      }
      const safe = yield* Effect.try({
        try: () => args.decode(input),
        catch: () => failure(args.operation, "Invalid VCS request input."),
      });
      const scope = yield* resolve(context);
      if (args.chainGrant !== undefined) {
        yield* requireChainGrant(args.operation, args.chainGrant, context, metadata);
      }
      const result = yield* args
        .run(safe, scope, { context, metadata })
        .pipe(Effect.mapError(operationError(args.operation)));
      if (args.refreshAfter) yield* refreshAfterMutation(scope.cwd);
      yield* Effect.tryPromise({
        try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
        catch: () => failure(args.operation, "VCS authority was revoked."),
      });
      if (args.chainGrant !== undefined) {
        yield* requireChainGrant(args.operation, args.chainGrant, context, metadata);
      }
      yield* resolve(scope.context);
      signal.throwIfAborted();
      return result;
    });

  const invokeProvider =
    (operations: Record<string, MethodHandler>) =>
    (
      method: string,
      input: unknown,
      context: ViewContext,
      signal: AbortSignal,
      metadata: HostApiInvocationMetadata,
    ) => {
      const handler = operations[method];
      if (!handler)
        return Effect.runPromise(
          Effect.fail(failure(`vcs.actions.${method}`, "VCS API method is unavailable.")),
          { signal },
        );
      return Effect.runPromise(handler({ input, context, signal, metadata }), { signal });
    };

  const withinResolvedPrBounds = (pullRequest: {
    readonly title: string;
    readonly url: string;
    readonly baseBranch: string;
    readonly headBranch: string;
  }) =>
    pullRequest.title.length <= MAX_PR_TITLE &&
    pullRequest.url.length <= MAX_PR_URL &&
    pullRequest.baseBranch.length <= MAX_BRANCH_NAME &&
    pullRequest.headBranch.length <= MAX_BRANCH_NAME;

  const toResolvedPullRequest = (
    operation: string,
    result: {
      readonly pullRequest: {
        readonly number: number;
        readonly title: string;
        readonly url: string;
        readonly baseBranch: string;
        readonly headBranch: string;
        readonly state: "open" | "closed" | "merged";
      };
    },
  ) => {
    if (!withinResolvedPrBounds(result.pullRequest)) {
      return Effect.fail(
        failure(operation, "The resolved pull request exceeds the public bounds."),
      );
    }
    return Effect.succeed({
      pullRequest: result.pullRequest,
    } satisfies VcsActionResolvePullRequestResult);
  };

  return {
    providerId: "t3.host-vcs-actions",
    definition: VCS_ACTIONS_API,
    requiresRootAuthority: true,
    invoke: invokeProvider({
      getCapabilities: runMethod({
        operation: "vcs.actions.getCapabilities",
        requiredScope: AuthOrchestrationReadScope,
        decode: emptyInput,
        run: (_safe, scope) =>
          dependencies.vcsRegistry.detect({ cwd: scope.cwd }).pipe(
            Effect.map((handle): VcsActionsCapabilitiesResult => {
              const git = handle?.kind === "git";
              const operations: VcsActionsOperationsSupport = {
                "actions.run": git,
                "actions.resolvePullRequest": git,
                "actions.preparePullRequestThread": git,
                "actions.publishRepository": git,
                "actions.actionProgress": git,
              };
              return handle === null
                ? { detected: false, kind: null, detail: null, driver: null, operations }
                : {
                    detected: true,
                    kind: handle.kind,
                    detail: null,
                    driver: handle.driver.capabilities,
                    operations,
                  };
            }),
            Effect.catch((cause) =>
              Effect.succeed({
                detected: false,
                kind: null,
                detail: (cause instanceof Error ? cause.message : "VCS detection failed.").slice(
                  0,
                  512,
                ),
                driver: null,
                operations: {
                  "actions.run": false,
                  "actions.resolvePullRequest": false,
                  "actions.preparePullRequestThread": false,
                  "actions.publishRepository": false,
                  "actions.actionProgress": false,
                },
              } satisfies VcsActionsCapabilitiesResult),
            ),
          ),
      }),
      run: runMethod({
        operation: "vcs.actions.run",
        requiredScope: AuthOrchestrationOperateScope,
        decode: runInput,
        run: Effect.fn("vcs.actions.run")(function* (safe, scope, { context, metadata }) {
          yield* requireGit("vcs.actions.run", scope.cwd);
          // The composite creates host objects when a PR is in the plan —
          // `mutate` alone must not reach `createChangeRequest`.
          const createsPr = safe.action === "create_pr" || safe.action === "commit_push_pr";
          if (createsPr) {
            yield* requireChainGrant("vcs.actions.run", PRS_WRITE, context, metadata);
          }
          pruneActions();
          const live = [...actions.values()].filter((record) => !record.done).length;
          if (live >= MAX_LIVE_ACTIONS) {
            return yield* failure("vcs.actions.run", "Too many VCS actions are already in flight.");
          }
          const actionId = NodeCrypto.randomUUID();
          // Blank keeps the native leave-blank auto-generate semantics; the
          // composite writes the message from server-side settings.
          const commitMessage = safe.commitMessage?.trim() ? safe.commitMessage : undefined;
          const callerSuppliedMessage = commitMessage !== undefined;
          const threadId = scope.context.resource.threadId;
          const record: ActionRecord = {
            actionId,
            cwd: scope.cwd,
            events: [],
            historyTruncated: false,
            terminated: false,
            done: false,
            startedAt: performance.now(),
            doneAt: 0,
            subscribers: new Set(),
          };
          actions.set(actionId, record);
          const reporter: GitActionProgressReporter = {
            publish: (event) =>
              Effect.sync(() =>
                appendEvent(record, toPublicProgressEvent(event, callerSuppliedMessage)),
              ),
          };
          /**
           * L1 tail — mirrors the ws.ts wrapper: after the service returns,
           * link a created pull request to the resolved scope's own thread
           * and refresh status, in that order. `action_finished` reached
           * subscribers before this settles, exactly like the native RPC.
           */
          const linkAndRefresh = (result: GitRunStackedActionResult) =>
            (threadId === undefined
              ? Effect.void
              : linkCreatedPullRequest({
                  threadId: ThreadId.make(threadId),
                  result,
                  commandId: Effect.sync(() =>
                    CommandId.make(`server:pr-created-link:${NodeCrypto.randomUUID()}`),
                  ),
                }).pipe(
                  Effect.provideService(
                    OrchestrationEngine.OrchestrationEngineService,
                    dependencies.orchestrationEngine,
                  ),
                  Effect.provideService(
                    ProjectionSnapshotQuery,
                    dependencies.projectionSnapshotQuery,
                  ),
                )
            ).pipe(Effect.andThen(refreshAfterMutation(scope.cwd)));
          /**
           * The fiber re-proves authority before the first remote write:
           * the method returns `actionId` immediately, so this preflight is
           * the check that actually precedes the mutation. Anything denied
           * here lands as a named `action_failed`, never a silent action.
           */
          const preflight = Effect.tryPromise({
            try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
            catch: () =>
              failure("vcs.actions.run", "VCS authority was revoked before the action ran."),
          }).pipe(
            Effect.andThen(
              createsPr
                ? requireChainGrant("vcs.actions.run", PRS_WRITE, context, metadata)
                : Effect.void,
            ),
            Effect.andThen(resolve(scope.context)),
            Effect.asVoid,
          );
          /**
           * Post-service recheck — the broker's invoke post-check wraps
           * only the early `actionId` return, so the detached fiber itself
           * re-runs authority + the full caller-chain grant check + scope
           * re-resolve once native work completes (the resourcesLease
           * precedent's post half). A denial lands AFTER the phase
           * terminal as `closed{authorization-revoked}` — git effects
           * already persisted, so the event names the check that failed
           * rather than a phase — and the link/refresh tail is skipped:
           * revoked authority does not get to keep mutating.
           */
          const postCheck = Effect.tryPromise({
            try: () => metadata.assertAuthority?.() ?? Promise.resolve(),
            catch: () =>
              failure("vcs.actions.run", "VCS authority was revoked after the action ran."),
          }).pipe(
            Effect.andThen(
              createsPr
                ? requireChainGrant("vcs.actions.run", PRS_WRITE, context, metadata)
                : Effect.void,
            ),
            Effect.andThen(resolve(scope.context)),
            Effect.asVoid,
          );
          const work = preflight.pipe(
            Effect.andThen(
              dependencies.gitWorkflow.runStackedAction(
                {
                  actionId,
                  cwd: scope.cwd,
                  action: safe.action,
                  ...(commitMessage === undefined ? {} : { commitMessage }),
                  ...(safe.featureBranch === undefined
                    ? {}
                    : { featureBranch: safe.featureBranch }),
                  ...(safe.paths === undefined ? {} : { filePaths: safe.paths }),
                  ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
                },
                { actionId, progressReporter: reporter },
              ),
            ),
            Effect.matchCauseEffect({
              onFailure: (cause) =>
                Effect.sync(() => {
                  // The composite names its own phase on failure; only a
                  // preflight failure (or a defect before it started) needs
                  // the terminal appended here.
                  if (!record.terminated) {
                    appendEvent(record, {
                      kind: "action_failed",
                      action: safe.action,
                      phase: null,
                      message: describeCause(cause),
                    });
                  }
                  markDone(record);
                }),
              onSuccess: (result) =>
                postCheck.pipe(
                  Effect.matchCauseEffect({
                    onFailure: () =>
                      Effect.sync(() => {
                        appendEvent(record, {
                          kind: "closed",
                          reason: "authorization-revoked",
                        });
                        markDone(record);
                      }),
                    onSuccess: () =>
                      linkAndRefresh(result).pipe(
                        Effect.ensuring(Effect.sync(() => markDone(record))),
                      ),
                  }),
                ),
            }),
          );
          yield* Effect.forkDetach(work);
          return { actionId } satisfies VcsActionRunResult;
        }),
      }),
      resolvePullRequest: runMethod({
        operation: "vcs.actions.resolvePullRequest",
        // Read-shaped but Operate-gated: it shells the provider CLI.
        requiredScope: AuthOrchestrationOperateScope,
        decode: referenceInput,
        run: Effect.fn("vcs.actions.resolvePullRequest")(function* (safe, scope) {
          yield* requireGit("vcs.actions.resolvePullRequest", scope.cwd);
          const result = yield* dependencies.gitWorkflow.resolvePullRequest({
            cwd: scope.cwd,
            reference: safe.reference,
          });
          return yield* toResolvedPullRequest("vcs.actions.resolvePullRequest", result);
        }),
      }),
      preparePullRequestThread: runMethod({
        operation: "vcs.actions.preparePullRequestThread",
        requiredScope: AuthOrchestrationOperateScope,
        decode: prepareInput,
        refreshAfter: true,
        run: Effect.fn("vcs.actions.preparePullRequestThread")(function* (safe, scope) {
          yield* requireGit("vcs.actions.preparePullRequestThread", scope.cwd);
          const threadId = scope.context.resource.threadId;
          const result = yield* dependencies.gitWorkflow.preparePullRequestThread({
            cwd: scope.cwd,
            reference: safe.reference,
            mode: safe.mode,
            ...(threadId === undefined ? {} : { threadId: ThreadId.make(threadId) }),
          });
          if (
            !withinResolvedPrBounds(result.pullRequest) ||
            result.branch.length > MAX_BRANCH_NAME ||
            (result.worktreePath !== null && result.worktreePath.length > MAX_WORKTREE_PATH)
          ) {
            return yield* failure(
              "vcs.actions.preparePullRequestThread",
              "The prepared pull request exceeds the public bounds.",
            );
          }
          return result satisfies VcsActionPrepareThreadResult;
        }),
      }),
      publishRepository: runMethod({
        operation: "vcs.actions.publishRepository",
        requiredScope: AuthOrchestrationOperateScope,
        decode: publishInput,
        refreshAfter: true,
        // P-a under G3: publish pushes to a host repo it creates — conjunctive
        // `t3.prs/write` on every caller, so a comment-only grant never
        // reaches pushCurrentBranch.
        chainGrant: PRS_WRITE,
        run: Effect.fn("vcs.actions.publishRepository")(function* (safe, scope) {
          yield* requireGit("vcs.actions.publishRepository", scope.cwd);
          if (safe.provider === "unknown") {
            return yield* new PullRequestUnavailableError({
              reason: "provider-unsupported",
            });
          }
          const result = yield* dependencies.sourceControlRepositories.publishRepository({
            cwd: scope.cwd,
            provider: safe.provider,
            repository: safe.repository,
            visibility: safe.visibility,
            ...(safe.remoteName === undefined ? {} : { remoteName: safe.remoteName }),
            ...(safe.protocol === undefined ? {} : { protocol: safe.protocol }),
          });
          return {
            repository: result.repository,
            remoteName: result.remoteName,
            remoteUrl: result.remoteUrl,
            branch: result.branch,
            ...(result.upstreamBranch === undefined
              ? {}
              : { upstreamBranch: result.upstreamBranch }),
            status: result.status,
          } satisfies VcsActionPublishResult;
        }),
      }),
    }),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "actionProgress")
        throw failure("vcs.actions.actionProgress", "VCS action stream is unavailable.");
      if (resumeCursor !== undefined)
        throw failure(
          "vcs.actions.actionProgress",
          "VCS action progress stream resume is unsupported.",
        );
      let safe: { readonly actionId: string };
      try {
        safe = progressInput(input);
      } catch {
        throw failure("vcs.actions.actionProgress", "Invalid VCS action progress request.");
      }
      if (!authorized(metadata.principal, AuthOrchestrationReadScope))
        throw failure("vcs.actions.actionProgress", "VCS authority is unavailable.");
      pruneActions();
      const record = actions.get(safe.actionId);
      if (record === undefined)
        throw failure("vcs.actions.actionProgress", "The VCS action is unavailable.");

      let finished = false;
      let aborted = signal.aborted;
      let cleanup: (() => void) | null = null;
      let setup: Promise<void> | null = null;
      let setupFailure: unknown = null;
      const controller = new AbortController();
      const runSignal = AbortSignal.any([signal, controller.signal]);
      let removeAbortListener: (() => void) | null = null;
      const subscriber: ActionSubscriber = { queue: [], wake: null, overflowed: false };

      const finish = () => {
        finished = true;
        cleanup?.();
        cleanup = null;
        removeAbortListener?.();
        removeAbortListener = null;
        record.subscribers.delete(subscriber);
        // A next() parked on `subscriber.wake` must settle on cancel — the
        // broker abandons the call, which would mask a read that never
        // resolves.
        subscriber.wake?.();
        subscriber.wake = null;
      };
      const abort = () => {
        aborted = true;
        controller.abort();
        finish();
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abort);

      const iterable: AsyncIterable<ApiStreamEvent> = {
        [Symbol.asyncIterator]() {
          let returned = false;
          const failIfAborted = () => {
            if (aborted)
              throw runSignal.reason ?? failure("vcs.actions.actionProgress", "Stream cancelled.");
          };
          const finishIterator = async () => {
            controller.abort();
            finish();
          };
          return {
            async next() {
              if (returned) return { done: true, value: undefined };
              failIfAborted();
              setup ??= (async () => {
                try {
                  /**
                   * The subscriber must resolve to the workspace the action
                   * mutates — a read-granted caller on another project must
                   * not tail this project's action log. Same denial name as
                   * an unknown id so it is not an existence oracle.
                   */
                  const scope = await Effect.runPromise(resolve(context), {
                    signal: runSignal,
                  });
                  if (scope.cwd !== record.cwd) {
                    throw failure("vcs.actions.actionProgress", "The VCS action is unavailable.");
                  }
                  await metadata.assertAuthority?.();
                  if (record.historyTruncated) {
                    subscriber.queue.push({
                      type: "closed",
                      value: {
                        kind: "closed",
                        reason: "overflow",
                      } satisfies VcsActionProgressEvent,
                    });
                    finish();
                    return;
                  }
                  // Register before replaying so nothing is missed: events
                  // appended after `historyLength` arrive through the live
                  // queue, and publish is atomic with the history append.
                  const historyLength = record.events.length;
                  record.subscribers.add(subscriber);
                  for (const event of record.events.slice(0, historyLength)) {
                    subscriber.queue.push({ type: "data", value: event });
                  }
                  subscriber.wake?.();
                  subscriber.wake = null;
                  if (record.done) finish();
                } catch (error) {
                  setupFailure = error;
                  finish();
                  throw error;
                }
              })();
              try {
                await setup;
                if (setupFailure !== null) throw setupFailure;
                failIfAborted();
                // The publisher may finish this observer while next() waits,
                // and `markDone` wakes without setting `finished` — the loop
                // must re-check `record.done` so a completed action ends the
                // stream for subscribers already attached.
                // eslint-disable-next-line no-unmodified-loop-condition
                while (subscriber.queue.length === 0 && !finished && !record.done) {
                  await new Promise<void>((resolveWait) => {
                    subscriber.wake = resolveWait;
                  });
                  failIfAborted();
                }
                failIfAborted();
                if (subscriber.overflowed && subscriber.queue.length === 0) {
                  subscriber.queue.push({
                    type: "closed",
                    value: { kind: "closed", reason: "overflow" } satisfies VcsActionProgressEvent,
                  });
                }
                const value = subscriber.queue.shift();
                if (!value) {
                  await finishIterator();
                  returned = true;
                  return { done: true, value: undefined };
                }
                if (value.type === "closed") {
                  await finishIterator();
                  returned = true;
                  return { done: false, value };
                }
                return { done: false, value };
              } catch (error) {
                await finishIterator();
                returned = true;
                throw error;
              }
            },
            async return() {
              returned = true;
              abort();
              await finishIterator();
              return { done: true, value: undefined };
            },
          };
        },
      };
      return iterable;
    },
  };
}

export const makeVcsActionsApiProvider = Effect.fn("VcsActionsApi.make")(function* (
  authorizeGrant: VcsActionsApiDependencies["authorizeGrant"],
) {
  const environment = yield* ServerEnvironment;
  return createVcsActionsApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    vcsStatus: yield* VcsStatusBroadcaster,
    gitWorkflow: yield* GitWorkflowService,
    vcsRegistry: yield* VcsDriverRegistry,
    sourceControlRepositories: yield* SourceControlRepositoryService,
    orchestrationEngine: yield* OrchestrationEngine.OrchestrationEngineService,
    projectionSnapshotQuery: yield* ProjectionSnapshotQuery,
    authorizeGrant,
  });
});
