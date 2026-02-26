/**
 * TextGeneration - Effect service contract for AI-generated Git content.
 *
 * Generates commit messages and pull request titles/bodies from repository
 * context prepared by Git services.
 *
 * @module TextGeneration
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { TextGenerationError } from "../Errors.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
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
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends ServiceMap.Service<TextGeneration, TextGenerationShape>()(
  "git/TextGeneration",
) {}
