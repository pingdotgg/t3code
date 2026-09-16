/**
 * Auggie text generation — intentionally unimplemented.
 *
 * Every helper here (thread titles, commit messages, PR bodies, branch names)
 * runs in the background, several times per turn. Augment bills metered
 * credits rather than a flat subscription, so wiring these to Auggie would
 * quietly spend a user's balance on work they never asked for. Until that is
 * an explicit opt-in, the instance reports the capability as unavailable.
 *
 * Callers treat a `TextGenerationError` as "skip this nicety": the thread
 * keeps its default title and the commit message stays hand-written. Only a
 * user whose *only* enabled provider is Auggie reaches this path, because
 * `textGenerationModelSelection` is a separate setting that defaults to the
 * first enabled provider.
 *
 * @module textGeneration/AuggieTextGeneration
 */
import * as Effect from "effect/Effect";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Auggie does not provide text generation. Pick another provider under Settings -> Text generation.",
    }),
  );

export const makeAuggieTextGeneration = (): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
