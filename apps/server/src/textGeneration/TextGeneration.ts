import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import type {
  AutoReviewFindings,
  ChatAttachment,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  TextGenerationError,
} from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "grok";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
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
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface AutoReviewFindingsGenerationInput {
  cwd: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diffPatch: string;
  truncated: boolean;
  modelSelection: ModelSelection;
}

export type AutoReviewFindingsGenerationResult = AutoReviewFindings;

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateAutoReviewFindings(
    input: AutoReviewFindingsGenerationInput,
  ): Promise<AutoReviewFindingsGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
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
     * Generate pull request title/body from branch and diff context.
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

    /**
     * Generate a concise thread title from a user's first message.
     */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

    /**
     * Produce structured PR review findings for the native auto-reviewer.
     */
    readonly generateAutoReviewFindings: (
      input: AutoReviewFindingsGenerationInput,
    ) => Effect.Effect<AutoReviewFindingsGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateAutoReviewFindings";

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
 * Best-effort default text-generation model for a fallback instance's driver.
 * The requested model is provider-specific (e.g. a codex slug), so retrying
 * another provider with it would fail; each driver gets its own cheap
 * default instead. Drivers with no known default are skipped.
 */
const fallbackModelForDriver = (driverKind: ProviderDriverKind): string | undefined =>
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[driverKind] ??
  DEFAULT_MODEL_BY_PROVIDER[driverKind];

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] => {
  /**
   * Run an op against the selected instance and, when it fails (usage
   * limits, missing CLI, provider outage), retry against every other
   * enabled instance with that driver's default text-generation model.
   * Background renames (thread titles, worktree branches) otherwise die
   * silently and permanently when the configured provider is unavailable.
   * The original error is re-raised when no fallback succeeds.
   */
  const withProviderFallback = <Input extends { readonly modelSelection: ModelSelection }, A>(
    operation: TextGenerationOp,
    input: Input,
    invoke: (
      textGeneration: TextGeneration["Service"],
      input: Input,
    ) => Effect.Effect<A, TextGenerationError>,
  ): Effect.Effect<A, TextGenerationError> =>
    resolveInstance(registry, operation, input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => invoke(textGeneration, input)),
      Effect.catch((primaryError) =>
        Effect.gen(function* () {
          const instances = yield* registry.listInstances;
          const fallbacks = instances.filter(
            (instance) =>
              instance.enabled && instance.instanceId !== input.modelSelection.instanceId,
          );
          for (const instance of fallbacks) {
            const model = fallbackModelForDriver(instance.driverKind);
            if (model === undefined) continue;
            const fallbackInput = {
              ...input,
              modelSelection: {
                instanceId: instance.instanceId,
                model,
              } satisfies ModelSelection,
            };
            const attempted = yield* invoke(instance.textGeneration, fallbackInput).pipe(
              Effect.result,
            );
            if (Result.isSuccess(attempted)) {
              yield* Effect.logWarning("text generation fell back to another provider instance", {
                operation,
                selectedInstanceId: input.modelSelection.instanceId,
                fallbackInstanceId: instance.instanceId,
                fallbackModel: model,
                cause: primaryError.detail,
              });
              return attempted.success;
            }
          }
          return yield* primaryError;
        }),
      ),
    );

  return TextGeneration.of({
    generateCommitMessage: (input) =>
      withProviderFallback("generateCommitMessage", input, (textGeneration, next) =>
        textGeneration.generateCommitMessage(next),
      ),
    generatePrContent: (input) =>
      withProviderFallback("generatePrContent", input, (textGeneration, next) =>
        textGeneration.generatePrContent(next),
      ),
    generateBranchName: (input) =>
      withProviderFallback("generateBranchName", input, (textGeneration, next) =>
        textGeneration.generateBranchName(next),
      ),
    generateThreadTitle: (input) =>
      withProviderFallback("generateThreadTitle", input, (textGeneration, next) =>
        textGeneration.generateThreadTitle(next),
      ),
    generateAutoReviewFindings: (input) =>
      withProviderFallback("generateAutoReviewFindings", input, (textGeneration, next) =>
        textGeneration.generateAutoReviewFindings(next),
      ),
  });
};

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
