export const UNIFIED_PUSH_USER_ID = "unifiedpush";

export interface UnifiedPushState {
  readonly available: boolean;
  readonly distributor: string | null;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly keys: { readonly p256dh: string; readonly auth: string } | null;
  readonly failure: string | null;
  readonly lastMessageAt: number | null;
}

export type UnifiedPushStatus = "off" | "no-distributor" | "failed" | "waiting" | "ready";

export function unifiedPushStatus(state: UnifiedPushState | null): UnifiedPushStatus {
  if (!state?.enabled) return state?.available === false ? "no-distributor" : "off";
  if (state.failure) return "failed";
  return state.endpoint ? "ready" : "waiting";
}

/** The watcher reads these fields from its config file next to its server list; keys make it encrypt for the distributor. */
export function unifiedPushWatcherConfig(input: {
  readonly endpoint: string;
  readonly deviceId: string;
  readonly keys: UnifiedPushState["keys"];
}): string {
  return JSON.stringify(
    {
      endpoint: input.endpoint,
      deviceId: input.deviceId,
      userId: UNIFIED_PUSH_USER_ID,
      ...(input.keys ? { keys: input.keys } : {}),
    },
    null,
    2,
  );
}
