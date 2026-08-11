import {
  AgentProfileInvalidError,
  AgentProfileId,
  AgentProfileNotFoundError,
  AgentRunId,
  AgentRunInvalidStateError,
  AgentRunNotFoundError,
  CommandId,
  MessageId,
  ThreadId,
  type AgentMcpResultEntry,
  type AgentProfileBudgets,
  type AgentProfileDocument,
  type AgentProfileLocator,
  type AgentProfileRef,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveAgentRuntimeCompatibility } from "../provider/AgentRuntimeCompatibility.ts";
import * as AgentCatalog from "./AgentCatalog.ts";
import * as AgentHookRunner from "./AgentHookRunner.ts";
import { AgentOrchestration } from "./AgentOrchestration.ts";
import { compileAgentPrompt } from "./prompt/PromptCompiler.ts";
import * as AgentRunDomain from "./run/AgentRun.ts";
import {
  appendAgentRunTaskActivity,
  cancelledAgentRunRevision,
  failedAgentRunRevision,
  revisionAfterAgentRunTransition,
} from "./run/AgentRunReactor.ts";
import * as AgentRunRepository from "./run/AgentRunRepository.ts";

const invalid = (
  detail: string,
  context?: {
    readonly operation?: string;
    readonly cause?: unknown;
    readonly profileId?: AgentProfileId;
    readonly runId?: AgentRunId;
  },
) =>
  new AgentProfileInvalidError({
    detail: detail.slice(0, 4_000),
    operation: context?.operation ?? "agent-orchestration",
    ...(context?.profileId === undefined ? {} : { profileId: context.profileId }),
    ...(context?.runId === undefined ? {} : { runId: context.runId }),
    ...(context?.cause === undefined ? {} : { cause: context.cause }),
  });

export const minimumBudgets = (
  child: AgentProfileBudgets,
  parent: AgentProfileBudgets,
): AgentProfileBudgets => ({
  maxRuns: Math.min(child.maxRuns, parent.maxRuns),
  maxConcurrency: Math.min(child.maxConcurrency, parent.maxConcurrency),
  maxDepth: Math.min(child.maxDepth, parent.maxDepth),
  maxWallTimeMinutes: Math.min(child.maxWallTimeMinutes, parent.maxWallTimeMinutes),
  ...(child.maxTotalTokens === undefined && parent.maxTotalTokens === undefined
    ? {}
    : {
        maxTotalTokens: Math.min(
          child.maxTotalTokens ?? Number.MAX_SAFE_INTEGER,
          parent.maxTotalTokens ?? Number.MAX_SAFE_INTEGER,
        ),
      }),
  ...(child.maxEstimatedCostUsd === undefined && parent.maxEstimatedCostUsd === undefined
    ? {}
    : {
        maxEstimatedCostUsd: Math.min(
          child.maxEstimatedCostUsd ?? Number.MAX_SAFE_INTEGER,
          parent.maxEstimatedCostUsd ?? Number.MAX_SAFE_INTEGER,
        ),
      }),
});

export const runtimeSettingsForAgentProfile = (profile: AgentProfileDocument) => {
  const runtimeMode = (() => {
    switch (profile.workspace.access) {
      case "read-only":
        return "approval-required" as const;
      case "workspace-write":
        return profile.runtime.mode === "full-access" ? "auto-accept-edits" : profile.runtime.mode;
      case "full-access":
        return profile.runtime.mode;
    }
  })();
  return { runtimeMode, interactionMode: profile.runtime.interactionMode };
};

export const resolvePinnedAgentRuntimeSettings = Effect.fn(
  "AgentOrchestration.resolvePinnedAgentRuntimeSettings",
)(function* (input: {
  readonly repository: Pick<AgentRunRepository.AgentRunRepository["Service"], "getProfileSnapshot">;
  readonly run: Pick<AgentRunDomain.AgentRun, "id" | "profile">;
}) {
  const profile = yield* input.repository.getProfileSnapshot(input.run.profile.revision).pipe(
    Effect.mapError((cause) =>
      invalid("Could not load the pinned Agent profile for the follow-up turn.", {
        operation: "follow-up-profile-load",
        cause,
        profileId: input.run.profile.id,
        runId: input.run.id,
      }),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            invalid("The pinned Agent profile is unavailable for the follow-up turn.", {
              operation: "follow-up-profile-load",
              profileId: input.run.profile.id,
              runId: input.run.id,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
  return runtimeSettingsForAgentProfile(profile);
});

/**
 * Allocates both turn identifiers before recording the follow-up transition.
 * That keeps a UUID failure from leaving a successful run queued without a
 * corresponding provider turn.
 */
export const requestAgentFollowUp = Effect.fn("AgentOrchestration.requestAgentFollowUp")(
  function* (input: {
    readonly crypto: Pick<Crypto.Crypto, "randomUUIDv4">;
    readonly repository: Pick<AgentRunRepository.AgentRunRepository["Service"], "dispatch">;
    readonly runId: AgentRunId;
    readonly message: string;
    readonly occurredAt: string;
  }) {
    const commandId = CommandId.make(
      `agent-send:${yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          invalid("Could not allocate an Agent command id.", {
            operation: "follow-up-command-id-allocate",
            cause,
            runId: input.runId,
          }),
        ),
      )}`,
    );
    const messageId = MessageId.make(
      `agent:${yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          invalid("Could not allocate an Agent message id.", {
            operation: "follow-up-message-id-allocate",
            cause,
            runId: input.runId,
          }),
        ),
      )}`,
    );
    const events = yield* input.repository
      .dispatch({
        type: "agent-run.follow-up",
        runId: input.runId,
        message: input.message,
        occurredAt: input.occurredAt,
      })
      .pipe(
        Effect.mapError((error) =>
          invalid(error.message, {
            operation: "run-follow-up",
            cause: error,
            runId: input.runId,
          }),
        ),
      );
    const followUp = events.find(
      (event) => event.type === "agent-run.follow-up-revised" && event.runId === input.runId,
    );
    if (followUp === undefined) {
      return yield* invalid("The Agent follow-up transition did not persist.", {
        operation: "run-follow-up",
        runId: input.runId,
      });
    }
    return { commandId, messageId, revision: followUp.revision };
  },
);

type ThreadCreateCommand = Extract<OrchestrationCommand, { readonly type: "thread.create" }>;
type ThreadTurnStartCommand = Extract<OrchestrationCommand, { readonly type: "thread.turn.start" }>;

/**
 * Keeps the child lifecycle ordering explicit for server-side callers. The
 * WebSocket transport expands turn bootstrap metadata before dispatch; MCP
 * tools call orchestration directly and therefore must create the thread
 * before the decider can accept its first turn.
 */
export const dispatchAgentChildLifecycle = Effect.fn(
  "AgentOrchestration.dispatchAgentChildLifecycle",
)(function* (input: {
  readonly engine: Pick<OrchestrationEngine.OrchestrationEngineShape, "dispatch">;
  readonly createThread: ThreadCreateCommand;
  readonly prepareThread: Effect.Effect<void, AgentProfileInvalidError>;
  readonly markRunStarted: Effect.Effect<void, AgentProfileInvalidError>;
  readonly startTurn: ThreadTurnStartCommand;
}) {
  yield* input.engine.dispatch(input.createThread).pipe(
    Effect.mapError((error) =>
      invalid(`T3 could not create the child Agent thread: ${error.message}`, {
        operation: "child-thread-create",
        cause: error,
      }),
    ),
  );
  yield* input.prepareThread;
  yield* input.markRunStarted;
  return yield* input.engine.dispatch(input.startTurn).pipe(
    Effect.mapError((error) =>
      invalid(`T3 could not start the child Agent thread: ${error.message}`, {
        operation: "child-turn-start",
        cause: error,
      }),
    ),
  );
});

/** Starts the durable follow-up revision before handing it to the provider. */
export const dispatchAgentFollowUpLifecycle = Effect.fn(
  "AgentOrchestration.dispatchAgentFollowUpLifecycle",
)(function* (input: {
  readonly engine: Pick<OrchestrationEngine.OrchestrationEngineShape, "dispatch">;
  readonly markRunStarted: Effect.Effect<
    ReadonlyArray<AgentRunDomain.AgentRunEvent>,
    AgentProfileInvalidError
  >;
  readonly startTurn: ThreadTurnStartCommand;
}) {
  const started = yield* input.markRunStarted;
  const dispatch = yield* input.engine.dispatch(input.startTurn).pipe(
    Effect.mapError((error) =>
      invalid(`T3 could not start the Agent follow-up turn: ${error.message}`, {
        operation: "follow-up-turn-dispatch",
        cause: error,
      }),
    ),
  );
  return { started, dispatch };
});

export const agentWorktreeBranchName = (runId: AgentRunId): string => `t3code/agent-${runId}`;

export const requireAgentResultThread = <A>(
  thread: Option.Option<A>,
  runId: AgentRunId,
): Effect.Effect<A, AgentProfileInvalidError> =>
  Option.match(thread, {
    onNone: () =>
      Effect.fail(
        invalid("The child Agent thread is unavailable; its result cannot be read.", {
          operation: "child-thread-read",
          runId,
        }),
      ),
    onSome: Effect.succeed,
  });

export const liveAgentProfileLocator = (profile: AgentProfileRef): AgentProfileLocator => ({
  id: profile.id,
  scope: profile.scope,
});

const MAX_INTEGRATION_PATCH_BYTES = 32 * 1024 * 1024;

const gitFailureDetail = (
  operation: string,
  result: Pick<
    ProcessRunner.ProcessRunOutput,
    "code" | "timedOut" | "stdoutTruncated" | "stderrTruncated"
  >,
) => {
  if (result.timedOut) return `${operation} timed out.`;
  if (result.stdoutTruncated || result.stderrTruncated)
    return `${operation} failed because Git output exceeded the safety limit.`;
  if (result.code === null) return `${operation} failed without an exit code.`;
  return `${operation} failed (exit code ${result.code}).`;
};

/**
 * Removes only the exact worktree and branch allocated for a failed isolated
 * run. Cleanup is best-effort so it cannot hide the original spawn failure.
 */
export const cleanupCreatedAgentWorktree = Effect.fn(
  "AgentOrchestration.cleanupCreatedAgentWorktree",
)(function* (input: {
  readonly gitWorkflow: Pick<GitWorkflowService.GitWorkflowService["Service"], "removeWorktree">;
  readonly processRunner: Pick<ProcessRunner.ProcessRunner["Service"], "run">;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
}) {
  yield* input.gitWorkflow
    .removeWorktree({ cwd: input.workspaceRoot, path: input.worktreePath, force: true })
    .pipe(
      Effect.andThen(
        input.processRunner.run({
          command: "git",
          args: ["branch", "--delete", "--force", input.branch],
          cwd: input.workspaceRoot,
          timeout: "30 seconds",
          maxOutputBytes: 32 * 1024,
          outputMode: "error",
        }),
      ),
      Effect.ignore,
    );
});

/**
 * Transfers tracked changes between two worktrees of the same repository.
 * Untracked files are deliberately refused: copying them would turn a failed
 * conflict check into a partial handoff.
 */
export const applyIsolatedWorktreePatch = Effect.fn(
  "AgentOrchestration.applyIsolatedWorktreePatch",
)(function* (input: {
  readonly sourceWorktreePath: string;
  readonly targetWorktreePath: string;
  /** Only a durably integrating run may accept its exact patch on a dirty target. */
  readonly allowAlreadyApplied?: boolean;
}): Effect.fn.Return<
  void,
  AgentProfileInvalidError,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const canonical = (candidate: string, label: string) =>
    fileSystem.realPath(candidate).pipe(
      Effect.mapError((cause) =>
        invalid(`${label} is no longer available.`, {
          operation: "integration-path-resolve",
          cause,
        }),
      ),
    );
  const runGit = (cwd: string, args: ReadonlyArray<string>, operation: string, stdin?: string) =>
    processRunner
      .run({
        command: "git",
        args,
        cwd,
        ...(stdin === undefined ? {} : { stdin }),
        timeout: "60 seconds",
        maxOutputBytes: MAX_INTEGRATION_PATCH_BYTES,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError((cause) =>
          invalid(`${operation} could not start.`, { operation: "git-command", cause }),
        ),
        Effect.flatMap((result) => {
          if (
            result.code === 0 &&
            !result.timedOut &&
            !result.stdoutTruncated &&
            !result.stderrTruncated
          ) {
            return Effect.succeed(result.stdout);
          }
          return Effect.fail(
            invalid(gitFailureDetail(operation, result), {
              operation: "git-command",
              cause: result,
            }),
          );
        }),
      );
  const gitTopLevel = (cwd: string) =>
    runGit(cwd, ["rev-parse", "--show-toplevel"], "Git worktree validation").pipe(
      Effect.flatMap((output) => canonical(output.trim(), "Git worktree")),
    );
  const gitCommonDirectory = (cwd: string) =>
    runGit(cwd, ["rev-parse", "--git-common-dir"], "Git worktree validation").pipe(
      Effect.flatMap((output) =>
        canonical(path.resolve(cwd, output.trim()), "Git metadata directory"),
      ),
    );

  const sourceWorktreePath = yield* canonical(input.sourceWorktreePath, "Child Agent worktree");
  const targetWorktreePath = yield* canonical(
    input.targetWorktreePath,
    "Integration target worktree",
  );
  if (sourceWorktreePath === targetWorktreePath) {
    return yield* invalid("An isolated Agent cannot integrate into its own worktree.");
  }

  const [sourceTopLevel, targetTopLevel, sourceCommonDirectory, targetCommonDirectory] =
    yield* Effect.all([
      gitTopLevel(sourceWorktreePath),
      gitTopLevel(targetWorktreePath),
      gitCommonDirectory(sourceWorktreePath),
      gitCommonDirectory(targetWorktreePath),
    ]);
  if (sourceTopLevel !== sourceWorktreePath || targetTopLevel !== targetWorktreePath) {
    return yield* invalid("Agent integration requires complete Git worktree roots.");
  }
  if (sourceCommonDirectory !== targetCommonDirectory) {
    return yield* invalid(
      "The Agent worktree and integration target are not from the same repository.",
    );
  }
  const sourceUntracked = yield* runGit(
    sourceWorktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "Untracked-file inspection",
  );
  if (sourceUntracked.length > 0) {
    return yield* invalid(
      "The isolated Agent created untracked files. T3 will not copy untracked files automatically; add them to Git or integrate manually.",
    );
  }
  const targetHead = (yield* runGit(
    targetWorktreePath,
    ["rev-parse", "HEAD"],
    "Integration target revision",
  )).trim();
  const mergeBase = (yield* runGit(
    sourceWorktreePath,
    ["merge-base", "HEAD", targetHead],
    "Agent branch-point inspection",
  )).trim();

  const patch = yield* runGit(
    sourceWorktreePath,
    ["diff", "--binary", "--no-ext-diff", mergeBase, "--"],
    "Agent patch generation",
  );
  if (patch.length === 0) return;

  const targetStatus = yield* runGit(
    targetWorktreePath,
    ["status", "--porcelain=v1", "-z"],
    "Integration target inspection",
  );
  if (targetStatus.length > 0) {
    if (input.allowAlreadyApplied === true) {
      const alreadyApplied = yield* runGit(
        targetWorktreePath,
        ["apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
        "Agent patch retry inspection",
        patch,
      ).pipe(Effect.result);
      if (Result.isSuccess(alreadyApplied)) return;
    }
    return yield* invalid(
      "The integration target has uncommitted changes. Commit, stash, or manually merge before integrating this Agent result.",
    );
  }

  yield* runGit(
    targetWorktreePath,
    ["apply", "--check", "--3way", "--whitespace=nowarn", "-"],
    "Agent patch preflight",
    patch,
  );
  yield* runGit(
    targetWorktreePath,
    ["apply", "--3way", "--whitespace=nowarn", "-"],
    "Agent patch integration",
    patch,
  );
});

export const make = Effect.gen(function* () {
  const catalog = yield* AgentCatalog.AgentCatalog;
  const hooks = yield* AgentHookRunner.AgentHookRunner;
  const runs = yield* AgentRunRepository.AgentRunRepository;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderService.ProviderService;
  const checkpointDiff = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const loadProfile = Effect.fn("AgentOrchestration.loadProfile")(function* (
    ref: AgentProfileLocator | AgentProfileRef,
    workspaceRoot: string,
  ) {
    const profile = yield* catalog.getProfile({ ref, workspaceRoot }).pipe(
      Effect.mapError((error) =>
        error._tag === "AgentCatalogNotFoundError"
          ? new AgentProfileNotFoundError({ id: ref.id, scope: ref.scope })
          : invalid(error.message, {
              operation: "profile-load",
              cause: error,
              profileId: ref.id,
            }),
      ),
    );
    if ("revision" in ref && ref.revision !== profile.revision) {
      return yield* invalid(
        `Agent profile '${ref.scope}/${ref.id}' changed after this thread pinned revision ${ref.revision}.`,
      );
    }
    if (profile.archivedAt !== null) {
      return yield* invalid(`Agent profile '${ref.scope}/${ref.id}' is archived.`);
    }
    return profile;
  });

  const invocationContext = Effect.fn("AgentOrchestration.invocationContext")(function* (
    scope: Parameters<AgentOrchestration["Service"]["list"]>[0],
  ) {
    const thread = yield* projection.getThreadShellById(scope.threadId).pipe(
      Effect.mapError((cause) =>
        invalid(`Could not resolve invoking thread '${scope.threadId}'.`, {
          operation: "invocation-thread-resolve",
          cause,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid(`Invoking thread '${scope.threadId}' was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    const project = yield* projection.getProjectShellById(thread.projectId).pipe(
      Effect.mapError((cause) =>
        invalid(`Could not resolve project '${thread.projectId}'.`, {
          operation: "invocation-project-resolve",
          cause,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid(`Project '${thread.projectId}' was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    const currentRun = yield* runs.getByChildThread(scope.threadId).pipe(
      Effect.mapError((cause) =>
        invalid("Could not resolve the invoking Agent run.", {
          operation: "invocation-run-resolve",
          cause,
        }),
      ),
      Effect.map(Option.getOrNull),
    );
    return { thread, project, currentRun };
  });

  /**
   * Delegation is deliberate live configuration: lists and new child runs see
   * the current profile policy. Existing run lifecycle operations use their
   * durable run and pinned snapshot instead, so an edit or archive cannot
   * strand a completed/running child.
   */
  const loadLiveDelegationProfile = Effect.fn("AgentOrchestration.loadLiveDelegationProfile")(
    function* (context: Effect.Success<ReturnType<typeof invocationContext>>) {
      const selectedRef = context.currentRun?.profile ?? context.thread.agentProfile ?? null;
      return selectedRef === null
        ? null
        : yield* loadProfile(liveAgentProfileLocator(selectedRef), context.project.workspaceRoot);
    },
  );

  const ensureOwnedRun = Effect.fn("AgentOrchestration.ensureOwnedRun")(function* (
    context: Effect.Success<ReturnType<typeof invocationContext>>,
    runId: AgentRunId,
  ) {
    const run = yield* runs.get(runId).pipe(
      Effect.mapError((cause) =>
        invalid(`Could not load Agent run '${runId}'.`, {
          operation: "run-load",
          cause,
          runId,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentRunNotFoundError({ id: runId })),
          onSome: Effect.succeed,
        }),
      ),
    );
    const owned =
      context.currentRun === null
        ? run.parentThreadId === context.thread.id
        : run.rootRunId === context.currentRun.rootRunId;
    if (!owned) return yield* new AgentRunNotFoundError({ id: runId });
    return run;
  });

  const allowedProfiles = <
    T extends {
      readonly id: string;
      readonly scope: "environment" | "project";
    },
  >(
    profile: AgentProfileDocument | null,
    available: ReadonlyArray<T>,
  ): ReadonlyArray<T> => {
    if (profile === null) return available;
    if (profile.delegation.policy === "disabled") return [];
    const allowed = new Set(
      profile.delegation.profiles.map((candidate) => `${candidate.scope}:${candidate.id}`),
    );
    return available.filter((candidate) => allowed.has(`${candidate.scope}:${candidate.id}`));
  };

  const list: AgentOrchestration["Service"]["list"] = Effect.fn("AgentOrchestration.list")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      const profile = yield* loadLiveDelegationProfile(context);
      const snapshot = yield* catalog.list({ workspaceRoot: context.project.workspaceRoot });
      const profiles = allowedProfiles(profile, snapshot.profiles)
        .filter((profile) => input.scope === undefined || profile.scope === input.scope)
        .filter((profile) => input.includeArchived === true || profile.archivedAt === null)
        .slice(0, input.limit ?? snapshot.profiles.length);
      return { profiles };
    },
  );

  const spawn: AgentOrchestration["Service"]["spawn"] = Effect.fn("AgentOrchestration.spawn")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      const profile = yield* loadLiveDelegationProfile(context);
      if (profile === null) {
        return yield* invalid("Select an Agent profile for this thread before delegating.");
      }
      if (input.projectId !== undefined && input.projectId !== context.project.id) {
        return yield* invalid("Agent runs cannot cross project boundaries.");
      }
      const requestedParentRunId = input.parentRunId ?? context.currentRun?.id ?? null;
      if (
        input.parentRunId !== undefined &&
        (context.currentRun === null || input.parentRunId !== context.currentRun.id)
      ) {
        return yield* invalid("A child may only attach to the invoking Agent run.");
      }
      if (profile.delegation.policy !== "allowlist") {
        return yield* invalid(`Agent '${profile.name}' does not allow delegation.`);
      }
      const requestedKey = `${input.profile.scope}:${input.profile.id}`;
      if (
        !profile.delegation.profiles.some(
          (candidate) => `${candidate.scope}:${candidate.id}` === requestedKey,
        )
      ) {
        return yield* invalid(
          `Agent '${profile.name}' may not delegate to '${input.profile.scope}/${input.profile.id}'.`,
        );
      }
      const target = yield* loadProfile(input.profile, context.project.workspaceRoot);
      const modelSelection = target.defaultModelSelection ?? context.thread.modelSelection;
      const capabilities = yield* providers.getCapabilities(modelSelection.instanceId).pipe(
        Effect.mapError((cause) =>
          invalid(`Provider '${modelSelection.instanceId}' is unavailable.`, {
            operation: "provider-capabilities",
            cause,
            profileId: target.id,
          }),
        ),
      );
      const unsupportedT3Capabilities = target.requirements.t3McpCapabilities.filter(
        (capability) => capability !== "agents" && capability !== "preview",
      );
      if (unsupportedT3Capabilities.length > 0) {
        return yield* invalid(
          `Profile requires unsupported T3 MCP capabilities: ${unsupportedT3Capabilities.join(", ")}.`,
        );
      }
      const compatibility = resolveAgentRuntimeCompatibility(capabilities, {
        delegation: target.delegation.policy === "allowlist",
        instructionPriority: target.instructionPriority,
        nativeToolPolicy:
          target.tools.policy === "allowlist" ? "exact" : target.requirements.toolRequirement,
        tokenBudget: target.budgets.maxTotalTokens !== undefined,
        monetaryBudget: target.budgets.maxEstimatedCostUsd !== undefined,
      });
      if (!compatibility.compatible) {
        return yield* invalid(
          `Provider '${modelSelection.instanceId}' cannot satisfy this profile: ${compatibility.issues.join(", ")}.`,
        );
      }
      if (target.workspace.mode === "isolated-worktree" && context.thread.branch === null) {
        return yield* invalid(
          "Isolated-worktree agents require the invoking thread to have a resolved branch.",
        );
      }

      const beforeSpawn = yield* hooks
        .run({
          profile: target,
          stage: "beforeSpawn",
          workspaceRoot: context.project.workspaceRoot,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.detail, {
              operation: "before-spawn-hook",
              cause: error,
              profileId: target.id,
            }),
          ),
        );
      const promptBuild = yield* hooks
        .run({
          profile: target,
          stage: "promptBuild",
          workspaceRoot: context.project.workspaceRoot,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.detail, {
              operation: "prompt-build-hook",
              cause: error,
              profileId: target.id,
            }),
          ),
        );
      const catalogSnapshot = yield* catalog.list({ workspaceRoot: context.project.workspaceRoot });
      const ruleDocuments = yield* Effect.forEach(catalogSnapshot.rules, (rule) =>
        catalog
          .getRule({
            ref: { id: AgentProfileId.make(rule.id), scope: rule.scope },
            workspaceRoot: context.project.workspaceRoot,
          })
          .pipe(
            Effect.mapError((error) =>
              invalid(
                `Could not load rule '${rule.scope}/${rule.id}' before spawning the Agent: ${error.message}`,
                {
                  operation: "spawn-rule-load",
                  cause: error,
                  profileId: target.id,
                },
              ),
            ),
          ),
      );
      const budget = minimumBudgets(target.budgets, context.currentRun?.budget ?? profile.budgets);
      const compiled = yield* Effect.try({
        try: () =>
          compileAgentPrompt({
            profile: target,
            cleanTask: input.task,
            ...(input.context === undefined ? {} : { context: input.context }),
            ...(input.files === undefined ? {} : { files: input.files, contextFiles: input.files }),
            rules: ruleDocuments,
            hookContext: [...beforeSpawn.context, ...promptBuild.context],
            lineage: {
              ...(requestedParentRunId === null ? {} : { parentRunId: requestedParentRunId }),
              depth: context.currentRun === null ? 0 : context.currentRun.depth + 1,
            },
            budget,
            toolNames: target.tools.allowed,
          }),
        catch: (error) =>
          invalid(error instanceof Error ? error.message : "Prompt compilation failed.", {
            operation: "prompt-compile",
            cause: error,
            profileId: target.id,
          }),
      });

      const runId = AgentRunId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) =>
            invalid("Could not allocate an Agent run id.", {
              operation: "run-id-allocate",
              cause,
              profileId: target.id,
            }),
          ),
        ),
      );
      const childThreadId = ThreadId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) =>
            invalid("Could not allocate an Agent thread id.", {
              operation: "child-thread-id-allocate",
              cause,
              profileId: target.id,
              runId,
            }),
          ),
        ),
      );
      const messageId = MessageId.make(
        `agent:${yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) =>
            invalid("Could not allocate an Agent message id.", {
              operation: "child-message-id-allocate",
              cause,
              profileId: target.id,
              runId,
            }),
          ),
        )}`,
      );
      const occurredAt = yield* nowIso;
      const parentThreadId = context.currentRun?.parentThreadId ?? context.thread.id;
      yield* runs.putProfileSnapshot(target).pipe(
        Effect.mapError((cause) =>
          invalid("Could not persist the pinned Agent profile revision.", {
            operation: "profile-snapshot-persist",
            cause,
            profileId: target.id,
            runId,
          }),
        ),
      );
      yield* runs
        .dispatch({
          type: "agent-run.request",
          runId,
          profile: { id: target.id, scope: target.scope, revision: target.revision },
          budget,
          parentRunId: requestedParentRunId,
          detached: input.detached ?? false,
          parentThreadId,
          projectId: context.project.id,
          modelSelection,
          instanceId: modelSelection.instanceId,
          workspaceMode: target.workspace.mode,
          occurredAt,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.message, { operation: "run-request", cause: error, runId }),
          ),
        );
      const pinnedProfile: AgentProfileRef = {
        id: target.id,
        scope: target.scope,
        revision: target.revision,
      };
      const activityRun = {
        id: runId,
        parentThreadId,
        profile: pinnedProfile,
        modelSelection,
        revision: 0,
        parentRunId: requestedParentRunId,
      };
      const failQueuedSpawn = Effect.fn("AgentOrchestration.failQueuedSpawn")(function* (
        detail: string,
        cause: unknown,
      ) {
        const failureOccurredAt = yield* nowIso;
        const failed = yield* runs
          .dispatch({
            type: "agent-run.fail",
            runId,
            failure: detail.slice(0, 4_000),
            occurredAt: failureOccurredAt,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(failed)) {
          const revision = failedAgentRunRevision(activityRun, failed.success);
          if (revision !== null) {
            yield* appendAgentRunTaskActivity({
              engine,
              run: { ...activityRun, revision },
              status: "failed",
              createdAt: failureOccurredAt,
            });
          }
        }
        yield* providers.stopSession({ threadId: childThreadId }).pipe(Effect.ignore);
        yield* engine
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`agent-spawn:${runId}:cleanup-thread`),
            threadId: childThreadId,
          })
          .pipe(Effect.ignore);
        return yield* invalid(detail, {
          operation: "child-lifecycle-dispatch",
          cause,
          profileId: target.id,
          runId,
        });
      });
      const assigned = yield* runs
        .dispatch({
          type: "agent-run.assign-child-thread",
          runId,
          childThreadId,
          occurredAt,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.message, { operation: "run-assign-thread", cause: error, runId }),
          ),
          Effect.result,
        );
      if (Result.isFailure(assigned)) {
        return yield* failQueuedSpawn(assigned.failure.detail, assigned.failure);
      }

      let createdWorktree: { readonly path: string; readonly branch: string } | null = null;
      const failSpawn = Effect.fn("AgentOrchestration.failSpawn")(function* (
        detail: string,
        cause: unknown,
      ) {
        const failureOccurredAt = yield* nowIso;
        const failed = yield* runs
          .dispatch({
            type: "agent-run.fail",
            runId,
            failure: detail.slice(0, 4_000),
            occurredAt: failureOccurredAt,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(failed)) {
          const revision = failedAgentRunRevision(activityRun, failed.success);
          if (revision !== null) {
            yield* appendAgentRunTaskActivity({
              engine,
              run: { ...activityRun, revision },
              status: "failed",
              createdAt: failureOccurredAt,
            });
          }
        }
        yield* providers.stopSession({ threadId: childThreadId }).pipe(Effect.ignore);
        if (createdWorktree !== null) {
          yield* cleanupCreatedAgentWorktree({
            gitWorkflow,
            processRunner,
            workspaceRoot: context.project.workspaceRoot,
            worktreePath: createdWorktree.path,
            branch: createdWorktree.branch,
          });
        }
        yield* engine
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`agent-spawn:${runId}:cleanup-thread`),
            threadId: childThreadId,
          })
          .pipe(Effect.ignore);
        return yield* invalid(detail, {
          operation: "child-lifecycle-dispatch",
          cause,
          profileId: target.id,
          runId,
        });
      });

      const createThread: ThreadCreateCommand = {
        type: "thread.create",
        commandId: CommandId.make(`agent-spawn:${runId}:create-thread`),
        threadId: childThreadId,
        projectId: context.project.id,
        title: `${target.name}: ${input.task.trim().slice(0, 80) || "Agent run"}`,
        modelSelection,
        ...runtimeSettingsForAgentProfile(target),
        branch: context.thread.branch,
        worktreePath: target.workspace.mode === "shared" ? context.thread.worktreePath : null,
        agentProfile: pinnedProfile,
        createdAt: occurredAt,
      };
      const prepareThread =
        target.workspace.mode === "isolated-worktree"
          ? Effect.gen(function* () {
              const worktree = yield* gitWorkflow
                .createWorktree({
                  cwd: context.project.workspaceRoot,
                  refName: context.thread.branch!,
                  newRefName: agentWorktreeBranchName(runId),
                  baseRefName: context.thread.branch!,
                  path: null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    invalid(`T3 could not prepare the child Agent worktree: ${error.message}`, {
                      operation: "child-worktree-create",
                      cause: error,
                      profileId: target.id,
                      runId,
                    }),
                  ),
                );
              createdWorktree = {
                path: worktree.worktree.path,
                branch: worktree.worktree.refName,
              };
              yield* engine
                .dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make(`agent-spawn:${runId}:update-thread-worktree`),
                  threadId: childThreadId,
                  branch: worktree.worktree.refName,
                  worktreePath: worktree.worktree.path,
                })
                .pipe(
                  Effect.mapError((error) =>
                    invalid(`T3 could not attach the child Agent worktree: ${error.message}`, {
                      operation: "child-worktree-attach",
                      cause: error,
                      profileId: target.id,
                      runId,
                    }),
                  ),
                );
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: childThreadId,
                  projectId: context.project.id,
                  projectCwd: context.project.workspaceRoot,
                  worktreePath: worktree.worktree.path,
                })
                .pipe(
                  Effect.tapError((error) =>
                    Effect.logWarning("Agent child worktree setup script failed to start", {
                      runId,
                      threadId: childThreadId,
                      detail: error.message,
                    }),
                  ),
                  Effect.ignore,
                );
            })
          : Effect.void;
      const startTurn: ThreadTurnStartCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make(`agent-spawn:${runId}`),
        threadId: childThreadId,
        message: {
          messageId,
          role: "user",
          text: compiled.portablePrompt.text,
          attachments: [],
        },
        modelSelection,
        ...runtimeSettingsForAgentProfile(target),
        agentProfile: pinnedProfile,
        createdAt: occurredAt,
      };
      const startOccurredAt = yield* nowIso;
      const markRunStarted = runs
        .dispatch({ type: "agent-run.start", runId, occurredAt: startOccurredAt })
        .pipe(
          Effect.flatMap((events) =>
            appendAgentRunTaskActivity({
              engine,
              run: {
                ...activityRun,
                revision: revisionAfterAgentRunTransition(activityRun, events),
              },
              status: "started",
              createdAt: startOccurredAt,
              title: target.name,
            }),
          ),
          Effect.mapError((error) =>
            invalid(error.message, { operation: "run-start", cause: error, runId }),
          ),
        );
      const dispatched = yield* dispatchAgentChildLifecycle({
        engine,
        createThread,
        prepareThread,
        markRunStarted,
        startTurn,
      }).pipe(Effect.result);
      if (Result.isFailure(dispatched)) {
        return yield* failSpawn(dispatched.failure.detail, dispatched.failure);
      }
      const run = yield* runs.get(runId).pipe(
        Effect.mapError((cause) =>
          invalid("Could not reload the Agent run.", {
            operation: "run-reload",
            cause,
            runId,
          }),
        ),
        Effect.map(Option.getOrThrow),
      );
      return {
        runId,
        childThreadId,
        status: run.status,
        revision: run.revision,
      };
    },
  );

  const status: AgentOrchestration["Service"]["status"] = Effect.fn("AgentOrchestration.status")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      return { run: AgentRunDomain.summaryOf(yield* ensureOwnedRun(context, input.runId)) };
    },
  );

  const wait: AgentOrchestration["Service"]["wait"] = Effect.fn("AgentOrchestration.wait")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      yield* Effect.forEach(input.runIds, (runId) => ensureOwnedRun(context, runId));
      const revisions =
        typeof input.afterRevision === "number"
          ? Object.fromEntries(input.runIds.map((runId) => [runId, input.afterRevision as number]))
          : input.afterRevision;
      const advanced = yield* runs
        .waitForAdvance({
          runIds: input.runIds,
          ...(revisions === undefined ? {} : { afterRevision: revisions }),
        })
        .pipe(
          Effect.timeoutOption(Duration.seconds(input.timeoutSeconds)),
          Effect.mapError((cause) =>
            invalid("Could not wait for Agent runs.", {
              operation: "run-wait",
              cause,
            }),
          ),
        );
      if (Option.isSome(advanced)) {
        return { runs: advanced.value.map(AgentRunDomain.summaryOf) };
      }
      const current = yield* Effect.forEach(input.runIds, (runId) =>
        ensureOwnedRun(context, runId),
      );
      return { runs: current.map(AgentRunDomain.summaryOf) };
    },
  );

  const result: AgentOrchestration["Service"]["result"] = Effect.fn("AgentOrchestration.result")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      const run = yield* ensureOwnedRun(context, input.runId);
      if (run.childThreadId === null) {
        return {
          runId: run.id,
          status: run.status,
          revision: run.revision,
          entries: [],
          nextCursor: null,
          finalMessage: null,
          diff: null,
          ...(run.usage === undefined ? {} : { usage: run.usage }),
        };
      }
      const thread = yield* projection.getThreadDetailById(run.childThreadId).pipe(
        Effect.mapError((cause) =>
          invalid("Could not read the child Agent thread.", {
            operation: "child-thread-read",
            cause,
            runId: run.id,
          }),
        ),
        Effect.flatMap((detail) => requireAgentResultThread(detail, run.id)),
      );
      const allEntries: AgentMcpResultEntry[] = thread.messages.map((message, sequence) => ({
        sequence,
        kind: "message",
        text: message.text.slice(0, 32_000),
        createdAt: message.createdAt,
      }));
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? 16;
      const entries = allEntries.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + entries.length < allEntries.length ? cursor + entries.length : null;
      const finalMessage =
        thread.messages.toReversed().find((message) => message.role === "assistant")?.text ?? null;
      const latestTurnCount =
        thread.checkpoints.reduce(
          (maximum, checkpoint) => Math.max(maximum, checkpoint.checkpointTurnCount),
          0,
        ) ?? 0;
      const diff =
        latestTurnCount === 0
          ? null
          : yield* checkpointDiff
              .getFullThreadDiff({
                threadId: run.childThreadId,
                toTurnCount: latestTurnCount,
                ignoreWhitespace: false,
              })
              .pipe(
                Effect.map((value) => value.diff.slice(0, 2_000_000)),
                Effect.orElseSucceed(() => null),
              );
      return {
        runId: run.id,
        status: run.status,
        revision: run.revision,
        entries,
        nextCursor,
        finalMessage: finalMessage?.slice(0, 32_000) ?? null,
        diff,
        ...(run.usage === undefined ? {} : { usage: run.usage }),
      };
    },
  );

  const send: AgentOrchestration["Service"]["send"] = Effect.fn("AgentOrchestration.send")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      const run = yield* ensureOwnedRun(context, input.runId);
      if (run.childThreadId === null || run.status !== "succeeded") {
        return yield* new AgentRunInvalidStateError({
          id: run.id,
          status: run.status,
          operation: "send",
        });
      }
      const pinnedRuntimeSettings = yield* resolvePinnedAgentRuntimeSettings({
        repository: runs,
        run,
      });
      const occurredAt = yield* nowIso;
      const { commandId, messageId, revision } = yield* requestAgentFollowUp({
        crypto,
        repository: runs,
        runId: run.id,
        message: input.message,
        occurredAt,
      });
      yield* appendAgentRunTaskActivity({
        engine,
        run: { ...run, revision },
        status: "pending",
        createdAt: occurredAt,
      });
      // Persist running before the provider can emit turn.started. The
      // runtime event is what durably binds the provider turn id to this
      // follow-up revision.
      const lifecycle = yield* dispatchAgentFollowUpLifecycle({
        engine,
        markRunStarted: runs
          .dispatch({ type: "agent-run.start", runId: run.id, occurredAt: yield* nowIso })
          .pipe(
            Effect.mapError((error) =>
              invalid(error.message, {
                operation: "follow-up-run-start",
                cause: error,
                runId: run.id,
              }),
            ),
          ),
        startTurn: {
          type: "thread.turn.start",
          commandId,
          threadId: run.childThreadId,
          message: {
            messageId,
            role: "user",
            text: input.message,
            attachments: [],
          },
          modelSelection: run.modelSelection,
          ...pinnedRuntimeSettings,
          createdAt: occurredAt,
        },
      }).pipe(Effect.result);
      if (Result.isFailure(lifecycle)) {
        const failureOccurredAt = yield* nowIso;
        const failed = yield* runs
          .dispatch({
            type: "agent-run.fail",
            runId: run.id,
            failure: "T3 could not send the follow-up turn.",
            occurredAt: failureOccurredAt,
          })
          .pipe(Effect.result);
        if (Result.isSuccess(failed)) {
          const revision = failedAgentRunRevision(run, failed.success);
          if (revision !== null) {
            yield* appendAgentRunTaskActivity({
              engine,
              run: { ...run, revision },
              status: "failed",
              createdAt: failureOccurredAt,
            });
          }
        }
        return yield* invalid("T3 could not send the Agent follow-up turn.", {
          operation: "follow-up-turn-dispatch",
          cause: lifecycle.failure,
          runId: run.id,
        });
      }
      yield* appendAgentRunTaskActivity({
        engine,
        run: {
          ...run,
          revision: revisionAfterAgentRunTransition(run, lifecycle.success.started),
        },
        status: "running",
        createdAt: yield* nowIso,
      });
      const updated = yield* ensureOwnedRun(context, run.id);
      return { runId: updated.id, status: updated.status, revision: updated.revision };
    },
  );

  const cancel: AgentOrchestration["Service"]["cancel"] = Effect.fn("AgentOrchestration.cancel")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      const run = yield* ensureOwnedRun(context, input.runId);
      const cancelled = yield* runs
        .dispatch({
          type: "agent-run.cancel",
          runId: run.id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          occurredAt: yield* nowIso,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.message, { operation: "run-cancel", cause: error, runId: run.id }),
          ),
        );
      const cancelledRevision = cancelledAgentRunRevision(run, cancelled);
      if (cancelledRevision !== null) {
        yield* appendAgentRunTaskActivity({
          engine,
          run: { ...run, revision: cancelledRevision },
          status: "cancelled",
          createdAt: yield* nowIso,
        });
      }
      if (run.childThreadId !== null) {
        yield* providers.stopSession({ threadId: run.childThreadId }).pipe(
          Effect.mapError((cause) =>
            invalid(
              "The Agent run is cancelled, but its provider session could not stop. Retry cancel.",
              {
                operation: "run-cancel-provider-stop",
                cause,
                runId: run.id,
              },
            ),
          ),
        );
      }
      const updated = yield* ensureOwnedRun(context, run.id);
      return { runId: updated.id, status: updated.status, revision: updated.revision };
    },
  );

  const integrate: AgentOrchestration["Service"]["integrate"] = Effect.fn(
    "AgentOrchestration.integrate",
  )(function* (scope, input) {
    const context = yield* invocationContext(scope);
    const run = yield* ensureOwnedRun(context, input.runId);
    if (run.childThreadId === null) {
      return yield* new AgentRunInvalidStateError({
        id: run.id,
        status: run.status,
        operation: "integrate",
      });
    }
    if (run.status === "integrated") {
      const integratedAt = run.finishedAt ?? (yield* nowIso);
      return {
        runId: run.id,
        childThreadId: run.childThreadId,
        status: run.status,
        revision: run.revision,
        integratedAt,
      };
    }
    if (run.status !== "succeeded" && run.status !== "integrating") {
      return yield* new AgentRunInvalidStateError({
        id: run.id,
        status: run.status,
        operation: "integrate",
      });
    }

    const resumingIntegration = run.status === "integrating";
    const targetThreadId = resumingIntegration
      ? run.integrationTargetThreadId
      : (input.targetThreadId ?? run.parentThreadId);
    if (targetThreadId === null) {
      return yield* new AgentRunInvalidStateError({
        id: run.id,
        status: run.status,
        operation: "integrate",
      });
    }
    if (
      resumingIntegration &&
      input.targetThreadId !== undefined &&
      input.targetThreadId !== targetThreadId
    ) {
      return yield* invalid("An in-progress integration must resume against its original target.", {
        operation: "integration-resume-target",
        runId: run.id,
      });
    }

    const failIntegration = Effect.fn("AgentOrchestration.failIntegration")(function* (
      detail: string,
      cause: unknown,
    ) {
      yield* runs
        .dispatch({
          type: "agent-run.conflict-integration",
          runId: run.id,
          failure: detail.slice(0, 4_000),
          occurredAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
      return yield* invalid(detail, {
        operation: "integration-apply",
        cause,
        runId: run.id,
      });
    });
    const succeedIntegration = Effect.fn("AgentOrchestration.succeedIntegration")(function* () {
      yield* runs
        .dispatch({
          type: "agent-run.succeed-integration",
          runId: run.id,
          occurredAt: yield* nowIso,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.message, {
              operation: "integration-succeed",
              cause: error,
              runId: run.id,
            }),
          ),
        );
      const updated = yield* ensureOwnedRun(context, run.id);
      const integratedAt = updated.finishedAt ?? (yield* nowIso);
      return {
        runId: updated.id,
        childThreadId: updated.childThreadId,
        status: updated.status,
        revision: updated.revision,
        integratedAt,
      };
    });

    const targetThreadResult = yield* projection.getThreadShellById(targetThreadId).pipe(
      Effect.mapError((cause) =>
        invalid("Could not resolve the Agent integration target.", {
          operation: "integration-target-resolve",
          cause,
          runId: run.id,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid("The Agent integration target was not found.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(targetThreadResult)) {
      if (resumingIntegration) {
        return yield* failIntegration(
          targetThreadResult.failure.detail,
          targetThreadResult.failure,
        );
      }
      return yield* targetThreadResult.failure;
    }
    const targetThread = targetThreadResult.success;
    if (targetThread.projectId !== run.projectId || targetThread.projectId !== context.project.id) {
      const failure = invalid("Agent results cannot be integrated across project boundaries.");
      if (resumingIntegration) return yield* failIntegration(failure.detail, failure);
      return yield* failure;
    }
    if (run.workspaceMode === "shared") {
      const childThreadResult = yield* projection.getThreadShellById(run.childThreadId).pipe(
        Effect.mapError((cause) =>
          invalid("Could not resolve the shared Agent workspace.", {
            operation: "integration-source-resolve",
            cause,
            runId: run.id,
          }),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(invalid("The shared Agent thread was not found.")),
            onSome: Effect.succeed,
          }),
        ),
        Effect.result,
      );
      if (Result.isFailure(childThreadResult)) {
        if (resumingIntegration) {
          return yield* failIntegration(
            childThreadResult.failure.detail,
            childThreadResult.failure,
          );
        }
        return yield* childThreadResult.failure;
      }
      const sourceWorktreePath =
        childThreadResult.success.worktreePath ?? context.project.workspaceRoot;
      const targetWorktreePath = targetThread.worktreePath ?? context.project.workspaceRoot;
      if (sourceWorktreePath !== targetWorktreePath) {
        const failure = invalid(
          "A shared Agent result can only be integrated into the worktree where it already ran.",
        );
        if (resumingIntegration) return yield* failIntegration(failure.detail, failure);
        return yield* failure;
      }
    }

    if (!resumingIntegration) {
      yield* runs
        .dispatch({
          type: "agent-run.start-integration",
          runId: run.id,
          targetThreadId,
          occurredAt: yield* nowIso,
        })
        .pipe(
          Effect.mapError((error) =>
            invalid(error.message, {
              operation: "integration-start",
              cause: error,
              runId: run.id,
            }),
          ),
        );
    }

    if (run.workspaceMode === "shared") {
      return yield* succeedIntegration();
    }

    const childThreadResult = yield* projection.getThreadShellById(run.childThreadId).pipe(
      Effect.mapError((cause) =>
        invalid("Could not resolve the isolated Agent worktree.", {
          operation: "integration-source-resolve",
          cause,
          runId: run.id,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid("The isolated Agent thread was not found.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(childThreadResult)) {
      return yield* failIntegration(childThreadResult.failure.detail, childThreadResult.failure);
    }
    const childThread = childThreadResult.success;
    const sourceWorktreePath = childThread.worktreePath;
    const targetWorktreePath = targetThread.worktreePath ?? context.project.workspaceRoot;
    if (sourceWorktreePath === null) {
      const detail = "The isolated Agent does not have a prepared Git worktree.";
      return yield* failIntegration(detail, new Error(detail));
    }
    const profileResult = yield* runs.getProfileSnapshot(run.profile.revision).pipe(
      Effect.mapError((cause) =>
        invalid("Could not load the pinned Agent profile for integration.", {
          operation: "integration-profile-load",
          cause,
          profileId: run.profile.id,
          runId: run.id,
        }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(invalid("The pinned Agent profile is unavailable for integration.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(profileResult)) {
      return yield* failIntegration(profileResult.failure.detail, profileResult.failure);
    }
    const profile = profileResult.success;
    const beforeIntegrate = yield* hooks
      .run({ profile, stage: "beforeIntegrate", workspaceRoot: sourceWorktreePath })
      .pipe(Effect.result);
    if (Result.isFailure(beforeIntegrate)) {
      return yield* failIntegration(beforeIntegrate.failure.detail, beforeIntegrate.failure);
    }

    const applied = yield* applyIsolatedWorktreePatch({
      sourceWorktreePath,
      targetWorktreePath,
      allowAlreadyApplied: resumingIntegration,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.result,
    );
    if (Result.isFailure(applied)) {
      return yield* failIntegration(applied.failure.detail, applied.failure);
    }

    // An after hook cannot safely undo a patch. Its block policy is treated as
    // a visible warning at this point rather than reporting a false conflict.
    yield* hooks.run({ profile, stage: "afterIntegrate", workspaceRoot: targetWorktreePath }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Agent afterIntegrate hook failed after patch application", {
          runId: run.id,
          detail: error.detail,
        }),
      ),
      Effect.ignore,
    );
    return yield* succeedIntegration();
  });

  return AgentOrchestration.of({ list, spawn, status, wait, result, send, cancel, integrate });
});

export const layer = Layer.effect(AgentOrchestration, make);
