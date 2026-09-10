import type { ReviewCommentContext } from "~/reviewCommentContext";

/**
 * Every chip a hand-off leaves in the composer is named after the pull request it came from —
 * `pull-request-context:`, `pull-request-finding:`, `pull-request-selection:` — which is what
 * tells them apart from the ones a reader marked up in the thread's own diff.
 */
const HANDOFF_COMMENT_ID_PREFIX = "pull-request-";

/**
 * The prompt the composer should hold once a hand-off lands there.
 *
 * A hand-off owns what an earlier hand-off wrote and nothing else: pressing Ask and then Explain
 * used to stack both in the composer, and the reader sent a question nobody wrote. What says an
 * earlier one wrote it is the text itself — the caller remembers what it last put in this draft,
 * and only that exact sentence is replaced. A reader who typed their own question, or edited the
 * one they were given, has written something no hand-off may take away: an empty ask leaves it
 * alone, and one carrying a prompt goes underneath it.
 */
export function handoffPrompt(
  existing: {
    readonly prompt: string;
    /**
     * What the last hand-off into this draft wrote — its own contribution alone, never the
     * merged prompt it landed in, or a draft that held the reader's text before the first
     * hand-off would read as all hand-off and be replaced wholesale by the second.
     */
    readonly lastHandoffPrompt: string | undefined;
  },
  incoming: string,
): string {
  if (existing.prompt.trim().length === 0) return incoming;
  const last = existing.lastHandoffPrompt ?? "";
  // Only the sentence the last hand-off wrote is taken back: alone, or off the end of the
  // reader's own text it was appended under.
  const kept =
    last.length === 0
      ? existing.prompt
      : existing.prompt === last
        ? ""
        : existing.prompt.endsWith(`\n\n${last}`)
          ? existing.prompt.slice(0, -(last.length + 2))
          : existing.prompt;
  if (kept.trim().length === 0) return incoming;
  return incoming.length === 0 ? kept : `${kept}\n\n${incoming}`;
}

/**
 * The chips the composer should hold once a hand-off lands there: this one's, plus whatever the
 * reader attached themselves. What an earlier hand-off left goes, because a question about one
 * pull request carrying another one's context is not a question anybody meant to ask.
 */
export function handoffReviewComments(
  existing: ReadonlyArray<ReviewCommentContext>,
  incoming: ReadonlyArray<ReviewCommentContext>,
): ReviewCommentContext[] {
  return [
    ...existing.filter((comment) => !comment.id.startsWith(HANDOFF_COMMENT_ID_PREFIX)),
    ...incoming,
  ];
}

/**
 * The internal wrapper every failed operation arrives in: which operation ran, and which tool
 * said no. A reader has no use for either. Both a pull request's and an issue's operations wrap
 * their failures this way, so this strips either surface's wrapper.
 */
const OPERATION_PREFIX = /^(?:Pull request|Issue) operation \w+ failed:\s*/iu;

/**
 * Sentences that report only that a tool exited: true, and no help at all. Anything else the
 * host says is worth more than what this page could invent, so only these are replaced.
 */
const TOOL_NOISE = [
  /^(github|gitlab|bitbucket|azure devops)?\s*(cli|api)?\s*(command\s*)?failed\.?$/iu,
  /^exited? with (code|status) \d+\.?$/iu,
  /^unknown error\.?$/iu,
];

/** How much of a host's own message a toast can carry before it stops being read. */
const FAILURE_DETAIL_MAX_LENGTH = 320;

/**
 * What to put under a failed action. The host's own sentence when it said something — it knows
 * why, and this page does not — and otherwise what to go and check, because "the command failed"
 * leaves the reader pressing the same button again.
 */
export function readableFailure(failure: unknown, hint: string): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.replace(OPERATION_PREFIX, "").trim();
  if (detail.length === 0 || TOOL_NOISE.some((pattern) => pattern.test(detail))) return hint;
  const bounded =
    detail.length <= FAILURE_DETAIL_MAX_LENGTH
      ? detail
      : `${detail.slice(0, FAILURE_DETAIL_MAX_LENGTH - 1)}…`;
  // The host's words alone: the hint is a guess about why, and a guess printed under a reason
  // that contradicts it is worse than no guess at all.
  return bounded;
}
