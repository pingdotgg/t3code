import type {
  OrchestrationEvent,
  ProviderStartOptions,
  ProviderStartOptionsRedacted,
} from "@t3tools/contracts";

/** Strip sensitive fields (username, password) from provider start options. */
export function redactProviderStartOptions(
  opts: ProviderStartOptions,
): ProviderStartOptionsRedacted {
  const redacted = { ...opts } as Record<string, unknown>;
  if (opts.opencode) {
    const { username: _u, password: _p, ...rest } = opts.opencode;
    redacted.opencode = rest;
  }
  if (opts.kilo) {
    const { username: _u, password: _p, ...rest } = opts.kilo;
    redacted.kilo = rest;
  }
  return redacted as ProviderStartOptionsRedacted;
}

/**
 * Redact sensitive fields from an orchestration event payload.
 *
 * Currently strips `username`/`password` from opencode and kilo provider
 * options on `thread.turn-start-requested` events. Use this at persistence
 * and client-broadcast boundaries so credentials never leave the server
 * runtime.
 */
export function redactEventForBoundary<T extends Omit<OrchestrationEvent, "sequence">>(
  event: T,
): T {
  if (event.type !== "thread.turn-start-requested") {
    return event;
  }
  const payload = event.payload as Record<string, unknown>;
  if (!payload.providerOptions) {
    return event;
  }
  return {
    ...event,
    payload: {
      ...payload,
      providerOptions: redactProviderStartOptions(
        payload.providerOptions as ProviderStartOptions,
      ),
    },
  } as T;
}
