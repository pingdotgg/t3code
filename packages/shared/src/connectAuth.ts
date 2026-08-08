import { readHashParams } from "./remote.ts";

const CONNECT_AUTH_STATE_PARAM = "state";
const CONNECT_AUTH_CHALLENGE_PARAM = "challenge";
const CONNECT_AUTH_CODE_SEPARATOR = ".";

const CONNECT_AUTHORIZE_PATH = "/connect";
const CONNECT_CALLBACK_PATH = "/connect/callback";

/**
 * The CLI prints URLs against this origin and the web bundle uses it to
 * decide whether it is the hosted deployment — the two must agree, so the
 * default lives here.
 */
export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

/**
 * Requested at authorize time by the hosted page and honored by the CLI's
 * token exchange; keep both sides on this single definition.
 */
export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email"] as const;

export interface ConnectAuthorizeRequest {
  readonly state: string;
  readonly challenge: string;
}

/**
 * `state` is base64url over 16 random bytes and the PKCE `challenge` is
 * base64url over a SHA-256 digest, so both have a fixed length and alphabet.
 * Keep these in sync with the CLI's request generation.
 */
const CONNECT_AUTH_STATE_LENGTH = 22;
const CONNECT_AUTH_CHALLENGE_LENGTH = 43;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isBase64Url(value: string, length: number): boolean {
  return value.length === length && BASE64URL_PATTERN.test(value);
}

/**
 * `missing` means the fragment carries no request at all; `malformed` means it
 * carries one that the CLI could not have printed — the shape a connect URL
 * takes when it is truncated or picks up stray characters while being copied
 * out of a wrapped terminal line.
 */
export type ConnectAuthorizeRequestProblem = "missing" | "malformed";

export type ConnectAuthorizeRequestResult =
  | { readonly ok: true; readonly request: ConnectAuthorizeRequest }
  | { readonly ok: false; readonly problem: ConnectAuthorizeRequestProblem };

/**
 * The URL a headless CLI prints for the user to open on a machine with a
 * browser. `state` and `code_challenge` ride the fragment so they never reach
 * the hosted app's server or CDN logs; neither is a secret.
 */
export function buildConnectAuthorizeRequestUrl(input: {
  readonly hostedAppUrl: string;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(CONNECT_AUTHORIZE_PATH, input.hostedAppUrl);
  url.hash = new URLSearchParams([
    [CONNECT_AUTH_STATE_PARAM, input.state],
    [CONNECT_AUTH_CHALLENGE_PARAM, input.challenge],
  ]).toString();
  return url.toString();
}

/**
 * Checks the fragment against the shape the CLI prints before any of it is
 * used, so a corrupted copy of the URL is reported here rather than after a
 * full browser authorization that the waiting CLI would reject anyway.
 */
export function readConnectAuthorizeRequest(url: URL): ConnectAuthorizeRequestResult {
  const params = readHashParams(url);
  const state = params.get(CONNECT_AUTH_STATE_PARAM)?.trim() ?? "";
  const challenge = params.get(CONNECT_AUTH_CHALLENGE_PARAM)?.trim() ?? "";
  if (!state || !challenge) {
    return { ok: false, problem: "missing" };
  }
  if (
    !isBase64Url(state, CONNECT_AUTH_STATE_LENGTH) ||
    !isBase64Url(challenge, CONNECT_AUTH_CHALLENGE_LENGTH)
  ) {
    return { ok: false, problem: "malformed" };
  }
  return { ok: true, request: { state, challenge } };
}

export function connectCallbackUrl(hostedAppUrl: string): string {
  return new URL(CONNECT_CALLBACK_PATH, hostedAppUrl).toString();
}

export function buildConnectClerkAuthorizeUrl(input: {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface ConnectAuthCode {
  readonly code: string;
  readonly state: string;
}

/**
 * The single blob the hosted callback page displays and the CLI accepts.
 * Bundling `state` with the authorization code lets the CLI keep the loopback
 * flow's CSRF check without any backend: it verifies the returned state
 * matches the one it generated. Clerk authorization codes and the CLI's
 * base64url states never contain ".".
 */
export function encodeConnectAuthCode(input: ConnectAuthCode): string {
  return `${input.code}${CONNECT_AUTH_CODE_SEPARATOR}${input.state}`;
}

/**
 * Validates an out-of-band authorization code against the state of the request this process
 * generated. Returns the parsed code or a user-facing error message; both
 * the prompt's live validation and the authoritative post-prompt check go
 * through here so they cannot drift.
 */
export function checkConnectAuthCode(
  blob: string,
  expectedState: string,
): ConnectAuthCode | string {
  const parsed = parseConnectAuthCode(blob);
  if (parsed === null) {
    return "That does not look like a T3 Connect code. Copy the full code.";
  }
  if (parsed.state !== expectedState) {
    return "That code belongs to a different connect request. Open the URL above and try again.";
  }
  return parsed;
}

export function parseConnectAuthCode(blob: string): ConnectAuthCode | null {
  const trimmed = blob.trim();
  const separatorIndex = trimmed.lastIndexOf(CONNECT_AUTH_CODE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return null;
  }
  const code = trimmed.slice(0, separatorIndex);
  const state = trimmed.slice(separatorIndex + 1);
  return { code, state };
}
