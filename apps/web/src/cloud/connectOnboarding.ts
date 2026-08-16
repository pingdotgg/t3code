import * as Schema from "effect/Schema";

/**
 * Accounts that opted out of the post-sign-in T3 Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "t3code:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

export function shouldSyncOnboardingToggleFromLinkState(input: {
  readonly touched: boolean;
  readonly openForAccount: string | null;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
}): boolean {
  return (
    !input.touched &&
    input.openForAccount !== null &&
    input.linked &&
    input.cloudUserId === input.openForAccount
  );
}

// The wizard only ever enables. A stale prefill of expose=false after
// startup reconcile must not submit publish_only and tear the tunnel down.
export function resolveOnboardingReconcileDesired(input: {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly managedTunnelActive: boolean;
}): { readonly managedTunnel: boolean; readonly publish: boolean } | null {
  const managedTunnel = input.exposeEnvironment || input.managedTunnelActive;
  const publish = input.publishAgentActivity;
  if (!managedTunnel && !publish) {
    return null;
  }
  return { managedTunnel, publish };
}
