import { readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";

let pending: ReturnType<typeof readCodexAuthDelivery>;

/** Remove the code before the router, tracing, or welcome screen sees the incoming address. */
export function prepareProviderAuthDelivery() {
  if (!window.location.hash.startsWith("#codex-auth=")) return;
  pending = readCodexAuthDelivery(window.location.href);
  window.history.replaceState(
    window.history.state,
    "",
    pending?.returnUrl ?? `${window.location.pathname}${window.location.search}`,
  );
}

export const pendingProviderAuthDelivery = () => pending;
export const clearProviderAuthDelivery = () => {
  pending = undefined;
};
