import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

/**
 * Whether a thread can hold a voice conversation. `unsupported` hides every
 * voice entry point; `unavailable` shows them disabled with `reason`.
 */
export type VoiceAvailability =
  | { readonly kind: "unsupported" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "ready" };

const VOICE_UNSUPPORTED: VoiceAvailability = { kind: "unsupported" };

export function resolveVoiceAvailability(input: {
  /** The provider instance that runs (or will run) the thread's turns. */
  readonly provider: Pick<ServerProvider, "supportsVoice"> | null | undefined;
  readonly hasMessages: boolean;
  readonly hasSession: boolean;
}): VoiceAvailability {
  if (input.provider?.supportsVoice !== true) return VOICE_UNSUPPORTED;
  // The server hands voice requests to the thread's bound provider session,
  // which only exists once a turn has been sent.
  if (!input.hasMessages || !input.hasSession) {
    return { kind: "unavailable", reason: "Send a message before starting voice" };
  }
  return { kind: "ready" };
}

/** The thread fields voice availability reads (orchestrator V2 thread shells). */
export interface VoiceThread {
  readonly providerInstanceId: ProviderInstanceId;
  readonly latestUserMessageAt: string | null;
  readonly activeProviderThreadId: string | null;
}

/** Voice follows the provider instance that owns the thread. */
export function resolveThreadVoiceAvailability(
  thread: VoiceThread,
  providers: ReadonlyArray<ServerProvider>,
): VoiceAvailability {
  return resolveVoiceAvailability({
    provider: providers.find((provider) => provider.instanceId === thread.providerInstanceId),
    hasMessages: thread.latestUserMessageAt !== null,
    hasSession: thread.activeProviderThreadId !== null,
  });
}
