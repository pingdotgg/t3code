import {
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_ITEM_ROUTE,
  GUEST_RENDER_ROUTE,
  GUEST_ROUTE_PREFIX,
  GUEST_SHARE_PARAM,
  GUEST_SHARE_TTL_MS,
  GuestItemDetail,
  GuestRedeemRequest,
  GuestStreamEvent,
  GuestSubmitRequest,
  guestSessionCookieName,
  OrchestrationV2CommandOutputFrame,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { htmlRenderFileName } from "@t3tools/shared/htmlRender";

import { assetFileResponse } from "../http.ts";
import { GuestShareAccessError, GuestShareService } from "./GuestShareService.ts";

// Cloudflare closes idle streams after about 100 seconds.
const HEARTBEAT_INTERVAL = Duration.seconds(20);
const NO_STORE = { "cache-control": "no-store" };

const decodeRedeem = Schema.decodeUnknownEffect(GuestRedeemRequest);
const decodeSubmit = Schema.decodeUnknownEffect(GuestSubmitRequest);
// Encoding drops every key the guest schema does not declare, so a projector that forgets to strip
// a field still cannot send it.
const encodeStreamEvent = Schema.encodeEffect(Schema.fromJsonString(GuestStreamEvent));
const encodeItemDetail = Schema.encodeEffect(GuestItemDetail);
const encodeOutputFrame = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationV2CommandOutputFrame),
);

const errorResponse = (error: GuestShareAccessError) =>
  HttpServerResponse.json(
    { reason: error.reason, message: error.message },
    {
      status:
        error.reason === "invalid" || error.reason === "inactive" || error.reason === "unavailable"
          ? 403
          : 409,
      headers: NO_STORE,
    },
  );

const badRequest = HttpServerResponse.json(
  { reason: "invalid", message: "The request was not valid." },
  { status: 400, headers: NO_STORE },
);

const sessionFor = (request: HttpServerRequest.HttpServerRequest, shareId: string | null) =>
  shareId === null ? "" : (request.cookies[guestSessionCookieName(shareId)] ?? "");

const queryParams = (request: HttpServerRequest.HttpServerRequest) =>
  new URLSearchParams(request.url.split("?", 2)[1] ?? "");

/** The session for the share the request names in `?share=`. */
const sessionToken = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  sessionFor(request, queryParams(request).get(GUEST_SHARE_PARAM)),
);

/** The `?item=` a per-item route names. */
const itemParam = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  queryParams(request).get("item"),
);

/** Server-sent events with a heartbeat, never cached or buffered on the way. */
const eventStreamResponse = (data: Stream.Stream<string>) => {
  const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(Stream.map(() => ": ping\n\n"));
  return HttpServerResponse.stream(
    data.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
    {
      contentType: "text/event-stream",
      // no-transform keeps the compression middleware from buffering the stream.
      headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    },
  );
};

const redeemRoute = HttpRouter.add(
  "POST",
  `${GUEST_ROUTE_PREFIX}/redeem`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.flatMap(decodeRedeem), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const guestShares = yield* GuestShareService;
    return yield* guestShares.redeem(body.value).pipe(
      Effect.flatMap(({ token, shareId }) =>
        HttpServerResponse.empty({ status: 204, headers: NO_STORE }).pipe(
          HttpServerResponse.setCookie(guestSessionCookieName(shareId), token, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            path: GUEST_ROUTE_PREFIX,
            maxAge: Duration.millis(GUEST_SHARE_TTL_MS),
          }),
        ),
      ),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);

const submitRoute = HttpRouter.add(
  "POST",
  `${GUEST_ROUTE_PREFIX}/messages`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.flatMap(decodeSubmit), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const guestShares = yield* GuestShareService;
    return yield* guestShares.submit(sessionFor(request, body.value.shareId), body.value).pipe(
      Effect.flatMap(() => Effect.succeed(HttpServerResponse.empty({ status: 204 }))),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);

const streamRoute = HttpRouter.add(
  "GET",
  `${GUEST_ROUTE_PREFIX}/stream`,
  Effect.gen(function* () {
    const guestShares = yield* GuestShareService;
    return yield* guestShares.stream(yield* sessionToken).pipe(
      Effect.map((events) => {
        const data = events.pipe(
          Stream.mapEffect((event) =>
            encodeStreamEvent(event).pipe(
              Effect.map((json) => [`data: ${json}\n\n`]),
              // A bug in the guest projector; the guest misses one update instead of the stream.
              // The error would quote the value, which is exactly what must not spread.
              Effect.catch(() =>
                Effect.logWarning("Dropped a guest stream event that failed to encode.", {
                  type: event.type === "item" ? event.item.type : event.type,
                }).pipe(Effect.as([])),
              ),
            ),
          ),
          Stream.flattenIterable,
        );
        return eventStreamResponse(data);
      }),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);

// Lets a returning guest skip the name form when this browser already joined the share.
const sessionRoute = HttpRouter.add(
  "GET",
  `${GUEST_ROUTE_PREFIX}/session`,
  Effect.gen(function* () {
    const guestShares = yield* GuestShareService;
    return yield* guestShares
      .check(yield* sessionToken)
      .pipe(
        Effect.as(HttpServerResponse.empty({ status: 204, headers: NO_STORE })),
        Effect.catchTags({ GuestShareAccessError: errorResponse }),
      );
  }),
);

// The response carries the asset route's sandbox CSP: the page gets an opaque origin, so its
// scripts cannot send the guest cookie or call these routes as the guest.
const renderRoute = HttpRouter.add(
  "GET",
  GUEST_RENDER_ROUTE,
  Effect.gen(function* () {
    const itemId = yield* itemParam;
    if (!itemId) return yield* badRequest;
    const guestShares = yield* GuestShareService;
    return yield* guestShares.render(yield* sessionToken, itemId).pipe(
      Effect.flatMap(({ path, title }) =>
        assetFileResponse({ path, mimeType: "text/html", fileName: htmlRenderFileName(title) }),
      ),
      // Each load re-checks the share, so a closed, replaced, or expired link stops it at once.
      Effect.map((response) => HttpServerResponse.setHeaders(response, NO_STORE)),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);

const itemRoute = HttpRouter.add(
  "GET",
  GUEST_ITEM_ROUTE,
  Effect.gen(function* () {
    const itemId = yield* itemParam;
    if (!itemId) return yield* badRequest;
    const guestShares = yield* GuestShareService;
    return yield* guestShares.item(yield* sessionToken, itemId).pipe(
      Effect.flatMap((item) =>
        encodeItemDetail({ item }).pipe(
          // Same as the stream: the error would quote the value.
          Effect.mapError(() => new GuestShareAccessError({ reason: "unavailable" })),
        ),
      ),
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);

// Ends when the command settles; the page closes its EventSource on that last frame, so the
// browser does not reconnect.
const commandOutputRoute = HttpRouter.add(
  "GET",
  GUEST_COMMAND_OUTPUT_ROUTE,
  Effect.gen(function* () {
    const itemId = yield* itemParam;
    if (!itemId) return yield* badRequest;
    const guestShares = yield* GuestShareService;
    return yield* guestShares.commandOutput(yield* sessionToken, itemId).pipe(
      Effect.map((frames) =>
        eventStreamResponse(
          frames.pipe(Stream.map((frame) => `data: ${encodeOutputFrame(frame)}\n\n`)),
        ),
      ),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
    );
  }),
);

export const layer = Layer.mergeAll(
  redeemRoute,
  sessionRoute,
  submitRoute,
  streamRoute,
  renderRoute,
  itemRoute,
  commandOutputRoute,
);
