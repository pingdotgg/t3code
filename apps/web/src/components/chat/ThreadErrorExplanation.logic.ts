import type {
  EnvironmentId,
  OrchestrationV2ExplainProviderFailureResult,
  OrchestrationV2ProviderFailureClass,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

/** Usage limits have a known cause and a dedicated recovery path, so nothing is spent explaining them. */
export function canExplainThreadError(input: {
  readonly errorClass: OrchestrationV2ProviderFailureClass | null | undefined;
  readonly hasTarget: boolean;
}): boolean {
  return input.hasTarget && input.errorClass !== "usage_limit";
}

/**
 * Identifies one explanation request. The banner keys its explanation on this,
 * so moving to another thread, environment or run with the same error text
 * starts fresh instead of showing, or later receiving, the old answer.
 */
export function threadErrorExplanationKey(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
  },
  error: string,
): string {
  return [target.environmentId, target.threadId, target.runId ?? "", error].join("\u0000");
}

/** The one link under an explanation: the issue it matches, else a pre-filled report. */
export type ThreadErrorExplanationLink =
  | { readonly kind: "known-issue"; readonly label: string; readonly url: string }
  | { readonly kind: "report"; readonly label: string; readonly url: string };

/** The server builds these links, but only a GitHub address is ever opened from the banner. */
const GITHUB_URL_PREFIX = "https://github.com/";

export function explanationLink(
  result: Pick<OrchestrationV2ExplainProviderFailureResult, "knownIssue" | "reportUrl">,
): ThreadErrorExplanationLink | null {
  const { knownIssue, reportUrl } = result;
  if (knownIssue !== null && knownIssue.url.startsWith(GITHUB_URL_PREFIX)) {
    return {
      kind: "known-issue",
      label: `Known issue: #${knownIssue.number} ${knownIssue.title}`,
      url: knownIssue.url,
    };
  }
  return reportUrl !== null && reportUrl.startsWith(GITHUB_URL_PREFIX)
    ? { kind: "report", label: "Report this issue", url: reportUrl }
    : null;
}

export type ThreadErrorExplanationState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly summary: string;
      readonly likelyFix: string;
      readonly link: ThreadErrorExplanationLink | null;
    };

export const THREAD_ERROR_CHANGED_MESSAGE = "The error changed before it could be explained.";

/**
 * An answer is only shown under the error it was asked about. The server
 * explains the error its thread reports, which can move on while the request
 * is in flight.
 */
export function explanationStateFromResult(
  displayedError: string,
  result: OrchestrationV2ExplainProviderFailureResult,
): ThreadErrorExplanationState {
  return result.failureMessage === displayedError
    ? {
        kind: "ready",
        summary: result.summary,
        likelyFix: result.likelyFix,
        link: explanationLink(result),
      }
    : { kind: "failed", message: THREAD_ERROR_CHANGED_MESSAGE };
}

/** The message of a failed request, which for server refusals is T3-authored. */
export function explanationStateFromFailure(failure: unknown): ThreadErrorExplanationState {
  const message =
    failure instanceof Error && failure.message.trim().length > 0
      ? failure.message
      : "The environment request failed.";
  return { kind: "failed", message };
}
