import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { requestUrl } from "../requestUrl.ts";
import { RelayUsageMeter } from "./relayUsage.ts";
import { parseGrantToken } from "./shareCode.ts";
import {
  SHARE_RELAY_PREFIX,
  SHARE_ROUTE_PREFIX,
  UsageSharingService,
} from "./UsageSharingService.ts";

const decodeJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
// Only what the upstream API needs. Cookies, the recipient's own auth, and hop headers stay out.
const FORWARDED_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
];

/** Errors in the shape both the Anthropic and OpenAI clients show to the agent and user. */
const relayError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { type: "error", error: { type: "continuum_share_error", message } },
    { status },
  );

const tokenOf = (request: HttpServerRequest.HttpServerRequest) =>
  parseGrantToken(request.headers["authorization"] ?? request.headers["x-api-key"] ?? null);

const clientAddress = (request: HttpServerRequest.HttpServerRequest) =>
  Option.getOrElse(request.remoteAddress, () => "unknown");

const infoRoute = HttpRouter.add(
  "GET",
  `${SHARE_ROUTE_PREFIX}/info`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = tokenOf(request);
    if (token === null) return relayError(401, "This sharing code is not valid.");
    const sharing = yield* UsageSharingService;
    const result = yield* sharing.info(token.grantId, token.secret);
    return result.info === null
      ? relayError(result.status, result.message)
      : HttpServerResponse.jsonUnsafe(result.info, { status: 200 });
  }).pipe(Effect.withTracerEnabled(false)),
);

const relayRoute = HttpRouter.add(
  "*",
  `${SHARE_RELAY_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    if (Option.isNone(url)) return relayError(400, "Bad request.");
    const token = tokenOf(request);
    if (token === null) return relayError(401, "This sharing code is not valid.");
    const path = url.value.pathname.slice(SHARE_RELAY_PREFIX.length);
    const method = request.method;
    if (method !== "GET" && method !== "POST") return relayError(405, "Method not allowed.");

    const body = method === "POST" ? yield* request.text.pipe(Effect.orElseSucceed(() => "")) : "";
    if (body.length > MAX_REQUEST_BYTES) return relayError(413, "Request too large.");
    const parsed =
      body === "" ? Option.some<unknown>({}) : yield* decodeJsonBody(body).pipe(Effect.option);
    if (Option.isNone(parsed)) return relayError(400, "The request body must be JSON.");
    const fields =
      typeof parsed.value === "object" && parsed.value !== null
        ? (parsed.value as { model?: unknown; stream?: unknown })
        : {};
    const model = typeof fields.model === "string" ? fields.model : null;
    const streaming = fields.stream === true;

    const sharing = yield* UsageSharingService;
    const admission = yield* sharing.admit({
      grantId: token.grantId,
      secret: token.secret,
      path,
      model,
      clientAddress: clientAddress(request),
    });
    if (!admission.ok) return relayError(admission.status, admission.message);

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    // Exactly once per request, whether the stream ends, fails, or the recipient disconnects.
    let finished = false;
    const finishOnce = (usage: { inputTokens: number; outputTokens: number }) =>
      Effect.suspend(() => {
        if (finished) return Effect.void;
        finished = true;
        return admission.finish(usage);
      });
    let meter: RelayUsageMeter | null = null;
    yield* Effect.addFinalizer(() =>
      finishOnce(meter?.finish().usage ?? { inputTokens: 0, outputTokens: 0 }),
    );
    const upstreamUrl = `${admission.upstream.baseUrl}${path}${url.value.search}`;
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const outgoing = HttpClientRequest.make(method)(upstreamUrl).pipe(
      HttpClientRequest.setHeaders({ ...headers, ...admission.upstream.headers }),
      method === "POST"
        ? HttpClientRequest.bodyText(body, headers["content-type"] ?? "application/json")
        : (self) => self,
    );
    const response = yield* client.execute(outgoing).pipe(
      Effect.tapError(() => finishOnce({ inputTokens: 0, outputTokens: 0 })),
      Effect.orElseSucceed(() => null),
    );
    if (response === null) {
      return relayError(502, "The owner's AI source did not answer. Try again shortly.");
    }

    const activeMeter = new RelayUsageMeter(
      streaming || (response.headers["content-type"] ?? "").includes("event-stream"),
    );
    meter = activeMeter;
    const decoder = new TextDecoder();
    const metered = response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => activeMeter.push(decoder.decode(chunk, { stream: true }))),
      ),
      Stream.ensuring(Effect.suspend(() => finishOnce(activeMeter.finish().usage))),
    );
    const responseHeaders: Record<string, string> = {};
    for (const name of ["content-type", "request-id", "x-request-id", "retry-after"]) {
      const value = response.headers[name];
      if (value !== undefined) responseHeaders[name] = value;
    }
    responseHeaders["cache-control"] = "no-store, no-transform";
    return HttpServerResponse.stream(metered, {
      status: response.status,
      headers: responseHeaders,
      ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
    });
  }).pipe(Effect.withTracerEnabled(false)),
);

/** The relay recipients reach. It authenticates sharing tokens only, never app sessions. */
export const usageSharingRoutesLayer = Layer.mergeAll(infoRoute, relayRoute);
