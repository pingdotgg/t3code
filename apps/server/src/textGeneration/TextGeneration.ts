import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

interface FallbackInput {
  /** Tried once when `modelSelection` fails. */
  readonly fallbackModelSelection?: ModelSelection | null | undefined;
}

type TextGenerationShape = {
  readonly [Op in keyof ProviderTextGeneration]: (
    input: Parameters<ProviderTextGeneration[Op]>[0] & FallbackInput,
  ) => ReturnType<ProviderTextGeneration[Op]>;
};

export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/**
 * Runs `attempt` with `primary`, then once with `fallback` when it fails.
 * Callers use this directly instead of `fallbackModelSelection` when the input
 * or the result depends on which model ran.
 */
export const withModelFallback = <A, R>(
  operation: TextGenerationOp,
  primary: ModelSelection,
  fallback: ModelSelection | null | undefined,
  attempt: (modelSelection: ModelSelection) => Effect.Effect<A, TextGenerationError, R>,
): Effect.Effect<A, TextGenerationError, R> => {
  if (
    !fallback ||
    (fallback.instanceId === primary.instanceId && fallback.model === primary.model)
  ) {
    return attempt(primary);
  }
  return attempt(primary).pipe(
    Effect.catch((primaryError) =>
      Effect.logWarning("Text generation failed, trying the fallback model", {
        operation,
        instanceId: primary.instanceId,
        model: primary.model,
        fallbackInstanceId: fallback.instanceId,
        fallbackModel: fallback.model,
        detail: primaryError.detail,
      }).pipe(
        Effect.andThen(attempt(fallback)),
        Effect.tapError((fallbackError) =>
          Effect.logWarning("Text generation fallback model failed", {
            operation,
            fallbackInstanceId: fallback.instanceId,
            fallbackModel: fallback.model,
            detail: fallbackError.detail,
          }),
        ),
        // The configured model's error is the one the user can act on.
        Effect.mapError(() => primaryError),
      ),
    ),
  );
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const withFallback = <A>(
    operation: TextGenerationOp,
    primary: ModelSelection,
    fallback: ModelSelection | null | undefined,
    run: (
      textGeneration: ProviderInstance["textGeneration"],
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ): Effect.Effect<A, TextGenerationError> =>
    withModelFallback(operation, primary, fallback, (modelSelection) =>
      resolveInstance(registry, operation, modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => run(textGeneration, modelSelection)),
      ),
    );

  return TextGeneration.of({
    generateCommitMessage: ({ fallbackModelSelection, ...input }) =>
      withFallback(
        "generateCommitMessage",
        input.modelSelection,
        fallbackModelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
      ),
    generatePrContent: ({ fallbackModelSelection, ...input }) =>
      withFallback(
        "generatePrContent",
        input.modelSelection,
        fallbackModelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generatePrContent({ ...input, modelSelection }),
      ),
    generateBranchName: ({ fallbackModelSelection, ...input }) =>
      withFallback(
        "generateBranchName",
        input.modelSelection,
        fallbackModelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
      ),
    generateReviewGuide: ({ fallbackModelSelection, ...input }) =>
      withFallback(
        "generateReviewGuide",
        input.modelSelection,
        fallbackModelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateReviewGuide({ ...input, modelSelection }),
      ),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function* ({
      fallbackModelSelection,
      ...input
    }) {
      // Resolved before the first attempt so a fallback does not repeat the lookup.
      const linkedContext =
        input.linkedContext ??
        (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
          Effect.provideService(
            SourceControlProviderRegistry.SourceControlProviderRegistry,
            sourceControl,
          ),
        ));
      return yield* withFallback(
        "generateThreadTitle",
        input.modelSelection,
        fallbackModelSelection,
        (textGeneration, modelSelection) =>
          textGeneration.generateThreadTitle({ ...input, linkedContext, modelSelection }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make);
