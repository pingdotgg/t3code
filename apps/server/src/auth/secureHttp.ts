import {
  makeSecureHttpExchange,
  SECURE_HTTP_KEY_PATH,
  SECURE_HTTP_MAX_BODY_BYTES,
  SECURE_HTTP_MAX_ENVELOPE_BYTES,
  SECURE_HTTP_PATH,
  SECURE_HTTP_STALE_KEY_STATUS,
  SecureHttpError,
  type SecureHttpInnerRequest,
  type SecureHttpInnerResponse,
} from "@t3tools/shared/secureHttp";
import * as ByteSize from "effect/ByteSize";
import type * as Aead from "effect/crypto/Aead";
import type * as Digest from "effect/crypto/Digest";
import type * as Kdf from "effect/crypto/Kdf";
import type * as KeyAgreement from "effect/crypto/KeyAgreement";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SealedHttpRequest } from "./dpop.ts";

// Set from the outer request and its connection, never from the sealed headers.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "accept-encoding",
  "cookie",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
// Session metadata the routes read from the connection, as on an unsealed request.
const CARRIED_OUTER_HEADERS = ["user-agent", "x-forwarded-for"] as const;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

const plainError = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers: { "cache-control": "no-store" } });

function innerServerRequest(
  outer: HttpServerRequest.HttpServerRequest,
  inner: SecureHttpInnerRequest,
): HttpServerRequest.HttpServerRequest | undefined {
  let url: URL;
  try {
    url = new URL(inner.url);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.pathname.startsWith(SECURE_HTTP_PATH)
  ) {
    return undefined;
  }
  const method = inner.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(inner.headers)) {
    const lower = name.toLowerCase();
    if (!DROPPED_REQUEST_HEADERS.has(lower)) headers[lower] = value;
  }
  for (const name of CARRIED_OUTER_HEADERS) {
    const value = outer.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  headers.host = url.host;
  if (hasBody) headers["content-length"] = String(inner.body.length);
  let source: Request;
  try {
    source = new Request(url, { method, ...(hasBody ? { body: inner.body } : {}) });
  } catch {
    return undefined;
  }
  return HttpServerRequest.fromWeb(source).modify({
    headers: Headers.fromInput(headers),
    remoteAddress: outer.remoteAddress,
    peerAddress: outer.peerAddress,
  });
}

async function readLimited(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > SECURE_HTTP_MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Sealed response body is too large.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

const readResponse = Effect.fnUntraced(function* (response: HttpServerResponse.HttpServerResponse) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
  }
  const responseBody = response.body;
  const contentType = "contentType" in responseBody ? responseBody.contentType : undefined;
  if (contentType !== undefined) headers["content-type"] = contentType;
  const body =
    responseBody._tag === "Empty"
      ? new Uint8Array(0)
      : responseBody._tag === "Uint8Array"
        ? responseBody.body
        : yield* Effect.context<never>().pipe(
            Effect.flatMap((context) =>
              Effect.tryPromise({
                try: () => readLimited(HttpServerResponse.toWeb(response, { context }).body),
                catch: (cause) => new SecureHttpError({ reason: "too_large", cause }),
              }),
            ),
          );
  return { status: response.status, headers, body } satisfies SecureHttpInnerResponse;
});

/**
 * `GET /api/secure/key` serves the environment's signed exchange key; `POST /api/secure` opens a
 * sealed request, runs it through every route as if it had arrived directly, and seals the answer.
 */
export const layer = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const signingKey = yield* EnvironmentSigningKey;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const crypto = yield* Effect.context<
      Aead.Aead | Digest.Digest | Kdf.Kdf | KeyAgreement.KeyAgreement | SecureRandom.SecureRandom
    >();
    const exchange = yield* Effect.cached(
      Effect.gen(function* () {
        return yield* makeSecureHttpExchange({
          environmentId: yield* serverEnvironment.getEnvironmentId,
          identity: yield* signingKey.secureChannelIdentity,
          issuedAt: DateTime.formatIso(yield* DateTime.now),
        });
      }).pipe(Effect.provideContext(crypto)),
    );
    // Built on first use, after every route and middleware has registered. Route failures become
    // responses inside `toHandled`, as they do for a request that arrives directly.
    let routes: ReturnType<typeof router.asHttpEffect> | undefined;

    const dispatch = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      routes ??= router.asHttpEffect();
      let answered: SecureHttpInnerResponse | undefined;
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off
      yield* HttpEffect.toHandled(routes, (_request, response) =>
        readResponse(response).pipe(
          Effect.map((read) => {
            answered = read;
          }),
        ),
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(SealedHttpRequest, true),
        // After a route failure `toHandled` hands over the error response and then fails with it.
        // Left to propagate, the outer request would answer with that response in plaintext.
        Effect.exit,
      );
      return answered;
    });

    yield* router.add(
      "GET",
      SECURE_HTTP_KEY_PATH,
      exchange.pipe(
        Effect.map((opened) =>
          HttpServerResponse.jsonUnsafe(opened.key, { headers: { "cache-control": "no-store" } }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not create the secure HTTP key.", { error }).pipe(
            Effect.as(plainError(500, "secure_key_unavailable")),
          ),
        ),
      ),
    );

    yield* router.add(
      "POST",
      SECURE_HTTP_PATH,
      Effect.gen(function* () {
        const outer = yield* HttpServerRequest.HttpServerRequest;
        const current = yield* Effect.result(exchange);
        if (Result.isFailure(current)) return plainError(500, "secure_key_unavailable");
        const envelope = yield* outer.arrayBuffer.pipe(
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            ByteSize.bytes(SECURE_HTTP_MAX_ENVELOPE_BYTES),
          ),
          Effect.result,
        );
        if (Result.isFailure(envelope)) return plainError(413, "secure_request_too_large");
        const opened = yield* Effect.result(current.success.open(new Uint8Array(envelope.success)));
        if (Result.isFailure(opened)) {
          return opened.failure.reason === "unknown_key"
            ? plainError(SECURE_HTTP_STALE_KEY_STATUS, "secure_key_unknown")
            : plainError(400, "secure_request_invalid");
        }
        const inner = innerServerRequest(outer, opened.success.request);
        if (inner === undefined) return plainError(400, "secure_request_invalid");
        const response = yield* dispatch(inner);
        if (response === undefined) return plainError(500, "secure_response_unavailable");
        const sealed = yield* Effect.result(opened.success.seal(response));
        if (Result.isFailure(sealed)) return plainError(500, "secure_response_unavailable");
        return HttpServerResponse.uint8Array(sealed.success, {
          contentType: "application/octet-stream",
          headers: { "cache-control": "no-store" },
        });
      }),
    );
  }),
);
