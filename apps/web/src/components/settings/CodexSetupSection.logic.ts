import type { ChatGptHandoffState, ProviderAuthState } from "@t3tools/contracts";

export function readCodexSetupMode(config: unknown): "managed" | "existing" {
  return config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "managed"
    ? "managed"
    : "existing";
}

/**
 * The authorization page for a sign-in flow: a URL once the flow waits on the
 * browser, `null` once it ends without one, `undefined` while it is still
 * starting. A `flowId` limits this to one flow, because auth state is shared
 * per instance and another client can start a flow of its own.
 */
export function settleAuthorizationPage(
  state: ProviderAuthState | null,
  flowId: string | null,
): string | null | undefined {
  if (state === null || state.flowId === null) return undefined;
  if (flowId !== null && state.flowId !== flowId) return undefined;
  if (state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled")
    return null;
  if (state.phase !== "waiting") return undefined;
  const url =
    state.interaction?.type === "browser" ? state.interaction.url : state.authorizationUrl;
  return url ?? undefined;
}

export function settleHandoffAuthorizationPage(
  state: ChatGptHandoffState | null,
): string | null | undefined {
  if (state === null) return undefined;
  return state.phase === "finished" ? null : settleAuthorizationPage(state.state, null);
}
