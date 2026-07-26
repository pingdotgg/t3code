/**
 * Canned "open a pull request" instruction for the agent, appended to an
 * outgoing composer message when the client's auto-PR toggle is on. It is
 * plain user-message text, so it behaves identically across providers.
 *
 * The macOS app keeps its own copy in
 * `apps/mac/Sources/SergeCodeMac/Model/CreatePRPrompt.swift` (Swift cannot
 * import this package). Keep the wording in sync when either side changes.
 */

const GUIDELINES = `Guidelines:
- Review the full diff of this branch before writing anything.
- Commit any uncommitted changes with clear, conventional commit messages.
- Push the branch and open the PR against the repository's default branch.
- Use a concise, imperative PR title.
- In the PR body, summarize what changed and why, and note how it was verified.
- Follow the repository's PR template and contribution guidelines if present.`;

/** Sent on its own when the user asks for a PR without other work. */
export const CREATE_PULL_REQUEST_PROMPT = `Please create a pull request for the work in this session.

${GUIDELINES}`;

/**
 * Appended to an outgoing message when the auto-PR toggle is on. The leading
 * blank lines separate it from the user's own text.
 */
export const CREATE_PULL_REQUEST_MESSAGE_SUFFIX = `

When you finish the work above, also create a pull request for it.

${GUIDELINES}`;

/**
 * Appends the auto-PR instruction when it applies. Empty drafts are left alone
 * so the suffix can never become the entire message, and the suffix is only
 * added to a thread's first user message — follow-ups in a thread that is
 * already underway should not keep re-sending the guidelines.
 *
 * Idempotent: re-queueing a message that already carries the suffix (editing a
 * pending task rehydrates the stored text into the draft) must not stack a
 * second copy.
 */
export function applyCreatePullRequestSuffix(input: {
  readonly text: string;
  readonly autoCreatePullRequest: boolean;
  readonly threadHasStarted: boolean;
}): string {
  if (
    !input.autoCreatePullRequest ||
    input.threadHasStarted ||
    input.text.trim().length === 0 ||
    input.text.endsWith(CREATE_PULL_REQUEST_MESSAGE_SUFFIX)
  ) {
    return input.text;
  }
  return input.text + CREATE_PULL_REQUEST_MESSAGE_SUFFIX;
}
