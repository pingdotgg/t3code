import type { GitCommandError, ReviewSnapshot } from "@t3tools/contracts";
import { Context, Effect } from "effect";

export interface ReviewSnapshotVerifierShape {
  readonly isCurrent: (input: {
    readonly cwd: string;
    readonly snapshot: ReviewSnapshot;
  }) => Effect.Effect<boolean, GitCommandError>;
}

export class ReviewSnapshotVerifier extends Context.Service<
  ReviewSnapshotVerifier,
  ReviewSnapshotVerifierShape
>()("t3/orchestration/Services/ReviewSnapshotVerifier") {}
