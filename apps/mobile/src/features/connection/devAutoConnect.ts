import type { NavigationState, PartialState } from "@react-navigation/native";
import { StackActions } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { findLinkedRoute } from "../../lib/appLinking";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { leaveSettingsPage } from "../settings/settings-navigation";
import { workspaceHasColumns } from "../workspace/workspace-selection-store";
import { pairEnvironment } from "../../state/use-remote-environment-registry";

export type DevAutoConnectAttempt =
  | { readonly pairingUrl: string; readonly status: "connecting" }
  | { readonly pairingUrl: string; readonly status: "failed"; readonly error: string | null };

/** The pairing the dev deep link started, so the form it opens can show its progress. */
export const devAutoConnectAttemptAtom = Atom.make<DevAutoConnectAttempt | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:dev-auto-connect-attempt"),
);

/**
 * What the form opened by `routePairingUrl` shows of the dev auto-connect. Editing or submitting
 * (`dismissed`) hides a failure, but a pairing still running keeps Connect busy, so the user
 * cannot start a second pairing beside it.
 */
export function autoConnectReport(
  attempt: DevAutoConnectAttempt | null,
  routePairingUrl: string,
  dismissed: boolean,
): { readonly connecting: boolean; readonly error: string | null } {
  if (attempt === null || routePairingUrl.length === 0 || attempt.pairingUrl !== routePairingUrl) {
    return { connecting: false, error: null };
  }
  if (attempt.status === "connecting") return { connecting: true, error: null };
  return { connecting: false, error: dismissed ? null : attempt.error };
}

// The pairing form is mounted both as a root sheet and inside the settings sheet.
const PAIRING_FORM_ROUTES = ["ConnectionsNew", "SettingsEnvironmentNew"];

function isAutoConnectFlag(value: unknown): boolean {
  return value === "1" || value === "true";
}

async function connect(pairingUrl: string, expectedEnvironmentId: EnvironmentId | undefined) {
  const attempt: DevAutoConnectAttempt = { pairingUrl, status: "connecting" };
  appAtomRegistry.set(devAutoConnectAttemptAtom, attempt);
  const outcome = await pairEnvironment(pairingUrl, expectedEnvironmentId);
  // A later link replaced or cleared this attempt; its result belongs to no open form.
  if (appAtomRegistry.get(devAutoConnectAttemptAtom) !== attempt) return;
  if (!outcome.ok) {
    appAtomRegistry.set(devAutoConnectAttemptAtom, {
      pairingUrl,
      status: "failed",
      error: outcome.error,
    });
    return;
  }
  whenRootNavigationReady(() => {
    // A newer link (with or without the flag) owns the form now.
    if (appAtomRegistry.get(devAutoConnectAttemptAtom) !== attempt) return;
    appAtomRegistry.set(devAutoConnectAttemptAtom, null);
    const current = rootNavigationRef.getCurrentRoute()?.name;
    if (current === undefined || !PAIRING_FORM_ROUTES.includes(current)) return;
    // Same exit as the form's own Connect: return to the opener, and on columns show the
    // new environment on Environments instead of an empty detail.
    if (!rootNavigationRef.canGoBack()) rootNavigationRef.dispatch(StackActions.replace("Home"));
    else leaveSettingsPage(rootNavigationRef, workspaceHasColumns(), "SettingsEnvironments");
  });
}

/**
 * `connections/new?pairingUrl=…&autoConnect=1` (or `settings/environment-new?…`) pairs from the
 * link itself, so a remount of the form never pairs twice. Production builds ignore the flag so
 * a link can never pair with an attacker-chosen host.
 */
export function startDevAutoConnect(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (!__DEV__) return state;
  const route = findLinkedRoute(state, PAIRING_FORM_ROUTES);
  if (route === undefined) return state;
  const params = (route.params ?? {}) as {
    readonly autoConnect?: unknown;
    readonly pairingUrl?: unknown;
    readonly routeFor?: EnvironmentId;
  };
  const pairingUrl = typeof params.pairingUrl === "string" ? params.pairingUrl.trim() : "";
  if (isAutoConnectFlag(params.autoConnect) && pairingUrl.length > 0) {
    void connect(pairingUrl, params.routeFor);
  } else {
    // Only links put a pairing URL on the form, so a form opened by any other link starts
    // clean instead of showing an earlier auto-connect's failure for the same URL.
    appAtomRegistry.set(devAutoConnectAttemptAtom, null);
  }
  return state;
}
