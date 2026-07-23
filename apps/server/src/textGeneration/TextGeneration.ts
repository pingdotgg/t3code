import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type {
  AutoReviewFindings,
  ChatAttachment,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

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

export type SceneryTimeOfDay = "dawn" | "day" | "dusk" | "night";
export type ScenerySeason = "spring" | "summer" | "autumn" | "winter";

export interface ScenerySetQueryGeneration {
  text: string;
  timeOfDay?: SceneryTimeOfDay | undefined;
  season?: ScenerySeason | undefined;
}

export interface ScenerySetLocationGeneration {
  /** Authentic place name, e.g. "Kirkjufell". */
  name: string;
  /** Unsplash search that finds photos of that place. */
  query: string;
  timeOfDay?: SceneryTimeOfDay | undefined;
  season?: ScenerySeason | undefined;
}

export interface ScenerySetGenerationInput {
  cwd: string;
  /** User-typed location name, e.g. "Kyoto" or "Norwegian Fjords". */
  location: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ScenerySetGenerationResult {
  /** Authentic place names (derived from `locations` when present). */
  sceneNames: string[];
  /** General Unsplash search queries for variety top-up. */
  queries: ScenerySetQueryGeneration[];
  /** Per-location name + place-specific query (preferred client fetch path). */
  locations?: ScenerySetLocationGeneration[] | undefined;
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
  generateScenerySet(input: ScenerySetGenerationInput): Promise<ScenerySetGenerationResult>;
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
     * Generate curated scene names + Unsplash search queries for a location
     * photo set (mac scenery personalization).
     */
    readonly generateScenerySet: (
      input: ScenerySetGenerationInput,
    ) => Effect.Effect<ScenerySetGenerationResult, TextGenerationError>;

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
  | "generateScenerySet"
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
    generateScenerySet: (input) =>
      resolveInstance(registry, "generateScenerySet", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateScenerySet(input)),
      ),
    generateAutoReviewFindings: (input) =>
      resolveInstance(registry, "generateAutoReviewFindings", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateAutoReviewFindings(input)),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
