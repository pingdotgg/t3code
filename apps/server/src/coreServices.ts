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
  generatePrContent(
    input: PrContentGenerationInput,
  ): Promise<PrContentGenerationResult>;
}

