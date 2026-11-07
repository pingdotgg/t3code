/**
 * What an app needs from whichever provider signs the user in to T3 Connect, Clerk or an OpenID
 * Connect server. Signing in differs by platform, so each app adds its own actions.
 */
export interface CloudAuthState {
  readonly provider: "clerk" | "oidc" | null;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  /** A person-readable name for the signed-in account. */
  readonly accountLabel: string | null;
  /** The bearer token the relay verifies; null when signed out. */
  readonly getToken: () => Promise<string | null>;
}

export const SIGNED_OUT_CLOUD_AUTH: CloudAuthState = {
  provider: null,
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  accountLabel: null,
  getToken: async () => null,
};
