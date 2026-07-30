import {
  buildConnectClerkAuthorizeUrl,
  connectCallbackUrl,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
  type ConnectAuthorizeRequest,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";

const stateStorageKey = "t3code-connect-cli-auth-state";

function value(name: string): string | null {
  const resolved = import.meta.env[name]?.trim();
  return resolved || null;
}

export function isConnectCliAuthEnabled(): boolean {
  const hostedUrl = new URL(configuredHostedAppUrl());
  return Boolean(
    !value("VITE_HTTP_URL") &&
    new URL(window.location.href).origin === hostedUrl.origin &&
    value("VITE_CLERK_PUBLISHABLE_KEY") &&
    value("VITE_CLERK_CLI_OAUTH_CLIENT_ID"),
  );
}

function configuredHostedAppUrl(): string {
  return value("VITE_HOSTED_APP_URL") ?? DEFAULT_HOSTED_APP_URL;
}

export function buildConnectCliAuthorizeUrl(request: ConnectAuthorizeRequest): string | null {
  const publishableKey = value("VITE_CLERK_PUBLISHABLE_KEY");
  const clientId = value("VITE_CLERK_CLI_OAUTH_CLIENT_ID");
  if (!publishableKey || !clientId) return null;
  return buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: `${clerkFrontendApiUrlFromPublishableKey(publishableKey)}/oauth/authorize`,
    clientId,
    redirectUri: connectCallbackUrl(configuredHostedAppUrl()),
    scopes: CONNECT_OAUTH_SCOPES,
    state: request.state,
    challenge: request.challenge,
  });
}

export function rememberConnectCliAuthState(state: string): void {
  window.sessionStorage.setItem(stateStorageKey, state);
}

export function readConnectCliAuthState(): string | null {
  return window.sessionStorage.getItem(stateStorageKey);
}
