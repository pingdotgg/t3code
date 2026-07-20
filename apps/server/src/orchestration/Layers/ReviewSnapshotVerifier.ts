import { Effect, Layer } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { ReviewSnapshotVerifier } from "../Services/ReviewSnapshotVerifier.ts";

export const ReviewSnapshotVerifierLive = Layer.effect(
  ReviewSnapshotVerifier,
  Effect.gen(function* () {
    const git = yield* GitCore;
    return ReviewSnapshotVerifier.of({
      isCurrent: (input) =>
        git
          .resolveReviewChangesContext({
            cwd: input.cwd,
            scope: input.snapshot.scope.kind,
            ...(input.snapshot.scope.kind === "against-base"
              ? { baseBranch: input.snapshot.scope.baseBranch }
              : {}),
          })
          .pipe(
            Effect.map(
              (context) =>
                context.snapshot !== undefined &&
                context.snapshot.diffHash === input.snapshot.diffHash,
            ),
          ),
    });
  }),
);
