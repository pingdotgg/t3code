import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpMethod from "effect/http/HttpMethod";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { withoutRedirects } from "../environments/EnvironmentConnector.ts";

/** Set by the relay on every forward; the environment uses it as the delivery id. */
const RELAY_DELIVERY_ID_HEADER = "x-t3-relay-delivery-id";
/** When the relay received the request; the environment trusts it only with the delivery id. */
const RELAY_RECEIVED_AT_HEADER = "x-t3-relay-received-at";
/** The environment answers with a small JSON status; anything past this is cut off. */
const MAX_RESPONSE_BYTES = 64 * 1024;
export const RELAY_HOOK_UPSTREAM_TIMEOUT_MS = 8_000;
// Cloudflare answers 530 when the tunnel for a hostname has no connected origin.
export const TUNNEL_OFFLINE_STATUS = 530;

/** A webhook request as the relay sends it on to the environment. */
export interface UpstreamHook {
  readonly id: string;
  readonly receivedAt: string;
  readonly method: string;
  /** Path segments exactly as the sender sent them; the environment decodes them. */
  readonly rawHookId: string;
  readonly rawToken: string;
  /** Without the leading `?`. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly contentType: string | undefined;
  /** What the environment did with the request (`x-t3-hook-outcome`). */
  readonly outcome: string | undefined;
  readonly body: Uint8Array;
}

/** Outcome names are short identifiers; anything else is not recorded. */
const OUTCOME_PATTERN = /^[a-z_]{1,32}$/;

class ResponseTooLarge extends Schema.TaggedError<ResponseTooLarge>()("ResponseTooLarge", {}) {}

/** Reads a response body, failing once it passes the cap rather than buffering it all. */
const readCapped = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    return response.stream.pipe(
      Stream.runForEach((chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) return Effect.fail(new ResponseTooLarge());
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.map(() => {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return body;
      }),
      // A response without a body, such as a redirect, has no stream at all.
      Effect.catchIf(
        (error) => error._tag === "HttpClientError" && error.reason._tag === "EmptyBodyError",
        () => Effect.succeed(new Uint8Array(0)),
      ),
    );
  });

/**
 * Sends a webhook request through the environment's tunnel. Fails when the
 * environment cannot be reached, and succeeds with None on timeout.
 */
export const sendUpstream = (baseUrl: string, hook: UpstreamHook) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    // The environment's span joins this trace. Set by hand: the client span
    // that would propagate it is off, because it records the token in url.full.
    const parent = yield* Effect.currentSpan.pipe(Effect.option);
    // `hook.headers` carries the signed delivery proof, set once when the
    // relay received the request, so a held request sends the same proof.
    const headers: Record<string, string> = {
      ...hook.headers,
      ...(Option.isSome(parent) ? HttpTraceContext.toHeaders(parent.value) : {}),
      [RELAY_DELIVERY_ID_HEADER]: hook.id,
      [RELAY_RECEIVED_AT_HEADER]: hook.receivedAt,
    };
    let request = HttpClientRequest.make(hook.method as "GET" | "POST" | "PUT" | "PATCH")(
      `${base}api/hooks/${hook.rawHookId}/${hook.rawToken}${hook.query ? `?${hook.query}` : ""}`,
      { headers },
    );
    if (HttpMethod.hasBody(request.method)) {
      request = HttpClientRequest.bodyUint8Array(request, hook.body, headers["content-type"]);
    }
    return yield* httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        readCapped(response).pipe(
          Effect.map((body): UpstreamResponse => {
            const outcome = response.headers["x-t3-hook-outcome"];
            return {
              status: response.status,
              contentType: response.headers["content-type"],
              outcome: outcome !== undefined && OUTCOME_PATTERN.test(outcome) ? outcome : undefined,
              body,
            };
          }),
        ),
      ),
      withoutRedirects,
      // The client span would record url.full, which carries the token.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.timeoutOption(Duration.millis(RELAY_HOOK_UPSTREAM_TIMEOUT_MS)),
    );
  });
