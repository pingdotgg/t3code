import {
  CommandId,
  DEFAULT_REVIEW_CHANGES_SCOPE,
  MessageId,
  ThreadId,
  WorkflowArtifactId,
  WorkflowNodeId,
  WorkflowRunError,
  WorkflowRunId,
  type WorkflowRunInput,
  type WorkflowRunResult,
} from "@t3tools/contracts";
import {
  buildReviewChangesPrompt,
  isReviewChangesWorkflowEnabled,
  parseReviewChangesScope,
  REVIEW_CHANGES_WORKFLOW_ID,
} from "@t3tools/shared/workflows/reviewChanges";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { GitCore } from "../git/Services/GitCore.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import type { WorkflowCoordinatorReactor } from "./Services/WorkflowCoordinatorReactor.ts";

interface ReviewChangesWorkflowDependencies {
  readonly git: GitCore["Service"];
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly projectionSnapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly serverSettings: ServerSettingsService["Service"];
  readonly workflowCoordinator: Option.Option<WorkflowCoordinatorReactor["Service"]>;
}

const skipped = (
  input: Pick<WorkflowRunInput, "idempotencyKey">,
  reason: Extract<WorkflowRunResult, { status: "skipped" }>["reason"],
  message: string,
): WorkflowRunResult => ({
  status: "skipped",
  runId: WorkflowRunId.make(input.idempotencyKey),
  reason,
  message,
  createdAt: new Date().toISOString(),
});

export const runReviewChangesWorkflow = (
  dependencies: ReviewChangesWorkflowDependencies,
  input: WorkflowRunInput,
  options?: {
    readonly expectedHeadSha?: string;
    /** Pins `gh` capture to this repository so fork/base numbers cannot resolve elsewhere. */
    readonly expectedPullRequest?: {
      readonly repository?: string | undefined;
    };
  },
): Effect.Effect<WorkflowRunResult, WorkflowRunError> =>
  Effect.gen(function* () {
    const runId = WorkflowRunId.make(input.idempotencyKey);
    const createdAt = new Date().toISOString();
    const settings = yield* dependencies.serverSettings.getSettings;
    const reviewSettings = settings.agentWorkflows.reviewChanges;
    const override = settings.agentWorkflows.builtInOverrides[REVIEW_CHANGES_WORKFLOW_ID];
    if (!isReviewChangesWorkflowEnabled(settings.agentWorkflows)) {
      return skipped(input, "workflow-disabled", "Review Code workflow is disabled.");
    }
    if (
      input.destinationMode !== undefined &&
      input.destinationMode !== "child-chat" &&
      input.destinationMode !== "same-chat"
    ) {
      return yield* new WorkflowRunError({
        message: "Review Code supports only child-chat and same-chat destinations.",
      });
    }

    const threadOption = yield* dependencies.projectionSnapshotQuery.getThreadShellById(
      input.threadId,
    );
    const projectId =
      input.projectId ?? (Option.isSome(threadOption) ? threadOption.value.projectId : undefined);
    if (projectId === undefined) {
      return skipped(input, "thread-not-found", "Thread not found.");
    }
    const projectOption =
      yield* dependencies.projectionSnapshotQuery.getProjectShellById(projectId);
    if (Option.isNone(projectOption)) {
      return skipped(input, "project-not-found", "Project not found.");
    }
    const project = projectOption.value;
    const thread = Option.getOrUndefined(threadOption);
    if (thread === undefined && input.destinationMode !== "same-chat") {
      return skipped(input, "thread-not-found", "Thread not found.");
    }
    if (
      thread === undefined &&
      (input.modelSelection === undefined ||
        input.runtimeMode === undefined ||
        input.interactionMode === undefined)
    ) {
      return skipped(input, "thread-not-found", "Thread not found.");
    }

    const cwd = input.cwd ?? thread?.worktreePath ?? project.workspaceRoot;
    const requestedScope =
      parseReviewChangesScope(input.input?.scope) ??
      parseReviewChangesScope(override?.defaultInput?.scope) ??
      reviewSettings.defaultScope ??
      DEFAULT_REVIEW_CHANGES_SCOPE;
    const reviewContext = yield* dependencies.git.claimReviewChangesContext({
      cwd,
      scope: requestedScope,
      ...(requestedScope === "pull-request" &&
      typeof input.input?.pullRequestNumber === "number" &&
      Number.isSafeInteger(input.input.pullRequestNumber) &&
      input.input.pullRequestNumber > 0
        ? {
            pullRequestNumber: input.input.pullRequestNumber,
            ...(options?.expectedPullRequest?.repository !== undefined &&
            options.expectedPullRequest.repository.trim().length > 0
              ? { pullRequestRepository: options.expectedPullRequest.repository.trim() }
              : {}),
          }
        : {}),
    });
    if (!reviewContext.hasReviewableChanges) {
      return skipped(
        input,
        "no-reviewable-changes",
        reviewContext.scope === "against-base"
          ? "No changes against base branch."
          : reviewContext.scope === "pull-request"
            ? "This pull request has no changes."
            : "No uncommitted changes.",
      );
    }
    if (reviewContext.snapshot === undefined) {
      return yield* new WorkflowRunError({
        message: "Unable to capture an immutable review snapshot.",
      });
    }
    if (
      options?.expectedHeadSha !== undefined &&
      (reviewContext.scope !== "pull-request" ||
        reviewContext.snapshot.scope.kind !== "pull-request" ||
        reviewContext.snapshot.scope.headSha !== options.expectedHeadSha)
    ) {
      return yield* new WorkflowRunError({
        message: "Pull request head changed before the review workflow was dispatched.",
      });
    }
    if (reviewContext.scope === "pull-request" && reviewContext.pullRequest.state !== "open") {
      return skipped(input, "no-reviewable-changes", "This pull request is no longer open.");
    }

    const title =
      input.title ??
      (reviewContext.scope === "against-base"
        ? `Review changes against ${reviewContext.baseBranch}`
        : reviewContext.scope === "pull-request"
          ? `Review PR #${reviewContext.pullRequest.number}: ${reviewContext.pullRequest.title}`
          : "Review uncommitted changes");
    const prompt = buildReviewChangesPrompt({
      context:
        reviewContext.scope === "against-base"
          ? {
              scope: "against-base",
              baseBranch: reviewContext.baseBranch,
              mergeBaseSha: reviewContext.mergeBaseSha,
            }
          : reviewContext.scope === "pull-request"
            ? {
                scope: "pull-request",
                number: reviewContext.pullRequest.number,
                title: reviewContext.pullRequest.title,
                baseBranch: reviewContext.pullRequest.baseBranch,
                headBranch: reviewContext.pullRequest.headBranch,
              }
            : { scope: "uncommitted" },
      settings: {
        promptTemplate: override?.promptTemplate ?? reviewSettings.promptTemplate,
      },
    });
    const nodeId = WorkflowNodeId.make(REVIEW_CHANGES_WORKFLOW_ID);
    const modelSelection =
      reviewSettings.modelSelection ??
      input.modelSelection ??
      project.defaultModelSelection ??
      thread?.modelSelection ??
      input.modelSelection;
    if (modelSelection === undefined) {
      return yield* new WorkflowRunError({ message: "Review Code has no model selection." });
    }
    const runtimeMode = input.runtimeMode ?? thread?.runtimeMode;
    const interactionMode = input.interactionMode ?? thread?.interactionMode;
    if (runtimeMode === undefined || interactionMode === undefined) {
      return yield* new WorkflowRunError({ message: "Review Code has no runtime configuration." });
    }

    if (thread === undefined) {
      const messageId = MessageId.make(`workflow:${runId}:input`);
      yield* dependencies.orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`workflow:${runId}:create-parent`),
        threadId: input.threadId,
        projectId: project.id,
        parentThreadId: null,
        title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: reviewContext.branch,
        worktreePath: cwd === project.workspaceRoot ? null : cwd,
        reviewSnapshot: reviewContext.snapshot,
        createdAt,
      });
      const commandId = CommandId.make(`workflow:${runId}:request`);
      const dispatchResult = yield* dependencies.orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        message: { messageId, role: "user", text: prompt, attachments: [] },
        runtimeMode,
        interactionMode,
        createdAt,
      });
      return {
        status: "started" as const,
        runId,
        threadId: input.threadId,
        commandId,
        messageId,
        sequence: dispatchResult.sequence,
        createdAt,
      };
    }

    const threadId = ThreadId.make(`workflow:${runId}:node:${nodeId}:worker`);
    const commandId = CommandId.make(`workflow:${runId}:request`);
    const messageId = MessageId.make(`workflow:${runId}:node:${nodeId}:input`);
    const dispatchResult = yield* dependencies.orchestrationEngine.dispatch({
      type: "workflow.run.request",
      commandId,
      runId,
      parentThreadId: input.threadId,
      definition: {
        id: REVIEW_CHANGES_WORKFLOW_ID,
        name: title,
        nodes: [{ id: nodeId, title, prompt, contextPolicy: "none" }],
      },
      workerConfig: {
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: reviewContext.branch,
        worktreePath: cwd === project.workspaceRoot ? null : cwd,
        reviewSnapshot: reviewContext.snapshot,
      },
      inputArtifact: {
        id: WorkflowArtifactId.make(`workflow:${runId}:input`),
        runId,
        nodeId,
        producerThreadId: input.threadId,
        payload: {
          kind: "input-context",
          contextPolicy: "none",
          parentThreadId: input.threadId,
          messages: [],
          truncated: false,
        },
        createdAt,
      },
      createdAt,
    });
    if (Option.isSome(dependencies.workflowCoordinator)) {
      yield* dependencies.workflowCoordinator.value.drainRun(runId);
    }
    return {
      status: "started" as const,
      runId,
      threadId,
      commandId,
      messageId,
      sequence: dispatchResult.sequence,
      createdAt,
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new WorkflowRunError({
          message: cause instanceof Error ? cause.message : "Failed to run Review Code.",
          cause,
        }),
    ),
  );
