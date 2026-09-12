import * as Schema from "effect/Schema";

/**
 * Accounts that opted out of the post-sign-in T3 Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "t3code:connect-onboarding-opt-out:v1";

export const CONNECT_ONBOARDING_AUTH_PENDING_STORAGE_KEY =
  "t3code:connect-onboarding-auth-pending:v1";

export function markConnectOnboardingAuthPending() {
  try {
    window.sessionStorage.setItem(CONNECT_ONBOARDING_AUTH_PENDING_STORAGE_KEY, "1");
  } catch {
    // The marker is optional. Storage errors must not stop sign-in.
  }
}

export function consumeConnectOnboardingAuthPending() {
  try {
    const storage = window.sessionStorage;
    const isPending = storage.getItem(CONNECT_ONBOARDING_AUTH_PENDING_STORAGE_KEY) === "1";
    if (isPending) {
      storage.removeItem(CONNECT_ONBOARDING_AUTH_PENDING_STORAGE_KEY);
    }
    return isPending;
  } catch {
    // Ignore a marker that cannot be read or removed.
    return false;
  }
}

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};
