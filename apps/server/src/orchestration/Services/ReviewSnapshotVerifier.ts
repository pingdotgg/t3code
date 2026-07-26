import type { GitCommandError, ReviewSnapshot } from "@t3tools/contracts";
import { Context, Effect } from "effect";

export interface ReviewSnapshotVerifierShape {
  /**
   * Resolves the snapshot the reviewed scope produces right now, so a review
   * result can be anchored to the diff the reviewer actually inspected.
   */
  readonly currentSnapshot: (input: {
    readonly cwd: string;
    readonly snapshot: ReviewSnapshot;
  }) => Effect.Effect<ReviewSnapshot | null, GitCommandError>;
}

export class ReviewSnapshotVerifier extends Context.Service<
  ReviewSnapshotVerifier,
  ReviewSnapshotVerifierShape
>()("t3/orchestration/Services/ReviewSnapshotVerifier") {}
