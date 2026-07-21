import {
  buildConnectClerkAuthorizeUrl,
  connectCallbackUrl,
  CONNECT_OAUTH_SCOPES,
  type ConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";

import { configuredHostedAppUrl, isHostedStaticApp } from "../hostedPairing";
import { hasCloudPublicConfig, resolveCloudPublicConfig, trimNonEmpty } from "./publicConfig";

const CONNECT_CLI_AUTH_STATE_STORAGE_KEY = "t3code-connect-cli-auth-state";

export function resolveConnectCliOAuthClientId(): string | null {
  return trimNonEmpty(import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID as string | undefined);
}

export function hasConnectCliAuthConfig(): boolean {
  return Boolean(
    resolveCloudPublicConfig().clerkPublishableKey && resolveConnectCliOAuthClientId(),
  );
}

/**
 * Gate for the /connect routes: the CLI handshake only exists on the hosted
 * deployment (the same bundle ships inside local instances) and needs the
 * Clerk CLI OAuth client configured at build time.
 */
export function connectCliAuthRoutesEnabled(): boolean {
  return isHostedStaticApp() && hasCloudPublicConfig() && hasConnectCliAuthConfig();
}

/**
 * Builds the Clerk authorize URL for a CLI-initiated connect request. The
 * state is mirrored into sessionStorage so the callback page can verify the
 * response matches a request this browser actually started.
 */
export function buildConnectCliClerkAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const { clerkPublishableKey } = resolveCloudPublicConfig();
  const clientId = resolveConnectCliOAuthClientId();
  if (!clerkPublishableKey || !clientId) {
    return null;
  }
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey)}/oauth/authorize`,
    clientId,
    redirectUri: connectCallbackUrl(configuredHostedAppUrl()),
    scopes: CONNECT_OAUTH_SCOPES,
    state: request.state,
    challenge: request.challenge,
  });
}

export function rememberConnectCliAuthState(state: string): void {
  try {
    window.sessionStorage.setItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY, state);
  } catch {
    // Session storage can be unavailable (e.g. blocked). The callback page
    // then falls back to trusting the state Clerk echoed back.
  }
}

/**
 * Read-only on purpose: this runs during render, where a removal would be
 * consumed by React's double-invoked/discarded renders (StrictMode) and
 * silently disable the state check. The value is not a secret and is
 * overwritten by the next /connect visit.
 */
export function readConnectCliAuthState(): string | null {
  try {
    return window.sessionStorage.getItem(CONNECT_CLI_AUTH_STATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export interface ConnectCliCallbackResult {
  readonly code: string;
  readonly state: string;
}

export function readConnectCliCallbackResult(
  url: URL = new URL(window.location.href),
): ConnectCliCallbackResult | null {
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!code || !state) {
    return null;
  }
  return { code, state };
}
