import type { ThreadActivitySnapshot } from "@t3tools/client-runtime/state/thread-activity-announcement";
import type { RunId, OrchestrationV2RunStatus } from "@t3tools/contracts";

export interface ThreadActivityInput {
  readonly approvalRequestId: string | null;
  readonly userInputRequestId: string | null;
  /** The thread shell's pending request, which secret and link cards have only there. */
  readonly shellRequestId: string | null;
  readonly shellPendingUserInput: boolean;
  readonly working: boolean;
  readonly run: { readonly runId: RunId; readonly status: OrchestrationV2RunStatus } | null;
}

export interface ThreadActivityMemory {
  readonly snapshot: ThreadActivitySnapshot;
  /** Requests the thread screen has shown as a card. */
  readonly cardRequestIds: ReadonlySet<string>;
}

/** What the open thread's screen reader status follows, from the same sources the thread screen shows. */
export function nextThreadActivitySnapshot(
  previous: ThreadActivityMemory | null,
  input: ThreadActivityInput,
): ThreadActivityMemory {
  const { approvalRequestId, userInputRequestId, shellRequestId } = input;
  const cardRequestId = approvalRequestId ?? userInputRequestId;
  const seen = previous?.cardRequestIds ?? new Set<string>();
  // A card leaves as soon as it is answered, before the shell; a shell request the card
  // already showed is that answered one, so the request stays the one last announced.
  // Secret and link requests never show as a card and come from the shell alone.
  const requestId =
    cardRequestId ??
    (shellRequestId !== null && seen.has(shellRequestId)
      ? (previous?.snapshot.requestId ?? null)
      : shellRequestId);
  return {
    snapshot: {
      status:
        approvalRequestId !== null
          ? "approval"
          : userInputRequestId !== null || input.shellPendingUserInput
            ? "input"
            : input.working
              ? "working"
              : "idle",
      requestId,
      runId: input.run?.runId ?? null,
      runStatus: input.run?.status ?? null,
    },
    cardRequestIds:
      cardRequestId === null || seen.has(cardRequestId) ? seen : new Set([...seen, cardRequestId]),
  };
}
