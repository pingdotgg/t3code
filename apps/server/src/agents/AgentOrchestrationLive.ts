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
  type AgentRunSummary,
  type OrchestrationCommand,
  type RuntimeTaskUsage,
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
import { AgentOrchestration, type AgentOrchestrationError } from "./AgentOrchestration.ts";
import { compileAgentPrompt } from "./prompt/PromptCompiler.ts";
import * as AgentRunDomain from "./run/AgentRun.ts";
import * as AgentRunRepository from "./run/AgentRunRepository.ts";

const invalid = (detail: string) => new AgentProfileInvalidError({ detail });

const minimumBudgets = (
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

const runtimeModeFor = (profile: AgentProfileDocument) => {
  switch (profile.workspace.access) {
    case "read-only":
      return "approval-required" as const;
    case "workspace-write":
      return profile.runtime.mode === "full-access" ? "auto-accept-edits" : profile.runtime.mode;
    case "full-access":
      return profile.runtime.mode;
  }
};

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
  readonly startTurn: ThreadTurnStartCommand;
}) {
  yield* input.engine
    .dispatch(input.createThread)
    .pipe(
      Effect.mapError((error) =>
        invalid(`T3 could not create the child Agent thread: ${error.message}`),
      ),
    );
  yield* input.prepareThread;
  return yield* input.engine
    .dispatch(input.startTurn)
    .pipe(
      Effect.mapError((error) =>
        invalid(`T3 could not start the child Agent thread: ${error.message}`),
      ),
    );
});

export const agentWorktreeBranchName = (runId: AgentRunId): string => `t3code/agent-${runId}`;

const MAX_INTEGRATION_PATCH_BYTES = 32 * 1024 * 1024;

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
}): Effect.fn.Return<
  void,
  AgentProfileInvalidError,
  FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const canonical = (candidate: string, label: string) =>
    fileSystem
      .realPath(candidate)
      .pipe(Effect.mapError(() => invalid(`${label} is no longer available.`)));
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
        Effect.mapError(() => invalid(`${operation} could not start.`)),
        Effect.flatMap((result) => {
          if (
            result.code === 0 &&
            !result.timedOut &&
            !result.stdoutTruncated &&
            !result.stderrTruncated
          ) {
            return Effect.succeed(result.stdout);
          }
          const detail = result.stderr.trim() || result.stdout.trim();
          return Effect.fail(
            invalid(
              detail.length > 0
                ? `${operation} failed: ${detail.slice(0, 4_000)}`
                : `${operation} failed.`,
            ),
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
  const targetStatus = yield* runGit(
    targetWorktreePath,
    ["status", "--porcelain=v1", "-z"],
    "Integration target inspection",
  );
  if (targetStatus.length > 0) {
    return yield* invalid(
      "The integration target has uncommitted changes. Commit, stash, or manually merge before integrating this Agent result.",
    );
  }

  const patch = yield* runGit(
    sourceWorktreePath,
    ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
    "Agent patch generation",
  );
  if (patch.length === 0) return;

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
    const profile = yield* catalog
      .getProfile({ ref, workspaceRoot })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentCatalogNotFoundError"
            ? new AgentProfileNotFoundError({ id: ref.id, scope: ref.scope })
            : invalid(error.message),
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
      Effect.mapError(() => invalid(`Could not resolve invoking thread '${scope.threadId}'.`)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid(`Invoking thread '${scope.threadId}' was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    const project = yield* projection.getProjectShellById(thread.projectId).pipe(
      Effect.mapError(() => invalid(`Could not resolve project '${thread.projectId}'.`)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid(`Project '${thread.projectId}' was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );
    const currentRun = yield* runs.getByChildThread(scope.threadId).pipe(
      Effect.mapError(() => invalid("Could not resolve the invoking Agent run.")),
      Effect.map(Option.getOrNull),
    );
    const selectedRef = currentRun?.profile ?? thread.agentProfile ?? null;
    const profile =
      selectedRef === null ? null : yield* loadProfile(selectedRef, project.workspaceRoot);
    return { thread, project, currentRun, profile };
  });

  const ensureOwnedRun = Effect.fn("AgentOrchestration.ensureOwnedRun")(function* (
    context: Effect.Success<ReturnType<typeof invocationContext>>,
    runId: AgentRunId,
  ) {
    const run = yield* runs.get(runId).pipe(
      Effect.mapError(() => invalid(`Could not load Agent run '${runId}'.`)),
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
      const snapshot = yield* catalog.list({ workspaceRoot: context.project.workspaceRoot });
      const profiles = allowedProfiles(context.profile, snapshot.profiles)
        .filter((profile) => input.scope === undefined || profile.scope === input.scope)
        .filter((profile) => input.includeArchived === true || profile.archivedAt === null)
        .slice(0, input.limit ?? snapshot.profiles.length);
      return { profiles };
    },
  );

  const spawn: AgentOrchestration["Service"]["spawn"] = Effect.fn("AgentOrchestration.spawn")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      if (context.profile === null) {
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
      if (context.profile.delegation.policy !== "allowlist") {
        return yield* invalid(`Agent '${context.profile.name}' does not allow delegation.`);
      }
      const requestedKey = `${input.profile.scope}:${input.profile.id}`;
      if (
        !context.profile.delegation.profiles.some(
          (candidate) => `${candidate.scope}:${candidate.id}` === requestedKey,
        )
      ) {
        return yield* invalid(
          `Agent '${context.profile.name}' may not delegate to '${input.profile.scope}/${input.profile.id}'.`,
        );
      }
      const target = yield* loadProfile(input.profile, context.project.workspaceRoot);
      const modelSelection = target.defaultModelSelection ?? context.thread.modelSelection;
      const capabilities = yield* providers
        .getCapabilities(modelSelection.instanceId)
        .pipe(
          Effect.mapError(() => invalid(`Provider '${modelSelection.instanceId}' is unavailable.`)),
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
        .pipe(Effect.mapError((error) => invalid(error.detail)));
      const promptBuild = yield* hooks
        .run({
          profile: target,
          stage: "promptBuild",
          workspaceRoot: context.project.workspaceRoot,
        })
        .pipe(Effect.mapError((error) => invalid(error.detail)));
      const catalogSnapshot = yield* catalog.list({ workspaceRoot: context.project.workspaceRoot });
      const ruleDocuments = yield* Effect.forEach(catalogSnapshot.rules, (rule) =>
        catalog
          .getRule({
            ref: { id: AgentProfileId.make(rule.id), scope: rule.scope },
            workspaceRoot: context.project.workspaceRoot,
          })
          .pipe(Effect.result),
      ).pipe(
        Effect.map((results) => results.filter(Result.isSuccess).map((result) => result.success)),
      );
      const budget = minimumBudgets(target.budgets, context.profile.budgets);
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
          invalid(error instanceof Error ? error.message : "Prompt compilation failed."),
      });

      const runId = AgentRunId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => invalid("Could not allocate an Agent run id.")),
        ),
      );
      const childThreadId = ThreadId.make(
        yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => invalid("Could not allocate an Agent thread id.")),
        ),
      );
      const messageId = MessageId.make(
        `agent:${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => invalid("Could not allocate an Agent message id.")))}`,
      );
      const occurredAt = yield* nowIso;
      yield* runs
        .putProfileSnapshot(target)
        .pipe(
          Effect.mapError(() => invalid("Could not persist the pinned Agent profile revision.")),
        );
      yield* runs
        .dispatch({
          type: "agent-run.request",
          runId,
          profile: { id: target.id, scope: target.scope, revision: target.revision },
          budget,
          parentRunId: requestedParentRunId,
          detached: input.detached ?? false,
          parentThreadId: context.currentRun?.parentThreadId ?? context.thread.id,
          projectId: context.project.id,
          modelSelection,
          instanceId: modelSelection.instanceId,
          workspaceMode: target.workspace.mode,
          occurredAt,
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      yield* runs
        .dispatch({
          type: "agent-run.assign-child-thread",
          runId,
          childThreadId,
          occurredAt,
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));

      const pinnedProfile: AgentProfileRef = {
        id: target.id,
        scope: target.scope,
        revision: target.revision,
      };
      const failSpawn = Effect.fn("AgentOrchestration.failSpawn")(function* (detail: string) {
        yield* runs
          .dispatch({
            type: "agent-run.fail",
            runId,
            failure: detail.slice(0, 4_000),
            occurredAt: yield* nowIso,
          })
          .pipe(Effect.ignore);
        yield* engine
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`agent-spawn:${runId}:cleanup-thread`),
            threadId: childThreadId,
          })
          .pipe(Effect.ignore);
        return yield* invalid(detail);
      });

      const createThread: ThreadCreateCommand = {
        type: "thread.create",
        commandId: CommandId.make(`agent-spawn:${runId}:create-thread`),
        threadId: childThreadId,
        projectId: context.project.id,
        title: `${target.name}: ${input.task.trim().slice(0, 80) || "Agent run"}`,
        modelSelection,
        runtimeMode: runtimeModeFor(target),
        interactionMode: target.runtime.interactionMode,
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
                    invalid(`T3 could not prepare the child Agent worktree: ${error.message}`),
                  ),
                );
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
                    invalid(`T3 could not attach the child Agent worktree: ${error.message}`),
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
        runtimeMode: runtimeModeFor(target),
        interactionMode: target.runtime.interactionMode,
        agentProfile: pinnedProfile,
        createdAt: occurredAt,
      };
      const dispatched = yield* dispatchAgentChildLifecycle({
        engine,
        createThread,
        prepareThread,
        startTurn,
      }).pipe(Effect.result);
      if (Result.isFailure(dispatched)) {
        return yield* failSpawn(dispatched.failure.detail);
      }
      yield* runs
        .dispatch({ type: "agent-run.start", runId, occurredAt: yield* nowIso })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      const run = yield* runs.get(runId).pipe(
        Effect.mapError(() => invalid("Could not reload the Agent run.")),
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
          Effect.mapError(() => invalid("Could not wait for Agent runs.")),
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
        Effect.mapError(() => invalid("Could not read the child Agent thread.")),
        Effect.map(Option.getOrNull),
      );
      const allEntries: AgentMcpResultEntry[] = (thread?.messages ?? []).map(
        (message, sequence) => ({
          sequence,
          kind: "message",
          text: message.text.slice(0, 32_000),
          createdAt: message.createdAt,
        }),
      );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? 16;
      const entries = allEntries.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + entries.length < allEntries.length ? cursor + entries.length : null;
      const finalMessage =
        [...(thread?.messages ?? [])].reverse().find((message) => message.role === "assistant")
          ?.text ?? null;
      const latestTurnCount =
        thread?.checkpoints.reduce(
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
      const occurredAt = yield* nowIso;
      yield* runs
        .dispatch({
          type: "agent-run.follow-up",
          runId: run.id,
          message: input.message,
          occurredAt,
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      const dispatch = yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(
            `agent-send:${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => invalid("Could not allocate an Agent command id.")))}`,
          ),
          threadId: run.childThreadId,
          message: {
            messageId: MessageId.make(
              `agent:${yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => invalid("Could not allocate an Agent message id.")))}`,
            ),
            role: "user",
            text: input.message,
            attachments: [],
          },
          modelSelection: run.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: occurredAt,
        })
        .pipe(Effect.result);
      if (Result.isFailure(dispatch)) {
        yield* runs
          .dispatch({
            type: "agent-run.fail",
            runId: run.id,
            failure: "T3 could not send the follow-up turn.",
            occurredAt: yield* nowIso,
          })
          .pipe(Effect.ignore);
        return yield* invalid("T3 could not send the Agent follow-up turn.");
      }
      yield* runs
        .dispatch({ type: "agent-run.start", runId: run.id, occurredAt: yield* nowIso })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      const updated = yield* ensureOwnedRun(context, run.id);
      return { runId: updated.id, status: updated.status, revision: updated.revision };
    },
  );

  const cancel: AgentOrchestration["Service"]["cancel"] = Effect.fn("AgentOrchestration.cancel")(
    function* (scope, input) {
      const context = yield* invocationContext(scope);
      const run = yield* ensureOwnedRun(context, input.runId);
      yield* runs
        .dispatch({
          type: "agent-run.cancel",
          runId: run.id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          occurredAt: yield* nowIso,
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      if (run.childThreadId !== null) {
        yield* providers.stopSession({ threadId: run.childThreadId }).pipe(Effect.ignore);
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
    if (run.status !== "succeeded") {
      return yield* new AgentRunInvalidStateError({
        id: run.id,
        status: run.status,
        operation: "integrate",
      });
    }

    const targetThreadId = input.targetThreadId ?? run.parentThreadId;
    const targetThread = yield* projection.getThreadShellById(targetThreadId).pipe(
      Effect.mapError(() => invalid("Could not resolve the Agent integration target.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid("The Agent integration target was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (targetThread.projectId !== run.projectId || targetThread.projectId !== context.project.id) {
      return yield* invalid("Agent results cannot be integrated across project boundaries.");
    }

    yield* runs
      .dispatch({
        type: "agent-run.start-integration",
        runId: run.id,
        targetThreadId,
        occurredAt: yield* nowIso,
      })
      .pipe(Effect.mapError((error) => invalid(error.message)));

    const failIntegration = Effect.fn("AgentOrchestration.failIntegration")(function* (
      detail: string,
    ) {
      yield* runs
        .dispatch({
          type: "agent-run.conflict-integration",
          runId: run.id,
          failure: detail.slice(0, 4_000),
          occurredAt: yield* nowIso,
        })
        .pipe(Effect.ignore);
      return yield* invalid(detail);
    });
    const succeedIntegration = Effect.fn("AgentOrchestration.succeedIntegration")(function* () {
      yield* runs
        .dispatch({
          type: "agent-run.succeed-integration",
          runId: run.id,
          occurredAt: yield* nowIso,
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));
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

    if (run.workspaceMode === "shared") {
      return yield* succeedIntegration();
    }

    const childThread = yield* projection.getThreadShellById(run.childThreadId).pipe(
      Effect.mapError(() => invalid("Could not resolve the isolated Agent worktree.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(invalid("The isolated Agent thread was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const sourceWorktreePath = childThread.worktreePath;
    const targetWorktreePath = targetThread.worktreePath ?? context.project.workspaceRoot;
    if (sourceWorktreePath === null) {
      return yield* failIntegration("The isolated Agent does not have a prepared Git worktree.");
    }
    const profile = yield* runs.getProfileSnapshot(run.profile.revision).pipe(
      Effect.mapError(() => invalid("Could not load the pinned Agent profile for integration.")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(invalid("The pinned Agent profile is unavailable for integration.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const beforeIntegrate = yield* hooks
      .run({ profile, stage: "beforeIntegrate", workspaceRoot: sourceWorktreePath })
      .pipe(Effect.result);
    if (Result.isFailure(beforeIntegrate)) {
      return yield* failIntegration(beforeIntegrate.failure.detail);
    }

    const applied = yield* applyIsolatedWorktreePatch({
      sourceWorktreePath,
      targetWorktreePath,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      Effect.result,
    );
    if (Result.isFailure(applied)) {
      return yield* failIntegration(applied.failure.detail);
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
