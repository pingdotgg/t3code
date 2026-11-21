/**
 * Why an OpenCode prompt was refused as oversized.
 *
 * OpenCode reports a session that outgrew the model's context window as a
 * bare InvalidRequest ("The request contains invalid parameters"), which
 * reads as a bug in the request. Retrying the same run then fails
 * identically, because the history that broke the request is still there.
 * This maps that case to an actionable message: fork from an earlier
 * completed run or start a fresh thread.
 *
 * Only fires with per-request size evidence: the last completed step's
 * input is the live context size, and it must already meet the known
 * window. Cumulative turn totals are deliberately not used — several steps
 * that each fit the window can sum past it, and a later unrelated
 * rejection must keep its original error. Unknown windows and prompt-less
 * failures are left alone for the same reason.
 */
export const oversizedSessionMessage = (input: {
  readonly causeTag: string | undefined;
  readonly lastStepInputTokens: number | undefined;
  readonly windowTokens: number | undefined;
}): string | null => {
  if (input.causeTag !== "InvalidRequestError") return null;
  if (input.windowTokens === undefined || input.lastStepInputTokens === undefined) return null;
  if (input.lastStepInputTokens < input.windowTokens) return null;
  const used = input.lastStepInputTokens.toLocaleString("en-US");
  const window = input.windowTokens.toLocaleString("en-US");
  return (
    `This session has grown past the model's context window ` +
    `(${used} tokens used of ${window}). ` +
    `Fork from an earlier completed run or start a fresh thread; ` +
    `retrying this run will fail the same way.`
  );
};
