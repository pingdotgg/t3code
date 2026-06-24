import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

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

export interface MergeConflictResolutionInput {
  cwd: string;
  /** Repo-relative path of the conflicted file (used for prompt context only). */
  path: string;
  /** Full file contents including git conflict markers. */
  conflictedContent: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface MergeConflictResolutionResult {
  /** The complete file contents with all conflict markers resolved. */
  resolvedContent: string;
}

export interface MergeResolutionVerificationInput {
  cwd: string;
  /** Repo-relative path of the conflicted file (used for prompt context only). */
  path: string;
  /** The original file contents including git conflict markers. */
  conflictedContent: string;
  /** The proposed resolved file contents to review. */
  resolvedContent: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface MergeResolutionVerificationResult {
  /** True only if the resolution faithfully combines both sides without loss. */
  ok: boolean;
  /** A short explanation, primarily useful when `ok` is false. */
  reason: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  resolveMergeConflict(
    input: MergeConflictResolutionInput,
  ): Promise<MergeConflictResolutionResult>;
  verifyMergeResolution(
    input: MergeResolutionVerificationInput,
  ): Promise<MergeResolutionVerificationResult>;
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
     * Resolve a single file's git merge conflicts, returning the full resolved
     * file contents. Single-shot: the model only produces text; the caller writes
     * it back and creates the commit.
     */
    readonly resolveMergeConflict: (
      input: MergeConflictResolutionInput,
    ) => Effect.Effect<MergeConflictResolutionResult, TextGenerationError>;

    /**
     * Independently review a proposed merge-conflict resolution for correctness
     * (no leftover markers, both sides preserved, nothing dropped). Used as a
     * fail-closed gate before committing an AI-resolved merge.
     */
    readonly verifyMergeResolution: (
      input: MergeResolutionVerificationInput,
    ) => Effect.Effect<MergeResolutionVerificationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "resolveMergeConflict"
  | "verifyMergeResolution";

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

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
    resolveMergeConflict: (input) =>
      resolveInstance(registry, "resolveMergeConflict", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.resolveMergeConflict(input)),
      ),
    verifyMergeResolution: (input) =>
      resolveInstance(registry, "verifyMergeResolution", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.verifyMergeResolution(input)),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
