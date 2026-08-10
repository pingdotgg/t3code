/**
 * Builds the opening turn for a PR review thread.
 *
 * The diff is fetched by the agent rather than by the server: every provider
 * already needs its CLI installed and authenticated for the PR list to render
 * at all, so telling the agent which command to run costs one line here
 * instead of a `getChangeRequestDiff` method on all four providers.
 *
 * The review runs on the current checkout, not a per-PR worktree. The agent
 * therefore sees the diff plus whatever it reads at HEAD — enough for context,
 * without the cost of materializing a branch per review.
 */
import type { ChangeRequest, SourceControlProviderKind } from "@t3tools/contracts";

export interface CodeReviewPromptInput {
  readonly changeRequest: ChangeRequest;
  readonly instructions: string;
}

/**
 * How each provider's CLI prints a change request diff. `unknown` has no CLI
 * we can name, so the agent is told to work it out from the URL.
 */
export function diffCommandFor(
  provider: SourceControlProviderKind,
  changeRequest: ChangeRequest,
): string | null {
  switch (provider) {
    case "github":
      return `gh pr diff ${changeRequest.number}`;
    case "gitlab":
      return `glab mr diff ${changeRequest.number}`;
    case "azure-devops":
      return `az repos pr show --id ${changeRequest.number} --output json`;
    case "bitbucket":
      return `git fetch origin ${changeRequest.headRefName} && git diff origin/${changeRequest.baseRefName}...origin/${changeRequest.headRefName}`;
    case "unknown":
      return null;
  }
}

export function buildCodeReviewPrompt({
  changeRequest,
  instructions,
}: CodeReviewPromptInput): string {
  const diffCommand = diffCommandFor(changeRequest.provider, changeRequest);
  const fetchStep =
    diffCommand === null
      ? `Fetch the diff for ${changeRequest.url} using whichever source control tool this repository uses.`
      : `Fetch the diff by running \`${diffCommand}\`.`;

  const metadata = [
    `- Number: #${changeRequest.number}`,
    `- Title: ${changeRequest.title}`,
    `- Branches: ${changeRequest.headRefName} -> ${changeRequest.baseRefName}`,
    ...(changeRequest.author ? [`- Author: ${changeRequest.author}`] : []),
    `- URL: ${changeRequest.url}`,
  ].join("\n");

  const trimmedInstructions = instructions.trim();

  return [
    `Review pull request #${changeRequest.number}: ${changeRequest.title}`,
    "",
    metadata,
    "",
    fetchStep,
    "You are on the repository's current checkout, not the pull request's branch, so read files for context but review the diff you fetched rather than the working tree.",
    ...(trimmedInstructions.length > 0 ? ["", trimmedInstructions] : []),
  ].join("\n");
}

export function buildCodeReviewThreadTitle(changeRequest: ChangeRequest): string {
  return `Review #${changeRequest.number} · ${changeRequest.title}`;
}
