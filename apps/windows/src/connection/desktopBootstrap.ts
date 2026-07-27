/**
 * Exchanges the sidecar's one-shot bootstrap token for a bearer access token.
 *
 * ## Why the local sidecar is a *bearer* connection here, not a primary one
 *
 * `packages/client-runtime`'s `PrimaryConnectionTarget` assumes same-origin
 * cookie auth — that is how the browser client talks to a server it was served
 * from. A Tauri webview is served from `tauri://localhost`, a different origin
 * from `http://127.0.0.1:<port>`, so cookies never apply. client-runtime
 * already models exactly this case: "secondary local backends live on a
 * separate loopback origin and authenticate with a bearer token minted from
 * their bootstrap credential" (`connection/catalog.ts`). The Windows app's own
 * sidecar is that shape, so it registers as a `BearerConnectionRegistration`
 * emitted from `PlatformConnectionSource`.
 *
 * macOS reaches the same endpoint through `T3Kit/AuthClient.swift`; this is
 * the same two calls in TypeScript.
 */

import * as Schema from "effect/Schema";

/** RFC 8693 token-exchange grant, as the server's `AuthTokenExchangeRequest`. */
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const REQUESTED_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** Shown in the server's session list, alongside the macOS app's "SergeCode". */
export const CLIENT_LABEL = "SurgeCode for Windows";

export interface TokenExchangeInput {
  readonly subjectToken: string;
  readonly clientLabel?: string;
}

/**
 * `AuthTokenExchangeRequest` is declared `HttpApiSchema.asFormUrlEncoded()`
 * (`packages/contracts/src/auth.ts`), so the body is
 * `application/x-www-form-urlencoded` — not JSON. Pure and unit-tested,
 * because getting the field names wrong fails at runtime with an opaque 400.
 */
export function encodeTokenExchangeForm(input: TokenExchangeInput): string {
  const body = new URLSearchParams();
  body.set("grant_type", GRANT_TYPE);
  body.set("subject_token", input.subjectToken);
  body.set("subject_token_type", SUBJECT_TOKEN_TYPE);
  body.set("requested_token_type", REQUESTED_TOKEN_TYPE);
  body.set("client_label", input.clientLabel ?? CLIENT_LABEL);
  body.set("client_device_type", "desktop");
  return body.toString();
}

const AccessTokenResult = Schema.Struct({
  access_token: Schema.String,
});

/** The subset of the environment descriptor the connection needs up front. */
const EnvironmentDescriptor = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.optional(Schema.String),
});

export class DesktopBootstrapError extends Error {
  override readonly name = "DesktopBootstrapError";
  /** Server status line or decode failure — safe to show in the failure card. */
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.detail = detail;
  }
}

/** Injected so tests never touch the network and the module holds no global. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function decodeJson<A, I>(
  response: Response,
  schema: Schema.Codec<A, I>,
  what: string,
): Promise<A> {
  if (!response.ok) {
    throw new DesktopBootstrapError(
      `The local server rejected the ${what} request.`,
      `HTTP ${response.status} ${response.statusText}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new DesktopBootstrapError(`Could not read the ${what} response.`, String(cause));
  }
  const decoded = Schema.decodeUnknownResult(schema)(payload);
  if (decoded._tag === "Failure") {
    throw new DesktopBootstrapError(
      `The ${what} response did not match the expected shape.`,
      String(decoded.failure),
    );
  }
  return decoded.success;
}

/**
 * `POST {httpBaseUrl}/oauth/token`. A sidecar process hands out exactly one
 * bootstrap token per launch, so the caller caches the result for the lifetime
 * of that sidecar — the same rule `AuthClient.acquireAccessToken` follows.
 */
export async function exchangeBootstrapToken(
  fetchImpl: FetchLike,
  httpBaseUrl: string,
  bootstrapToken: string,
): Promise<string> {
  const response = await fetchImpl(joinUrl(httpBaseUrl, "oauth/token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: encodeTokenExchangeForm({ subjectToken: bootstrapToken }),
  });
  const result = await decodeJson(response, AccessTokenResult, "token exchange");
  return result.access_token;
}

/**
 * `GET {httpBaseUrl}/.well-known/t3/environment` — the same endpoint the
 * supervisor polls for readiness, read here for the environment identity the
 * connection registry keys everything on.
 */
export async function fetchEnvironmentDescriptor(
  fetchImpl: FetchLike,
  httpBaseUrl: string,
): Promise<{ environmentId: string; label: string }> {
  const response = await fetchImpl(joinUrl(httpBaseUrl, ".well-known/t3/environment"), {
    headers: { Accept: "application/json" },
  });
  const descriptor = await decodeJson(response, EnvironmentDescriptor, "environment descriptor");
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label ?? "This PC",
  };
}

export interface LocalEnvironmentSession {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
}

/**
 * The whole handshake: identify the environment, then mint the bearer token
 * the connection registers with.
 */
export async function openLocalEnvironmentSession(
  fetchImpl: FetchLike,
  endpoint: { httpBaseUrl: string; wsBaseUrl: string; bootstrapToken: string },
): Promise<LocalEnvironmentSession> {
  const [descriptor, bearerToken] = await Promise.all([
    fetchEnvironmentDescriptor(fetchImpl, endpoint.httpBaseUrl),
    exchangeBootstrapToken(fetchImpl, endpoint.httpBaseUrl, endpoint.bootstrapToken),
  ]);
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    httpBaseUrl: endpoint.httpBaseUrl,
    wsBaseUrl: endpoint.wsBaseUrl,
    bearerToken,
  };
}
