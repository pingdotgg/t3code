import type {
  BranchNamingOptions,
  BlindModelEvaluationPacket,
  ChatAttachment,
  ModelSelection,
  ModelEvaluationVerdict,
  PullRequestReviewGuide,
  TextGenerationError,
  TextGenerationOperation,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
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
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface KnowledgeCandidatesGenerationInput {
  cwd: string;
  runOutcome: "completed" | "failed" | "interrupted";
  /** Finalized messages of one run, oldest first; `ref` is what citations name. */
  messages: ReadonlyArray<{
    readonly ref: string;
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  modelSelection: ModelSelection;
}

export interface KnowledgeCandidatesGenerationResult {
  candidates: ReadonlyArray<{
    readonly kind: "decision" | "constraint" | "convention";
    readonly content: string;
    readonly entities: ReadonlyArray<string>;
    readonly citations: ReadonlyArray<string>;
  }>;
}

export interface ConversationSummaryGenerationInput {
  cwd: string;
  /** Consecutive finalized source ranges, oldest first; `ref` is what citations name. */
  messages: ReadonlyArray<{
    readonly ref: string;
    readonly role: "user" | "assistant" | "tool";
    readonly text: string;
    readonly range?: { readonly start: number; readonly end: number; readonly total: number };
  }>;
  modelSelection: ModelSelection;
}

export interface ConversationSummaryGenerationResult {
  statements: ReadonlyArray<{
    readonly text: string;
    readonly citations: ReadonlyArray<string>;
  }>;
}

export interface TranscriptionPostProcessingInput {
  cwd: string;
  prompt: string;
  modelSelection: ModelSelection;
}

export interface TranscriptionPostProcessingResult {
  transcription: string;
}

export interface ProviderTextGeneration {
  readonly generateModelEvaluation: (input: {
    readonly cwd: string;
    readonly modelSelection: ModelSelection;
    readonly packet: BlindModelEvaluationPacket;
  }) => Effect.Effect<ModelEvaluationVerdict, TextGenerationError>;

  readonly generateTranscriptionPostProcessing: (
    input: TranscriptionPostProcessingInput,
  ) => Effect.Effect<TranscriptionPostProcessingResult, TextGenerationError>;

  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;

  readonly generateKnowledgeCandidates: (
    input: KnowledgeCandidatesGenerationInput,
  ) => Effect.Effect<KnowledgeCandidatesGenerationResult, TextGenerationError>;

  readonly generateConversationSummary: (
    input: ConversationSummaryGenerationInput,
  ) => Effect.Effect<ConversationSummaryGenerationResult, TextGenerationError>;
}

/** A provider declares the operations it implements; the application facade validates each call. */
export interface ProviderTextGenerationRuntime extends ProviderTextGeneration {
  readonly supportedOperations: ReadonlyArray<TextGenerationOperation>;
}
