import type { UnifiedPushRegistration } from "@t3tools/contracts";

export const UNIFIED_PUSH_USER_ID = "unifiedpush";

export interface UnifiedPushState {
  readonly available: boolean;
  readonly distributor: string | null;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly keys: { readonly p256dh: string; readonly auth: string } | null;
  readonly failure: string | null;
  readonly lastMessageAt: number | null;
  readonly deviceId: string | null;
}

export type UnifiedPushStatus = "off" | "no-distributor" | "failed" | "waiting" | "ready";

export function unifiedPushStatus(state: UnifiedPushState | null): UnifiedPushStatus {
  if (!state?.enabled) return state?.available === false ? "no-distributor" : "off";
  if (state.failure) return "failed";
  return state.endpoint ? "ready" : "waiting";
}

/** What each paired server needs to push here, once the distributor has issued an endpoint. */
export function unifiedPushRegistration(
  state: UnifiedPushState | null,
): UnifiedPushRegistration | null {
  if (!state?.enabled || !state.endpoint || !state.deviceId) return null;
  return {
    deviceId: state.deviceId,
    endpoint: state.endpoint,
    ...(state.keys ? { keys: state.keys } : {}),
  };
}
