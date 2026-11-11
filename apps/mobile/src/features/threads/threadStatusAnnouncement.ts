import type { ThreadActivitySnapshot } from "@t3tools/client-runtime/state/thread-activity-announcement";
import type { RunId, OrchestrationV2RunStatus } from "@t3tools/contracts";

/** What the open thread's screen reader status follows, from the same sources the thread screen shows. */
export function threadActivitySnapshot(input: {
  readonly approvalRequestId: string | null;
  readonly userInputRequestId: string | null;
  readonly shell: {
    readonly hasPendingUserInput: boolean;
    readonly source: { readonly pendingRuntimeRequest: { readonly id: string } | null };
  } | null;
  readonly working: boolean;
  readonly run: { readonly runId: RunId; readonly status: OrchestrationV2RunStatus } | null;
}): ThreadActivitySnapshot {
  const { approvalRequestId, userInputRequestId, shell } = input;
  return {
    status:
      approvalRequestId !== null
        ? "approval"
        : userInputRequestId !== null || shell?.hasPendingUserInput === true
          ? "input"
          : input.working
            ? "working"
            : "idle",
    // An answered question leaves the card before the shell, so the shell's id keeps it the same request.
    requestId:
      approvalRequestId ?? userInputRequestId ?? shell?.source.pendingRuntimeRequest?.id ?? null,
    runId: input.run?.runId ?? null,
    runStatus: input.run?.status ?? null,
  };
}
