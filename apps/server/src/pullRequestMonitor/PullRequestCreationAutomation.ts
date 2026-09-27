import {
  CommandId,
  GitManagerError,
  GitRunStackedActionResult,
  type GitPullRequestAssociation,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Clock, Context, Option, Result } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { GitHubPullRequestSummary } from "../git/Services/GitHubCli.ts";
import { GitHubCli } from "../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  type PullRequestCreationIntent,
  type PullRequestCreationIntentInput,
  PullRequestCreationIntentRepository,
} from "../persistence/Services/PullRequestCreationIntents.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import {
  pullRequestAssociationRepositoryBlockReason,
  pullRequestAssociationRetryAt,
} from "./pullRequestAssociationValidation.ts";

const INITIAL_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const MAX_UNRESOLVED_AGE_MS = 24 * 60 * 60_000;
const RECOVERY_BATCH_SIZE = 100;

export interface PullRequestCreationAutomationShape {
  readonly recordIntent: (
    input: PullRequestCreationIntentInput,
  ) => Effect.Effect<void, GitManagerError>;
  readonly handleCreatedResult: (input: {
    readonly actionId: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly pullRequest: GitRunStackedActionResult["pr"];
  }) => Effect.Effect<void, GitManagerError>;
  readonly recoverPending: () => Effect.Effect<void>;
}

export class PullRequestCreationAutomation extends Context.Service<
  PullRequestCreationAutomation,
  PullRequestCreationAutomationShape
>()("t3/pullRequestMonitor/PullRequestCreationAutomation") {}

function gitManagerError(operation: string, cause: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function failGitManager(operation: string, detail: string): Effect.Effect<never, GitManagerError> {
  return Effect.fail(new GitManagerError({ operation, detail }));
}

function sameIntentBinding(
  left: PullRequestCreationIntent,
  right: PullRequestCreationIntentInput,
): boolean {
  return (
    left.actionId === right.actionId &&
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.cwd === right.cwd &&
    left.localBranch === right.localBranch &&
    left.headBranch === right.headBranch &&
    left.headSelector === right.headSelector &&
    left.baseBranch === right.baseBranch &&
    left.headSha === right.headSha
  );
}

function resolveIntentProject(input: {
  readonly intent: Pick<PullRequestCreationIntent, "threadId" | "projectId" | "cwd">;
  readonly readModel: OrchestrationReadModel;
}): OrchestrationProject | null {
  const thread = input.readModel.threads.find(
    (candidate) => candidate.id === input.intent.threadId,
  );
  const project = input.readModel.projects.find(
    (candidate) => candidate.id === input.intent.projectId,
  );
  if (
    !thread ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    thread.projectId !== input.intent.projectId ||
    !project
  ) {
    return null;
  }

  const boundCwd = resolveThreadWorkspaceCwd({
    thread,
    projects: input.readModel.projects,
  });
  if (boundCwd !== undefined) {
    return boundCwd === input.intent.cwd ? project : null;
  }
  return thread.worktreePath === null &&
    thread.workspaceBinding == null &&
    project.workspaceRoot === input.intent.cwd
    ? project
    : null;
}

function pullRequestFromCreatedResult(
  result: GitRunStackedActionResult["pr"],
): GitPullRequestAssociation | null {
  if (
    result.status !== "created" ||
    result.number === undefined ||
    result.url === undefined ||
    result.url.trim().length === 0 ||
    result.title === undefined ||
    result.baseBranch === undefined ||
    result.headBranch === undefined
  ) {
    return null;
  }
  return {
    number: result.number,
    title: result.title,
    url: result.url,
    baseBranch: result.baseBranch,
    headBranch: result.headBranch,
    ...(result.headSha === undefined ? {} : { headSha: result.headSha }),
    ...(result.isCrossRepository === undefined
      ? {}
      : { isCrossRepository: result.isCrossRepository }),
    ...(result.headRepositoryNameWithOwner === undefined
      ? {}
      : { headRepositoryNameWithOwner: result.headRepositoryNameWithOwner }),
    state: "open",
  };
}

function pullRequestFromGitHubSummary(
  summary: GitHubPullRequestSummary,
): GitPullRequestAssociation {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseBranch: summary.baseRefName,
    headBranch: summary.headRefName,
    ...(summary.headRefOid === undefined ? {} : { headSha: summary.headRefOid }),
    ...(summary.isCrossRepository === undefined
      ? {}
      : { isCrossRepository: summary.isCrossRepository }),
    ...(summary.headRepositoryNameWithOwner === undefined
      ? {}
      : { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }),
    state: summary.state ?? "open",
  };
}

function matchesCreationIntent(
  summary: GitHubPullRequestSummary,
  intent: PullRequestCreationIntent,
): boolean {
  return (
    (summary.state === undefined || summary.state === "open") &&
    summary.baseRefName === intent.baseBranch &&
    summary.headRefName === intent.headBranch &&
    summary.headRefOid === intent.headSha
  );
}

export const makePullRequestCreationAutomation = () =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const gitHubCli = yield* GitHubCli;
    const repository = yield* PullRequestCreationIntentRepository;

    const save = (intent: PullRequestCreationIntent, operation: string) =>
      repository.save(intent).pipe(Effect.mapError((cause) => gitManagerError(operation, cause)));
    const deleteIntent = (actionId: string, operation: string) =>
      repository
        .deleteByActionId({ actionId })
        .pipe(Effect.mapError((cause) => gitManagerError(operation, cause)));

    const dispatchCreatedLink = (intent: PullRequestCreationIntent) =>
      Effect.gen(function* () {
        if (intent.pullRequest === null) return;
        yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: CommandId.make(`server:created-pr:${intent.actionId}`),
            threadId: intent.threadId,
            pullRequest: intent.pullRequest,
            source: "created",
          })
          .pipe(Effect.mapError((cause) => gitManagerError("linkCreatedPullRequest", cause)));
        yield* deleteIntent(intent.actionId, "deleteCreatedPullRequestIntent");
      });

    const persistAndDispatchCreatedLink = (
      intent: PullRequestCreationIntent,
      project: OrchestrationProject,
      pullRequest: GitPullRequestAssociation,
    ) =>
      Effect.gen(function* () {
        if (project.repositoryIdentity == null) {
          yield* Effect.logWarning(
            "created PR association is waiting for project repository identity",
            { actionId: intent.actionId },
          );
          return;
        }
        if (
          pullRequestAssociationRepositoryBlockReason({
            thread: { projectId: intent.projectId },
            project,
            pullRequest,
          })
        ) {
          yield* deleteIntent(intent.actionId, "discardMismatchedCreatedPullRequest");
          yield* Effect.logWarning("discarded created PR because its repository did not match", {
            actionId: intent.actionId,
          });
          return;
        }

        const observedAt = yield* Clock.currentTimeMillis;
        const observed = {
          ...intent,
          nextAttemptAt: new Date(observedAt).toISOString(),
          pullRequest,
        };
        yield* save(observed, "saveCreatedPullRequest");
        yield* dispatchCreatedLink(observed);
      });

    const recordIntent: PullRequestCreationAutomationShape["recordIntent"] = Effect.fn(
      "recordPullRequestCreationIntent",
    )(function* (input) {
      const readModel = yield* engine
        .getReadModel()
        .pipe(
          Effect.mapError((cause) => gitManagerError("validatePullRequestCreationIntent", cause)),
        );
      if (resolveIntentProject({ intent: input, readModel }) === null) {
        return yield* failGitManager(
          "recordPullRequestCreationIntent",
          "The thread workspace changed before PR creation could be tracked.",
        );
      }

      const existing = yield* repository
        .getByActionId({ actionId: input.actionId })
        .pipe(Effect.mapError((cause) => gitManagerError("readPullRequestCreationIntent", cause)));
      if (Option.isSome(existing)) {
        if (sameIntentBinding(existing.value, input)) return;
        return yield* failGitManager(
          "recordPullRequestCreationIntent",
          "The PR action ID is already bound to a different creation intent.",
        );
      }

      const requestedAtMillis = yield* Clock.currentTimeMillis;
      const requestedAt = new Date(requestedAtMillis).toISOString();
      const intent: PullRequestCreationIntent = {
        ...input,
        requestedAt,
        nextAttemptAt: new Date(requestedAtMillis + INITIAL_RETRY_DELAY_MS).toISOString(),
        attemptCount: 0,
        pullRequest: null,
      };
      yield* repository
        .insert(intent)
        .pipe(
          Effect.mapError((cause) => gitManagerError("persistPullRequestCreationIntent", cause)),
        );

      const persisted = yield* repository
        .getByActionId({ actionId: input.actionId })
        .pipe(
          Effect.mapError((cause) => gitManagerError("verifyPullRequestCreationIntent", cause)),
        );
      if (Option.isNone(persisted) || !sameIntentBinding(persisted.value, input)) {
        return yield* failGitManager(
          "verifyPullRequestCreationIntent",
          "The PR creation intent was not durably recorded.",
        );
      }
    });

    const handleCreatedResult: PullRequestCreationAutomationShape["handleCreatedResult"] =
      Effect.fn("handleCreatedPullRequestResult")(function* (input) {
        if (input.pullRequest.status !== "created") return;
        const existing = yield* repository
          .getByActionId({ actionId: input.actionId })
          .pipe(
            Effect.mapError((cause) => gitManagerError("readPullRequestCreationIntent", cause)),
          );
        if (Option.isNone(existing)) return;

        const intent = existing.value;
        if (
          intent.threadId !== input.threadId ||
          intent.projectId !== input.projectId ||
          intent.cwd !== input.cwd
        ) {
          return yield* failGitManager(
            "handleCreatedPullRequestResult",
            "The created PR result does not match its durable creation intent.",
          );
        }

        const pullRequest = pullRequestFromCreatedResult(input.pullRequest);
        if (pullRequest === null) return;
        if (
          pullRequest.baseBranch !== intent.baseBranch ||
          pullRequest.headBranch !== intent.headBranch
        ) {
          return yield* failGitManager(
            "handleCreatedPullRequestResult",
            "The created PR branches do not match the durable creation intent.",
          );
        }

        const readModel = yield* engine
          .getReadModel()
          .pipe(Effect.mapError((cause) => gitManagerError("validateCreatedPullRequest", cause)));
        const project = resolveIntentProject({ intent, readModel });
        if (project === null) {
          yield* deleteIntent(intent.actionId, "discardCreatedPullRequestForChangedWorkspace");
          yield* Effect.logWarning(
            "discarded created PR because its thread or project workspace changed",
            { actionId: intent.actionId },
          );
          return;
        }
        yield* persistAndDispatchCreatedLink(intent, project, pullRequest);
      });

    const retry = (intent: PullRequestCreationIntent, cause?: unknown) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rateLimitRetry =
          cause === undefined ? null : pullRequestAssociationRetryAt(cause, now);
        const delay = Math.min(
          INITIAL_RETRY_DELAY_MS * 2 ** Math.min(intent.attemptCount, 4),
          MAX_RETRY_DELAY_MS,
        );
        yield* save(
          {
            ...intent,
            attemptCount: intent.attemptCount + 1,
            nextAttemptAt: rateLimitRetry ?? new Date(now + delay).toISOString(),
          },
          "schedulePullRequestCreationRetry",
        );
      });

    const discard = (intent: PullRequestCreationIntent, reason: string) =>
      deleteIntent(intent.actionId, "discardPullRequestCreationIntent").pipe(
        Effect.tap(() =>
          Effect.logWarning("discarded unresolved PR creation intent", {
            actionId: intent.actionId,
            reason,
          }),
        ),
      );

    const recoverOne = (intent: PullRequestCreationIntent) =>
      Effect.gen(function* () {
        const readModel = yield* engine.getReadModel();
        const project = resolveIntentProject({ intent, readModel });
        if (project === null) {
          yield* discard(intent, "thread-or-workspace-changed");
          return;
        }
        if (intent.pullRequest !== null) {
          yield* dispatchCreatedLink(intent);
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        if (now - Date.parse(intent.requestedAt) > MAX_UNRESOLVED_AGE_MS) {
          yield* discard(intent, "expired");
          return;
        }
        if (project.repositoryIdentity == null) {
          yield* retry(intent);
          return;
        }

        const lookup = yield* Effect.result(
          gitHubCli.listOpenPullRequests({
            cwd: intent.cwd,
            headSelector: intent.headSelector,
            limit: 100,
          }),
        );
        if (Result.isFailure(lookup)) {
          yield* retry(intent, lookup.failure);
          yield* Effect.logWarning("PR creation intent lookup failed; retrying", {
            actionId: intent.actionId,
            error: lookup.failure._tag,
          });
          return;
        }

        const summary = lookup.success.find((candidate) =>
          matchesCreationIntent(candidate, intent),
        );
        if (!summary) {
          yield* retry(intent);
          return;
        }

        const pullRequest = pullRequestFromGitHubSummary(summary);
        yield* persistAndDispatchCreatedLink(intent, project, pullRequest);
      });

    const recoverSafely = (intent: PullRequestCreationIntent) =>
      recoverOne(intent).pipe(
        Effect.catch((error) =>
          Effect.logWarning("PR creation intent recovery failed; retrying", {
            actionId: intent.actionId,
            error: error._tag,
          }),
        ),
      );

    const recoverPending: PullRequestCreationAutomationShape["recoverPending"] = Effect.fn(
      "recoverPullRequestCreationIntents",
    )(function* () {
      const now = yield* Clock.currentTimeMillis;
      const dueResult = yield* Effect.result(
        repository.listDue({
          now: new Date(now).toISOString(),
          limit: RECOVERY_BATCH_SIZE,
        }),
      );
      if (Result.isFailure(dueResult)) {
        yield* Effect.logWarning("failed to list PR creation intents", {
          error: dueResult.failure._tag,
        });
        return;
      }
      yield* Effect.forEach(dueResult.success, recoverSafely, { concurrency: 2, discard: true });
    });

    return {
      recordIntent,
      handleCreatedResult,
      recoverPending,
    } satisfies PullRequestCreationAutomationShape;
  });

export const PullRequestCreationAutomationLive = Layer.effect(
  PullRequestCreationAutomation,
  makePullRequestCreationAutomation(),
);
