import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/unstable/http";

import type {
  HttpClientError,
  PluginHttpClientTransport,
} from "./capabilities/HttpClientCapability.ts";
import {
  OutboundUrlError,
  OutboundUrlValidator,
  type UrlValidatorDeps,
} from "./OutboundUrlValidator.ts";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Caller headers that survive a CROSS-ORIGIN redirect.
 *
 * An ALLOWLIST, not a denylist of "authorization, cookie, ...". A caller's headers
 * were chosen for the origin it addressed; after a redirect elsewhere, none of them
 * were chosen for THAT host. Listing what is safe means the next caller to pass
 * `x-api-key` — a name no denylist would have predicted — is protected without anyone
 * remembering to update this file.
 *
 * These are content negotiation only: they say what we want back, never who we are.
 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
]);

const stripCrossOriginHeaders = (
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())),
  );

/**
 * SSRF-guarded GET for host-side ingestion of untrusted marketplace/tarball
 * URLs. Every hop — the initial URL AND every redirect Location — is validated
 * through {@link OutboundUrlValidator} (https-only, loopback/RFC1918/link-local/
 * metadata ranges blocked) and fetched through the DNS-pinned transport, so a
 * malicious-but-https URL cannot 30x-redirect the host into internal services
 * and DNS rebinding cannot swap the address between check and connect.
 * Redirects are never followed implicitly: the transport does not follow them,
 * and this loop re-validates each Location before issuing the next request.
 */
export const guardedOutboundHttpGet = (input: {
  readonly url: string;
  readonly lookup: UrlValidatorDeps["lookup"];
  readonly transport: PluginHttpClientTransport;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): Effect.Effect<HttpClientResponse.HttpClientResponse, OutboundUrlError | HttpClientError> =>
  Effect.gen(function* () {
    let currentUrl = input.url;
    // Once the chain leaves the origin the CALLER addressed, it never earns the
    // credential back — not even on a hop whose origin matches again.
    //
    // Comparing each hop's origin against the caller's is not enough, and a test
    // caught it: in A -> B -> A the third hop's origin IS the caller's, so an
    // origin-equality check re-sends the credential — to a URL that B chose. The
    // question is not "where are we?" but "did someone else decide we go here?".
    let tainted = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const resolved = yield* OutboundUrlValidator.resolve(currentUrl, { lookup: input.lookup });
      // Cross-origin: the caller's headers were scoped to an origin we have now left.
      // Forwarding them lets the first server 30x us to a host of its choosing and be
      // handed whatever credential the caller passed.
      const headers = tainted
        ? stripCrossOriginHeaders(input.headers ?? {})
        : (input.headers ?? {});
      const response = yield* input.transport({
        url: resolved.url,
        method: "GET",
        headers,
        body: null,
        timeoutMs: input.timeoutMs,
        address: resolved.addresses[0]!,
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers["location"];
      // A redirect status without a Location cannot be followed; hand it to the
      // caller, whose status filter rejects it as a non-OK response.
      if (location === undefined || location.length === 0) return response;
      // The redirect body is unused; drain it so a pinned socket is not left
      // occupied until its timeout.
      yield* response.stream.pipe(Stream.runDrain, Effect.ignore);
      const next = yield* Effect.try({
        try: () => new URL(location, resolved.url),
        catch: () => new OutboundUrlError({ reason: "Redirect Location is malformed" }),
      });
      // The moment a server sends us somewhere else, every later hop is its choice.
      if (next.origin !== resolved.url.origin) tainted = true;
      currentUrl = next.toString();
    }
    return yield* new OutboundUrlError({ reason: "Too many redirects" });
  });
