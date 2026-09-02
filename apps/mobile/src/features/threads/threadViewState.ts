import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { AppStateStatus } from "react-native";

/**
 * Whether the focused thread route should tell the server it viewed the
 * latest completion. Skipped when the app is not in front, the environment
 * is not connected, the server does not track view state, the thread's
 * messages have not loaded yet (the user cannot have read a completion they
 * cannot see), or the server's viewedAt already covers the completion (so
 * refocusing does not resend).
 */
export function shouldAcknowledgeThreadView(input: {
  readonly appState: AppStateStatus;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly supported: boolean;
  readonly detailLoaded: boolean;
  readonly completedAt: string | null | undefined;
  readonly viewedAt: string | undefined;
}): boolean {
  if (input.appState !== "active" || input.connectionState !== "connected" || !input.supported) {
    return false;
  }
  if (!input.detailLoaded || !input.completedAt) return false;
  const completedAtMs = Date.parse(input.completedAt);
  if (!Number.isFinite(completedAtMs)) return false;
  const viewedAtMs = input.viewedAt === undefined ? NaN : Date.parse(input.viewedAt);
  return !Number.isFinite(viewedAtMs) || viewedAtMs < completedAtMs;
}
