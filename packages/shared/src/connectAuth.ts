import { readHashParams } from "./remote.ts";

const CONNECT_AUTH_STATE_PARAM = "state";
const CONNECT_AUTH_CHALLENGE_PARAM = "challenge";
const CONNECT_AUTH_PORT_PARAM = "port";
const CONNECT_AUTH_DEVICE_PARAM = "device";
const CONNECT_AUTH_DEVICE_MAX_LENGTH = 80;
const CONNECT_LOOPBACK_CALLBACK_PATH = "/callback";

const CONNECT_AUTHORIZE_PATH = "/connect";

export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

export const CONNECT_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export interface ConnectAuthorizeRequest {
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
  /**
   * Short label for the machine running the CLI ("host · shell"), shown on
   * the hosted page so the user can tell which terminal is asking. Rides the
   * fragment like the rest of the request, so it never reaches a server log.
   */
  readonly device?: string;
}

/** Route through /connect because Clerk's signed-out redirect can lose OAuth query parameters. */
export function buildConnectAuthorizeRequestUrl(input: {
  readonly hostedAppUrl: string;
  readonly state: string;
  readonly challenge: string;
  readonly loopbackPort: number;
  readonly device?: string;
}): string {
  const url = new URL(CONNECT_AUTHORIZE_PATH, input.hostedAppUrl);
  const params = new URLSearchParams([
    [CONNECT_AUTH_STATE_PARAM, input.state],
    [CONNECT_AUTH_CHALLENGE_PARAM, input.challenge],
    [CONNECT_AUTH_PORT_PARAM, String(input.loopbackPort)],
  ]);
  const device = normalizeConnectDevice(input.device);
  if (device) {
    params.set(CONNECT_AUTH_DEVICE_PARAM, device);
  }
  url.hash = params.toString();
  return url.toString();
}

export function readConnectAuthorizeRequest(url: URL): ConnectAuthorizeRequest | null {
  const params = readHashParams(url);
  const state = params.get(CONNECT_AUTH_STATE_PARAM)?.trim() ?? "";
  const challenge = params.get(CONNECT_AUTH_CHALLENGE_PARAM)?.trim() ?? "";
  const loopbackPort = parseLoopbackPort(params.get(CONNECT_AUTH_PORT_PARAM)?.trim() ?? "");
  if (!state || !challenge || loopbackPort === null) {
    return null;
  }
  const device = normalizeConnectDevice(params.get(CONNECT_AUTH_DEVICE_PARAM));
  return device ? { state, challenge, loopbackPort, device } : { state, challenge, loopbackPort };
}

function normalizeConnectDevice(value: string | null | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  return trimmed ? trimmed.slice(0, CONNECT_AUTH_DEVICE_MAX_LENGTH) : null;
}

const CONNECT_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Short code derived from the request `state`, e.g. "HQ7K-2M4X". The CLI
 * prints it and the hosted page shows it, so the user can check that the
 * browser tab belongs to the terminal that asked. Both sides derive it, so it
 * never travels on its own.
 */
export function connectAuthorizeRequestCode(state: string): string {
  // FNV-1a, 64-bit, folded to 40 bits: eight Crockford base32 characters.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(state)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  let folded = (hash ^ (hash >> 40n)) & 0xffffffffffn;
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code = CONNECT_CODE_ALPHABET.charAt(Number(folded & 31n)) + code;
    folded >>= 5n;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Where the hosted page sends the browser when the user cancels: the CLI's
 * loopback callback with the standard OAuth `access_denied` error, so the
 * waiting terminal stops instead of timing out.
 */
export function connectLoopbackCancelUrl(request: ConnectAuthorizeRequest): string {
  const url = new URL(connectLoopbackRedirectUri(request.loopbackPort));
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("state", request.state);
  return url.toString();
}

function parseLoopbackPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Must match the loopback redirect URI registered on the Clerk CLI OAuth app. */
export function connectLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CONNECT_LOOPBACK_CALLBACK_PATH}`;
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
