import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

export const makeLazyTextGeneration = Effect.fn("makeLazyTextGeneration")(function* <R>(
  make: Effect.Effect<ProviderTextGeneration, never, R>,
) {
  const context = yield* Effect.context<R | Scope.Scope>();
  // A cancelled first request must not cancel construction shared by another request.
  const initialize = yield* Effect.cached(
    make.pipe(Effect.provideContext(context), Effect.forkIn(Context.get(context, Scope.Scope))),
  );
  const service = initialize.pipe(Effect.flatMap(Fiber.join));
  return {
    generateCommitMessage: (input) =>
      Effect.flatMap(service, (value) => value.generateCommitMessage(input)),
    generatePrContent: (input) =>
      Effect.flatMap(service, (value) => value.generatePrContent(input)),
    generateBranchName: (input) =>
      Effect.flatMap(service, (value) => value.generateBranchName(input)),
    generateThreadTitle: (input) =>
      Effect.flatMap(service, (value) => value.generateThreadTitle(input)),
    generateReviewGuide: (input) =>
      Effect.flatMap(service, (value) => value.generateReviewGuide(input)),
    generateTranscriptionPostProcessing: (input) =>
      Effect.flatMap(service, (value) => value.generateTranscriptionPostProcessing(input)),
  } satisfies ProviderTextGeneration;
});
