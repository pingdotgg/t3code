import type {
  ChatGptHandoffState,
  ProviderAuthState,
  ProviderInstallState,
} from "@t3tools/contracts";

export function readCodexSetupMode(config: unknown): "managed" | "existing" {
  return config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "managed"
    ? "managed"
    : "existing";
}

const RUNNING_INSTALL_PHASES = new Set(["downloading", "extracting", "verifying"]);

/**
 * Whether the `started` install left a usable runtime; `undefined` until settled.
 * The subscription can still carry the previous operation's state when start
 * returns, so only a state with the same operation id settles a running install.
 */
export function settleProviderInstall(
  started: ProviderInstallState,
  current: ProviderInstallState | null,
): boolean | undefined {
  const state = RUNNING_INSTALL_PHASES.has(started.phase)
    ? current?.operationId === started.operationId
      ? current
      : null
    : started;
  if (state === null || RUNNING_INSTALL_PHASES.has(state.phase)) return undefined;
  return state.phase !== "failed" && state.phase !== "cancelled" && state.installedVersion !== null;
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
