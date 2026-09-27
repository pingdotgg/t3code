import {
  GitPullRequestAssociation,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { PullRequestCreationIntentRepositoryError } from "../Errors.ts";

export const PullRequestCreationIntent = Schema.Struct({
  actionId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  localBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  headSelector: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
  nextAttemptAt: IsoDateTime,
  attemptCount: NonNegativeInt,
  pullRequest: Schema.NullOr(GitPullRequestAssociation),
});
export type PullRequestCreationIntent = typeof PullRequestCreationIntent.Type;

export type PullRequestCreationIntentInput = Omit<
  PullRequestCreationIntent,
  "requestedAt" | "nextAttemptAt" | "attemptCount" | "pullRequest"
>;

export interface PullRequestCreationIntentRepositoryShape {
  readonly insert: (
    intent: PullRequestCreationIntent,
  ) => Effect.Effect<void, PullRequestCreationIntentRepositoryError>;
  readonly getByActionId: (input: {
    readonly actionId: string;
  }) => Effect.Effect<
    Option.Option<PullRequestCreationIntent>,
    PullRequestCreationIntentRepositoryError
  >;
  readonly listDue: (input: {
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<PullRequestCreationIntent>,
    PullRequestCreationIntentRepositoryError
  >;
  readonly save: (
    intent: PullRequestCreationIntent,
  ) => Effect.Effect<void, PullRequestCreationIntentRepositoryError>;
  readonly deleteByActionId: (input: {
    readonly actionId: string;
  }) => Effect.Effect<void, PullRequestCreationIntentRepositoryError>;
}

export class PullRequestCreationIntentRepository extends Context.Service<
  PullRequestCreationIntentRepository,
  PullRequestCreationIntentRepositoryShape
>()("t3/persistence/Services/PullRequestCreationIntents/PullRequestCreationIntentRepository") {}
