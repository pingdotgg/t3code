export type T3ConnectSidebarStatusTone = "error" | "muted" | "pending" | "success";

/**
 * Clerk availability as seen by the Connect surfaces. Clerk is an enhancement
 * on top of the LOCAL environment link state: "unavailable" means clerk-js
 * never finished loading on this origin (e.g. a domain-locked production key
 * on localhost), so sign-in is disabled but local state still renders.
 */
export type T3ConnectClerkAvailability = "loading" | "signed-in" | "signed-out" | "unavailable";

export const CLERK_UNAVAILABLE_HINT = "Clerk unavailable on this origin (sign-in disabled)";
export const SIGN_IN_FOR_RELAY_MANAGEMENT_LABEL = "Sign in for relay management";

export function resolveT3ConnectClerkAvailability({
  isLoaded,
  isSignedIn,
  loadTimedOut,
}: {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | null | undefined;
  readonly loadTimedOut: boolean;
}): T3ConnectClerkAvailability {
  if (isLoaded) {
    return isSignedIn ? "signed-in" : "signed-out";
  }
  return loadTimedOut ? "unavailable" : "loading";
}

export interface T3ConnectSidebarPresentation {
  readonly label: "Activity only" | "Connected" | "Connecting…" | "Connection error" | "Not linked";
  readonly tone: T3ConnectSidebarStatusTone;
}

export function resolveT3ConnectSidebarPresentation({
  error,
  isPending,
  managedTunnelActive,
  publishAgentActivity,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly managedTunnelActive: boolean;
  readonly publishAgentActivity: boolean;
}): T3ConnectSidebarPresentation {
  if (error) {
    return { label: "Connection error", tone: "error" };
  }
  if (isPending) {
    return { label: "Connecting…", tone: "pending" };
  }
  if (managedTunnelActive) {
    return { label: "Connected", tone: "success" };
  }
  if (publishAgentActivity) {
    return { label: "Activity only", tone: "success" };
  }
  return { label: "Not linked", tone: "muted" };
}

export interface T3ConnectSidebarView {
  /**
   * "sign-in" renders the classic full-width sign-in row; "status" renders the
   * local link state row (optionally with a compact sign-in action beside it).
   */
  readonly kind: "sign-in" | "status";
  readonly presentation: T3ConnectSidebarPresentation;
  /** Render a compact "Sign in for relay management" action beside the row. */
  readonly showSignInAction: boolean;
  /** Extra tooltip/title context (e.g. Clerk unavailable on this origin). */
  readonly hint: string | null;
}

/**
 * Local-first decision tree for the sidebar Connect control. The LOCAL
 * environment link state (read over the environment session, independent of
 * Clerk) is the primary signal; the Clerk web session only decides whether the
 * sign-in affordance is offered, and never blocks status display. Clerk that
 * never loads ("unavailable") degrades to local state with a hint instead of
 * an indefinite "Connecting…".
 */
export function resolveT3ConnectSidebarView({
  clerk,
  error,
  hasLinkState,
  isPending,
  managedTunnelActive,
  publishAgentActivity,
}: {
  readonly clerk: T3ConnectClerkAvailability;
  readonly error: string | null;
  readonly hasLinkState: boolean;
  readonly isPending: boolean;
  readonly managedTunnelActive: boolean;
  readonly publishAgentActivity: boolean;
}): T3ConnectSidebarView {
  const presentation = resolveT3ConnectSidebarPresentation({
    error,
    isPending,
    managedTunnelActive,
    publishAgentActivity,
  });

  if (clerk === "signed-in") {
    return { hint: null, kind: "status", presentation, showSignInAction: false };
  }

  if (clerk === "signed-out") {
    // A CLI-linked machine is Connected/Activity only regardless of the web
    // session; sign-in becomes the secondary action instead of replacing
    // status. Only a settled, fully unlinked machine keeps the classic
    // sign-in row.
    const localShowsActivity =
      error !== null || isPending || managedTunnelActive || publishAgentActivity;
    if (localShowsActivity) {
      return { hint: null, kind: "status", presentation, showSignInAction: true };
    }
    return { hint: null, kind: "sign-in", presentation, showSignInAction: false };
  }

  if (clerk === "unavailable") {
    return { hint: CLERK_UNAVAILABLE_HINT, kind: "status", presentation, showSignInAction: false };
  }

  // Clerk still loading: show local state as soon as it resolves; only fall
  // back to "Connecting…" while the local read itself has produced nothing.
  if (hasLinkState || error !== null) {
    return { hint: null, kind: "status", presentation, showSignInAction: false };
  }
  return {
    hint: null,
    kind: "status",
    presentation: { label: "Connecting…", tone: "pending" },
    showSignInAction: false,
  };
}
