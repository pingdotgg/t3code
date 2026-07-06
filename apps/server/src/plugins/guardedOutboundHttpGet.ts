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
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const resolved = yield* OutboundUrlValidator.resolve(currentUrl, { lookup: input.lookup });
      const response = yield* input.transport({
        url: resolved.url,
        method: "GET",
        headers: input.headers ?? {},
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
      currentUrl = yield* Effect.try({
        try: () => new URL(location, resolved.url).toString(),
        catch: () => new OutboundUrlError({ reason: "Redirect Location is malformed" }),
      });
    }
    return yield* new OutboundUrlError({ reason: "Too many redirects" });
  });
