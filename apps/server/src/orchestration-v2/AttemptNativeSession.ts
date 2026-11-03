import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

// Historical attempts can belong to a session from before Claude's /clear.
export function withAttemptNativeSession(
  providerThread: OrchestrationV2ProviderThread,
  nativeThreadId: string | undefined,
): OrchestrationV2ProviderThread {
  if (
    providerThread.nativeThreadRef === null ||
    nativeThreadId === undefined ||
    providerThread.nativeThreadRef.nativeId === nativeThreadId
  )
    return providerThread;
  return {
    ...providerThread,
    nativeThreadRef: { ...providerThread.nativeThreadRef, nativeId: nativeThreadId },
    nativeConversationHeadRef: null,
  };
}
