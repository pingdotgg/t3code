import type {
  BranchNamingOptions,
  BlindModelEvaluationPacket,
  ChatAttachment,
  ModelSelection,
  ModelEvaluationVerdict,
  ProjectFactVerdict,
  ProjectId,
  PullRequestReviewGuide,
  TextGenerationError,
  TextGenerationOperation,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type {
  ProjectMemoryCurationDecision,
  ProjectMemoryCurationFact,
} from "./textGenerationCuration.ts";
export type {
  ProjectMemoryCurationDecision,
  ProjectMemoryCurationFact,
} from "./textGenerationCuration.ts";
export { validateProjectMemoryCuration } from "./textGenerationCuration.ts";
import type {
  ConversationSummaryPromptMessage,
  FactStandingCheckStatement,
  KnowledgeCandidatesPromptMessage,
  ChangeProducer,
  ThreadTitleForkSource,
} from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
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
  producedBy?: ReadonlyArray<ChangeProducer> | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
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
  projectId?: ProjectId | null | undefined;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  projectTitle?: string | undefined;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
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
  /** A scratch checkout of the pull request's head. */
  cwd: string;
  /** The project folder the checkout was made from; the user's own relative paths resolve here. */
  projectCwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface KnowledgeCandidatesGenerationInput {
  cwd: string;
  runOutcome: "completed" | "failed" | "interrupted";
  /** Finalized new evidence from one thread family, oldest first; `ref` is what citations name. */
  messages: ReadonlyArray<KnowledgeCandidatesPromptMessage>;
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

export interface FactStandingCheckInput {
  /** An empty directory: the check must not see the repository or its instructions. */
  cwd: string;
  statements: ReadonlyArray<FactStandingCheckStatement>;
  modelSelection: ModelSelection;
}

export interface FactStandingCheckResult {
  /** One per statement, in order. */
  verdicts: ReadonlyArray<ProjectFactVerdict>;
}

export interface ProjectMemoryCurationInput {
  /** An empty directory keeps project-local configuration out of the curator. */
  cwd: string;
  modelSelection: ModelSelection;
  facts: ReadonlyArray<ProjectMemoryCurationFact>;
}

export interface ProjectMemoryCurationResult {
  decisions: ReadonlyArray<ProjectMemoryCurationDecision>;
}

export interface ConversationSummaryGenerationInput {
  cwd: string;
  /**
   * Consecutive finalized source ranges, or consecutive summaries for a roll-up, oldest first;
   * `ref` is what citations name.
   */
  messages: ReadonlyArray<ConversationSummaryPromptMessage>;
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

  readonly checkFactStanding: (
    input: FactStandingCheckInput,
  ) => Effect.Effect<FactStandingCheckResult, TextGenerationError>;

  readonly curateProjectMemory: (
    input: ProjectMemoryCurationInput,
  ) => Effect.Effect<ProjectMemoryCurationResult, TextGenerationError>;
}

/** A provider declares the operations it implements; the application facade validates each call. */
export interface ProviderTextGenerationRuntime extends ProviderTextGeneration {
  readonly supportedOperations: ReadonlyArray<TextGenerationOperation>;
}
