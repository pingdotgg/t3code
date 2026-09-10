// @effect-diagnostics globalDate:off - persisted orchestration timestamps are ISO strings.
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  ThreadId,
  type AgentDashboardFinding,
  type ModelSelection,
  type OrchestrationProjectShell,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { buildAgentDashboardFindingPrompt } from "@t3tools/shared/agentDashboardFinding";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";

import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";

export interface AgentDashboardImplementationRunResult {
  readonly findingId: string;
  readonly projectId: OrchestrationProjectShell["id"];
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly baseBranch: string;
  readonly worktreePath: string;
}

export type AgentDashboardImplementationNudgeReason =
  | "stalled"
  | "missing-pull-request"
  | "pull-request-not-draft";

export const buildAgentDashboardImplementationNudgePrompt = (input: {
  readonly reason: AgentDashboardImplementationNudgeReason;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly consolidatePullRequests: boolean;
}): string => {
  const progressContext = (() => {
    switch (input.reason) {
      case "stalled":
        return "T3 has not observed meaningful progress from this work session recently.";
      case "missing-pull-request":
        return "Your latest turn finished, but T3 could not find a pull request for this worktree branch.";
      case "pull-request-not-draft":
        return "T3 found the pull request for this worktree branch, but it is ready for review instead of draft.";
      default: {
        const exhaustive: never = input.reason;
        throw new Error(`Unhandled implementation nudge reason: ${String(exhaustive)}`);
      }
    }
  })();

  const requiredAction = (() => {
    if (input.reason === "pull-request-not-draft") {
      return "Convert the existing pull request to draft. With GitHub CLI, use gh pr ready --undo. Do not create another pull request.";
    }
    if (input.consolidatePullRequests) {
      return "Continue the assigned finding until it is fully complete. Inspect open pull requests first. If one is coherently related, build on its head commit, push to that same head branch, update the existing draft pull request, and report its URL instead of opening a duplicate. Otherwise finish the required code changes, run focused validation, commit the result, push the current branch, and open one draft pull request with gh pr create --draft.";
    }
    return "Continue the assigned finding until it is fully complete. Finish the required code changes, run focused validation, commit the result, push the branch, and open the pull request as a draft. With GitHub CLI, use gh pr create --draft and leave it in draft until a user explicitly marks it ready for review.";
  })();

  return [
    `Automated progress check ${input.attempt} of ${input.maxAttempts}.`,
    progressContext,
    requiredAction,
    "If you are truly blocked, clearly report the blocker and the exact user action needed instead of silently stopping.",
  ].join("\n\n");
};

export class AgentDashboardImplementationRunnerError extends Schema.TaggedError<AgentDashboardImplementationRunnerError>()(
  "AgentDashboardImplementationRunnerError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
const isImplementationRunnerError = Schema.is(AgentDashboardImplementationRunnerError);

export interface AgentDashboardImplementationRunnerService {
  readonly runFinding: (input: {
    readonly finding: AgentDashboardFinding;
    readonly project: OrchestrationProjectShell;
    readonly modelSelection: ModelSelection;
    readonly consolidatePullRequests: boolean;
  }) => Effect.Effect<
    AgentDashboardImplementationRunResult | null,
    AgentDashboardImplementationRunnerError
  >;
  readonly nudgeFinding: (input: {
    readonly finding: AgentDashboardFinding;
    readonly result: AgentDashboardImplementationRunResult;
    readonly modelSelection: ModelSelection;
    readonly runId: string;
    readonly reason: AgentDashboardImplementationNudgeReason;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly consolidatePullRequests: boolean;
  }) => Effect.Effect<void, AgentDashboardImplementationRunnerError>;
  readonly settleCompletedFinding: (input: {
    readonly finding: AgentDashboardFinding;
    readonly project: OrchestrationProjectShell;
    readonly result: AgentDashboardImplementationRunResult;
    readonly runId: string;
    readonly removeCompletedWorktree: boolean;
    readonly outcome:
      | { readonly kind: "pull-request-delivered" }
      | { readonly kind: "finding-stale"; readonly reason: string };
  }) => Effect.Effect<void, AgentDashboardImplementationRunnerError>;
}

export class AgentDashboardImplementationRunner extends Context.Service<
  AgentDashboardImplementationRunner,
  AgentDashboardImplementationRunnerService
>()("t3/agentDashboard/AgentDashboardImplementationRunner") {}

export const implementationBaseTargetFromRefs = (
  result: VcsListRefsResult,
  trackedRemoteName: string | null,
): { readonly branch: string; readonly remoteName: string | null } | null => {
  const ref = result.refs.find((candidate) => candidate.isDefault);
  if (!ref) return null;
  if (!ref.isRemote) return { branch: ref.name, remoteName: trackedRemoteName };
  let branch: string;
  if (ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)) {
    branch = ref.name.slice(ref.remoteName.length + 1);
  } else {
    const separator = ref.name.indexOf("/");
    branch = separator >= 0 ? ref.name.slice(separator + 1) : ref.name;
  }
  return { branch, remoteName: trackedRemoteName ?? ref.remoteName ?? null };
};

export const defaultBranchFromRefs = (result: VcsListRefsResult): string | null =>
  implementationBaseTargetFromRefs(result, null)?.branch ?? null;

export const buildCompletedImplementationCleanupCommands = (input: {
  readonly threadId: ThreadId;
  readonly settleCommandId: CommandId;
  readonly stopCommandId: CommandId;
  readonly createdAt: string;
}) => ({
  settle: {
    type: "thread.settle" as const,
    commandId: input.settleCommandId,
    threadId: input.threadId,
  },
  stop: {
    type: "thread.session.stop" as const,
    commandId: input.stopCommandId,
    threadId: input.threadId,
    createdAt: input.createdAt,
    onlyIfSettled: true,
  },
});

export const buildCompletedImplementationWorktreeRemovalInput = (input: {
  readonly projectCwd: string;
  readonly worktreePath: string;
}) => ({
  cwd: input.projectCwd,
  path: input.worktreePath,
  // Git requires --force for a worktree containing initialized submodules,
  // even when it is clean. The driver verifies tracked, untracked, and
  // submodule state first so unexpected local work is never discarded.
  forceIfClean: true,
});

export const buildCompletedImplementationCleanupAudit = (input: {
  readonly completionResult: string;
  readonly removeCompletedWorktree: boolean;
  readonly worktreeRemovalFailed: boolean;
}): { readonly status: "succeeded" | "failed"; readonly result: string } => {
  if (!input.removeCompletedWorktree) {
    return {
      status: "succeeded",
      result: `${input.completionResult} The worktree was retained by the cleanup setting.`,
    };
  }
  return input.worktreeRemovalFailed
    ? {
        status: "failed",
        result: `${input.completionResult} The worktree was retained because safe removal failed; inspect it for local changes.`,
      }
    : {
        status: "succeeded",
        result: `${input.completionResult} The completed worktree was removed.`,
      };
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const store = AgentDashboardStore.getStore(config.stateDir);

  const randomUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new AgentDashboardImplementationRunnerError({
          operation: "generate identifier",
          message: "T3 could not generate an implementation session identifier.",
          cause,
        }),
    ),
  );
  const commandId = (kind: string) =>
    randomUuid.pipe(
      Effect.map((id) => CommandId.make(`server:continuous-improvement:${kind}:${id}`)),
    );
  const dispatch = (command: Parameters<typeof orchestration.dispatch>[0]) =>
    startup.enqueueCommand(orchestration.dispatch(command)).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDashboardImplementationRunnerError({
            operation: `dispatch ${command.type}`,
            message: cause instanceof Error ? cause.message : "Implementation launch failed.",
            cause,
          }),
      ),
    );

  const runFinding: AgentDashboardImplementationRunnerService["runFinding"] = (input) =>
    Effect.gen(function* () {
      const refs = yield* git
        .listRefs({
          cwd: input.project.workspaceRoot,
          includeMatchingRemoteRefs: true,
          limit: 200,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentDashboardImplementationRunnerError({
                operation: "resolve default branch",
                message: `T3 could not identify the default branch for ${input.project.title}.`,
                cause,
              }),
          ),
        );
      const reportedDefaultBranch = defaultBranchFromRefs(refs);
      const localStatus = reportedDefaultBranch
        ? null
        : yield* git.localStatus({ cwd: input.project.workspaceRoot }).pipe(
            Effect.mapError(
              (cause) =>
                new AgentDashboardImplementationRunnerError({
                  operation: "resolve default branch",
                  message: `T3 could not inspect the current branch for ${input.project.title}.`,
                  cause,
                }),
            ),
          );
      const baseBranch =
        reportedDefaultBranch ??
        (localStatus?.refName === "main" || localStatus?.refName === "master"
          ? localStatus.refName
          : null);
      if (!baseBranch) {
        return yield* new AgentDashboardImplementationRunnerError({
          operation: "resolve default branch",
          message: `T3 could not identify the default branch for ${input.project.title}.`,
        });
      }
      const trackedRemoteName = yield* git
        .resolveBranchRemoteName({
          cwd: input.project.workspaceRoot,
          branchName: baseBranch,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentDashboardImplementationRunnerError({
                operation: "resolve default branch remote",
                message: `T3 could not identify the tracked remote for ${input.project.title}.`,
                cause,
              }),
          ),
        );
      const defaultTarget = implementationBaseTargetFromRefs(refs, trackedRemoteName);
      const remoteName =
        trackedRemoteName ?? defaultTarget?.remoteName ?? (refs.hasPrimaryRemote ? "origin" : null);

      const threadId = ThreadId.make(yield* randomUuid);
      const claim = {
        id: input.finding.id,
        projectId: input.project.id,
        threadId,
      };
      const claimed = yield* store.claimFindingThread(claim).pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardImplementationRunnerError({
              operation: "claim finding",
              message: "T3 could not reserve the finding for continuous implementation.",
              cause,
            }),
        ),
      );
      if (claimed !== "applied") return null;

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const title = `Work on: ${input.finding.title}`.slice(0, 80);
      const branchSeed = yield* randomUuid;
      const branch = buildTemporaryWorktreeBranchName(() => branchSeed);
      let threadCreated = false;
      let worktreePath: string | null = null;

      const launch = Effect.gen(function* () {
        yield* dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId,
          projectId: input.project.id,
          title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        threadCreated = true;

        let baseRef = baseBranch;
        const hasRemote =
          remoteName !== null &&
          (yield* git.remoteExists({
            cwd: input.project.workspaceRoot,
            remoteName,
          }));
        if (remoteName !== null && hasRemote) {
          yield* git.fetchRemote({ cwd: input.project.workspaceRoot, remoteName });
          baseRef = (yield* git.resolveRemoteTrackingCommit({
            cwd: input.project.workspaceRoot,
            refName: baseBranch,
            fallbackRemoteName: remoteName,
          })).commitSha;
        }
        const worktree = yield* git.createWorktree({
          cwd: input.project.workspaceRoot,
          refName: baseRef,
          newRefName: branch,
          baseRefName: baseBranch,
          path: null,
        });
        const targetWorktreePath = worktree.worktree.path;
        worktreePath = targetWorktreePath;

        yield* dispatch({
          type: "thread.meta.update",
          commandId: yield* commandId("thread-meta-update"),
          threadId,
          branch: worktree.worktree.refName,
          worktreePath: targetWorktreePath,
        });
        yield* setupScripts
          .runForThread({
            threadId,
            projectId: input.project.id,
            projectCwd: input.project.workspaceRoot,
            worktreePath: targetWorktreePath,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Continuous improvement setup script did not start", {
                findingId: input.finding.id,
                threadId,
                cause,
              }),
            ),
            Effect.ignore,
          );

        yield* dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-start"),
          threadId,
          message: {
            messageId: MessageId.make(yield* randomUuid),
            role: "user",
            text: buildAgentDashboardFindingPrompt(
              {
                finding: input.finding,
                type: input.finding.type,
                projectName: input.project.title,
                repositoryPath: input.project.workspaceRoot,
              },
              {
                kind: "implement",
                baseBranch,
                pullRequestStrategy: input.consolidatePullRequests
                  ? "consolidate-related"
                  : "new-draft",
              },
            ),
            attachments: [],
          },
          modelSelection: input.modelSelection,
          titleSeed: title,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt,
        });

        yield* store
          .appendExternalAction({
            id: `action:continuous-improvement:${yield* randomUuid}`,
            kind: "open-thread",
            status: "succeeded",
            actor: "continuous-improvement",
            targetId: threadId,
            targetUrl: null,
            findingId: input.finding.id,
            runId: input.finding.lastRunId,
            result: `Implementation agent started on ${branch} targeting ${baseBranch}.`,
            occurredAt: createdAt,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Continuous improvement launch audit could not be persisted", {
                findingId: input.finding.id,
                threadId,
                cause,
              }),
            ),
            Effect.ignore,
          );

        return {
          findingId: input.finding.id,
          projectId: input.project.id,
          threadId,
          branch,
          baseBranch,
          worktreePath: targetWorktreePath,
        } satisfies AgentDashboardImplementationRunResult;
      }).pipe(
        Effect.mapError((cause) =>
          isImplementationRunnerError(cause)
            ? cause
            : new AgentDashboardImplementationRunnerError({
                operation: "launch implementation",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Continuous implementation failed to start.",
                cause,
              }),
        ),
      );

      return yield* launch.pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            if (threadCreated) {
              yield* dispatch({
                type: "thread.delete",
                commandId: yield* commandId("thread-cleanup"),
                threadId,
              }).pipe(Effect.ignore);
            }
            if (worktreePath !== null) {
              yield* git
                .removeWorktree({
                  cwd: input.project.workspaceRoot,
                  path: worktreePath,
                  force: true,
                })
                .pipe(Effect.ignore);
            }
            yield* store.releaseFindingThread(claim).pipe(Effect.ignore);
          }),
        ),
      );
    });

  const nudgeFinding: AgentDashboardImplementationRunnerService["nudgeFinding"] = (input) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("turn-nudge"),
        threadId: input.result.threadId,
        message: {
          messageId: MessageId.make(yield* randomUuid),
          role: "user",
          text: buildAgentDashboardImplementationNudgePrompt(input),
          attachments: [],
        },
        modelSelection: input.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      });

      yield* store
        .appendExternalAction({
          id: `action:continuous-improvement-nudge:${yield* randomUuid}`,
          kind: "other",
          status: "succeeded",
          actor: "continuous-improvement",
          targetId: input.result.threadId,
          targetUrl: null,
          findingId: input.finding.id,
          runId: input.runId,
          result: `Progress check ${input.attempt} of ${input.maxAttempts} sent to ${input.result.branch}.`,
          occurredAt: createdAt,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Continuous improvement nudge audit could not be persisted", {
              findingId: input.finding.id,
              threadId: input.result.threadId,
              cause,
            }),
          ),
          Effect.ignore,
        );
    });

  const settleCompletedFinding: AgentDashboardImplementationRunnerService["settleCompletedFinding"] =
    (input) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const completionResult =
          input.outcome.kind === "pull-request-delivered"
            ? `Completed implementation session stopped after pull request delivery from ${input.result.branch}.`
            : `Completed implementation session stopped after the agent confirmed the finding was stale: ${input.outcome.reason}`;
        const commands = buildCompletedImplementationCleanupCommands({
          threadId: input.result.threadId,
          settleCommandId: yield* commandId("thread-settle"),
          stopCommandId: yield* commandId("session-stop"),
          createdAt,
        });

        yield* dispatch(commands.settle);
        yield* dispatch(commands.stop);

        let worktreeRemovalFailed = false;
        if (input.removeCompletedWorktree) {
          const worktreeRemovalResult = yield* Effect.result(
            git.removeWorktree(
              buildCompletedImplementationWorktreeRemovalInput({
                projectCwd: input.project.workspaceRoot,
                worktreePath: input.result.worktreePath,
              }),
            ),
          );
          if (Result.isFailure(worktreeRemovalResult)) {
            worktreeRemovalFailed = true;
            yield* Effect.logWarning(
              "Continuous improvement retained a completed worktree because safe removal failed",
              {
                findingId: input.finding.id,
                threadId: input.result.threadId,
                worktreePath: input.result.worktreePath,
                cause: worktreeRemovalResult.failure,
              },
            );
          }
        }
        const cleanupAudit = buildCompletedImplementationCleanupAudit({
          completionResult,
          removeCompletedWorktree: input.removeCompletedWorktree,
          worktreeRemovalFailed,
        });

        yield* store
          .appendExternalAction({
            id: `action:continuous-improvement-finished:${yield* randomUuid}`,
            kind: "other",
            status: cleanupAudit.status,
            actor: "continuous-improvement",
            targetId: input.result.threadId,
            targetUrl: null,
            findingId: input.finding.id,
            runId: input.runId,
            result: cleanupAudit.result,
            occurredAt: createdAt,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Continuous improvement completion audit could not be persisted", {
                findingId: input.finding.id,
                threadId: input.result.threadId,
                cause,
              }),
            ),
            Effect.ignore,
          );
      });

  return {
    runFinding,
    nudgeFinding,
    settleCompletedFinding,
  } satisfies AgentDashboardImplementationRunnerService;
});

export const layer = Layer.effect(AgentDashboardImplementationRunner, make);
