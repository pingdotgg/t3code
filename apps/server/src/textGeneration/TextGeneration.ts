import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProviderDriverKind,
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

/** Any registered provider driver can supply the required text-generation shape. */
export type TextGenerationProvider = ProviderDriverKind;

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance, TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/**
 * OMP's available selectors depend on the credentials and provider
 * configuration of each instance, so no static fallback can be valid for
 * every installation. Resolve provisional or stale OMP selections at the
 * dispatch boundary, where both the live model snapshot and text-generation
 * closure are available without introducing a settings/registry cycle.
 */
const resolveOmpModelSelection = (
  instance: ProviderInstance,
  operation: TextGenerationOp,
  selection: ModelSelection,
): Effect.Effect<ModelSelection, TextGenerationError> => {
  if (instance.driverKind !== OMP_DRIVER_KIND) {
    return Effect.succeed(selection);
  }

  return Effect.gen(function* () {
    const current = yield* instance.snapshot.getSnapshot;
    if (current.models.some((model) => model.slug === selection.model)) {
      return selection;
    }

    // Refresh whenever the requested selector is absent. A non-empty cache can
    // still be stale after switching to a newly discovered OMP model.
    const resolvedSnapshot = yield* instance.snapshot.refresh;
    if (resolvedSnapshot.models.some((model) => model.slug === selection.model)) {
      return selection;
    }

    const fallback =
      resolvedSnapshot.models.find((model) => !model.isCustom) ?? resolvedSnapshot.models[0];
    if (!fallback) {
      return yield* new TextGenerationError({
        operation,
        detail: `OMP provider instance '${instance.instanceId}' has no available models for text generation. Configure OMP credentials or add a custom model, then refresh providers.`,
      });
    }

    // Provider options belong to the stale model and may not exist on the
    // discovered fallback. Do not send them through OMP's strict ACP option
    // validation.
    return {
      instanceId: instance.instanceId,
      model: fallback.slug,
    } satisfies ModelSelection;
  });
};

const resolveTextGenerationTarget = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  selection: ModelSelection,
): Effect.Effect<
  {
    readonly textGeneration: ProviderInstance["textGeneration"];
    readonly modelSelection: ModelSelection;
  },
  TextGenerationError
> =>
  resolveInstance(registry, operation, selection.instanceId).pipe(
    Effect.flatMap((instance) =>
      resolveOmpModelSelection(instance, operation, selection).pipe(
        Effect.map((modelSelection) => ({
          textGeneration: instance.textGeneration,
          modelSelection,
        })),
      ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveTextGenerationTarget(registry, "generateCommitMessage", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
        ),
      ),
    generatePrContent: (input) =>
      resolveTextGenerationTarget(registry, "generatePrContent", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generatePrContent({ ...input, modelSelection }),
        ),
      ),
    generateBranchName: (input) =>
      resolveTextGenerationTarget(registry, "generateBranchName", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
        ),
      ),
    generateThreadTitle: (input) =>
      resolveTextGenerationTarget(registry, "generateThreadTitle", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateThreadTitle({ ...input, modelSelection }),
        ),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
