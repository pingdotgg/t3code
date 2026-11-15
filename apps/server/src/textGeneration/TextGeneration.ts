import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  TextGenerationOperation,
} from "@t3tools/contracts";
import {
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as TextGenerators from "./TextGenerators.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

export type {
  ConversationSummaryGenerationInput,
  ConversationSummaryGenerationResult,
  KnowledgeCandidatesGenerationInput,
  KnowledgeCandidatesGenerationResult,
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
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

const resolveInstance = Effect.fn("TextGeneration.resolveInstance")(function* (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOperation,
  instanceId: ProviderInstanceId,
  model?: string,
): Effect.fn.Return<ProviderInstance["textGeneration"], TextGenerationError> {
  const instance = yield* registry.getInstance(instanceId);
  if (!instance) {
    return yield* new TextGenerationError({
      operation,
      detail: `No provider instance registered for id '${instanceId}'.`,
    });
  }
  if (!instance.textGeneration.supportedOperations.includes(operation)) {
    return yield* new TextGenerationError({
      operation,
      detail: `Provider '${instanceId}' does not support this text generation operation. Choose a model from a provider that supports it.`,
    });
  }
  if (operation === "generateKnowledgeCandidates") {
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (exhaustedUsageWindow(snapshot, DateTime.toEpochMillis(yield* DateTime.now), model)) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Automatic memory skipped because the selected provider's usage allowance is exhausted.",
      });
    }
  }
  if (operation === "generateModelEvaluation") {
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (
      !instance.enabled ||
      !snapshot.enabled ||
      !snapshot.installed ||
      snapshot.auth.status === "unauthenticated" ||
      !isProviderAvailable(snapshot) ||
      !isProviderTextGenerationCapable(snapshot, operation)
    ) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "The selected evaluator is unavailable. Choose an enabled, installed, authenticated provider that supports blind evaluation.",
      });
    }
  }
  return instance.textGeneration;
});

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOperation,
    selection: ModelSelection,
    projectId: ProjectId | null | undefined,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const textGenerator = yield* textGenerators.runner(selection.instanceId);
    // A review guide reaches a text generator only through a fallback; it needs an agent instead.
    const textGeneratorId = selection.instanceId;
    const textGeneratorCannotRun =
      textGenerator !== undefined && operation === "generateReviewGuide";
    if (textGenerator !== undefined && !textGeneratorCannotRun) {
      return yield* invoke(
        TextGenerationOperations.fromRunner("TextGenerator", textGenerator),
        selection,
      );
    }
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      textGeneratorCannotRun ||
      (selected?.enabled === true &&
        selected.status === "error" &&
        (!selected.installed || selected.auth.status === "unauthenticated"));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      selection =
        fallbackTextGenerationModelSelection(settings.providerInstances, (instanceId, driver) => {
          const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
          return (
            instanceId !== selection.instanceId &&
            provider?.enabled === true &&
            resolveProjectProviderInstanceEnabled(settings, projectId ?? null, instanceId) &&
            provider.installed &&
            provider.auth.status !== "unauthenticated" &&
            provider.status !== "error" &&
            isProviderAvailable(provider) &&
            isProviderTextGenerationCapable(provider) &&
            (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
            !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
          );
        }) ?? selection;
    }
    if (textGeneratorCannotRun && selection.instanceId === textGeneratorId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control.",
      });
    }
    return yield* installationGate.execute(
      selection.instanceId,
      resolveInstance(registry, operation, selection.instanceId).pipe(
        Effect.flatMap((service) => invoke(service, selection)),
      ),
    );
  });
  return TextGeneration.of({
    generateModelEvaluation: Effect.fn("TextGeneration.generateModelEvaluation")(function* (input) {
      const textGenerator = yield* textGenerators.runner(input.modelSelection.instanceId);
      const judge =
        textGenerator === undefined
          ? yield* resolveInstance(
              registry,
              "generateModelEvaluation",
              input.modelSelection.instanceId,
            )
          : TextGenerationOperations.fromRunner("TextGenerator", textGenerator, {
              supportsInvestigation: false,
              supportsBlindEvaluation: true,
            });
      return yield* judge.generateModelEvaluation(input);
    }),
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateKnowledgeCandidates: Effect.fn("TextGeneration.generateKnowledgeCandidates")(
      function (input) {
        return resolveInstance(
          registry,
          "generateKnowledgeCandidates",
          input.modelSelection.instanceId,
          input.modelSelection.model,
        ).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateKnowledgeCandidates(input)),
        );
      },
    ),
    generateConversationSummary: Effect.fn("TextGeneration.generateConversationSummary")(
      function (input) {
        return resolveInstance(
          registry,
          "generateConversationSummary",
          input.modelSelection.instanceId,
        ).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateConversationSummary(input)),
        );
      },
    ),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        null,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(
  Layer.provideMerge(TextGenerators.layer),
);
