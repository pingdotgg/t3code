/** Registers a durable GitHub waitpoint from a provider dynamic-tool call. */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  GitHubWaitpointRepository,
  type GitHubWaitpointCondition,
  type GitHubWaitpointRepositoryError,
} from "../persistence/GitHubWaitpoints.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  GitHubPullRequestProbe,
  type GitHubPullRequestProbeError,
} from "./GitHubPullRequestProbe.ts";

const FIRST_POLL_DELAY_SECONDS = 30;

export interface RegisterGitHubWaitpointInput {
  readonly idempotencyKey: string;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly condition: GitHubWaitpointCondition;
  readonly timeoutMinutes: number;
  readonly reason?: string;
}

export type GitHubWaitpointRegistrationError =
  | GitHubPullRequestProbeError
  | GitHubWaitpointRepositoryError
  | ProjectionRepositoryError
  | GitHubWaitpointRegistrationThreadUnavailableError
  | GitHubWaitpointRegistrationUnavailableError;

export class GitHubWaitpointRegistrationThreadUnavailableError extends Schema.TaggedErrorClass<GitHubWaitpointRegistrationThreadUnavailableError>()(
  "GitHubWaitpointRegistrationThreadUnavailableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Cannot register a GitHub wait because thread ${this.threadId} has no current T3 turn.`;
  }
}

export class GitHubWaitpointRegistrationUnavailableError extends Schema.TaggedErrorClass<GitHubWaitpointRegistrationUnavailableError>()(
  "GitHubWaitpointRegistrationUnavailableError",
  {},
) {
  override get message(): string {
    return "Durable GitHub waitpoint registration is unavailable.";
  }
}

export interface GitHubWaitpointRegistrationService {
  readonly register: (
    input: RegisterGitHubWaitpointInput,
  ) => Effect.Effect<{ readonly id: string }, GitHubWaitpointRegistrationError>;
}

export class GitHubWaitpointRegistration extends Context.Reference<GitHubWaitpointRegistrationService>(
  "t3/github/GitHubWaitpointRegistration/GitHubWaitpointRegistration",
  {
    defaultValue: () => ({
      register: () => Effect.fail(new GitHubWaitpointRegistrationUnavailableError()),
    }),
  },
) {}

function conditionLabel(condition: GitHubWaitpointCondition): string {
  switch (condition) {
    case "checks_settled":
      return "all reported checks have settled";
    case "new_review_activity":
      return "new review or comment activity is available";
    case "pull_request_closed":
      return "the pull request has merged or closed";
  }
}

function continuationPrompt(input: RegisterGitHubWaitpointInput): string {
  const reason = input.reason?.trim();
  return [
    `T3 GitHub watcher observed that ${conditionLabel(input.condition)} for ${input.repository}#${input.pullRequestNumber}.`,
    "Re-read the pull request and continue the task from the latest GitHub state.",
    ...(reason ? [`Original reason for waiting: ${reason}`] : []),
  ].join(" ");
}

export const make = Effect.gen(function* () {
  const repository = yield* GitHubWaitpointRepository;
  const probe = yield* GitHubPullRequestProbe;
  const snapshots = yield* ProjectionSnapshotQuery;

  return GitHubWaitpointRegistration.of({
    register: Effect.fn("GitHubWaitpointRegistration.register")(function* (input) {
      const id = `github:${input.threadId}:${input.idempotencyKey}`;
      const existing = yield* repository.getById({ id });
      if (Option.isSome(existing)) return { id };

      const thread = yield* snapshots.getThreadDetailById(input.threadId);
      if (Option.isNone(thread) || thread.value.latestTurn === null) {
        return yield* new GitHubWaitpointRegistrationThreadUnavailableError({
          threadId: input.threadId,
        });
      }

      const baseline = yield* probe.get({
        cwd: input.cwd,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
      });
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      yield* repository.register({
        id,
        threadId: input.threadId,
        originatingTurnId: thread.value.latestTurn.turnId,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        condition: input.condition,
        baseline,
        continuationPrompt: continuationPrompt(input),
        nextPollAt: DateTime.formatIso(DateTime.add(now, { seconds: FIRST_POLL_DELAY_SECONDS })),
        deadlineAt: DateTime.formatIso(DateTime.add(now, { minutes: input.timeoutMinutes })),
        createdAt,
      });
      yield* Effect.logInfo("github.waitpoint.registered", {
        waitpointId: id,
        threadId: input.threadId,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        condition: input.condition,
      });
      return { id };
    }),
  });
});

export const layer = Layer.effect(GitHubWaitpointRegistration, make);
