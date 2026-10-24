import {
  GUEST_RENDER_ROUTE,
  GUEST_ROUTE_PREFIX,
  GUEST_SHARE_PARAM,
  GUEST_SHARE_TTL_MS,
  GuestRedeemRequest,
  GuestSubmitRequest,
  guestSessionCookieName,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { htmlRenderFileName } from "@t3tools/shared/htmlRender";

import { assetFileResponse } from "../http.ts";
import { GuestShareService, type GuestShareAccessError } from "./GuestShareService.ts";

// Cloudflare closes idle streams after about 100 seconds.
const HEARTBEAT_INTERVAL = Duration.seconds(20);
const NO_STORE = { "cache-control": "no-store" };

const decodeRedeem = Schema.decodeUnknownEffect(GuestRedeemRequest);
const decodeSubmit = Schema.decodeUnknownEffect(GuestSubmitRequest);

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

/** The session for the share the request names in `?share=`. */
const sessionToken = Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
  sessionFor(
    request,
    new URLSearchParams(request.url.split("?", 2)[1] ?? "").get(GUEST_SHARE_PARAM),
  ),
);

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
        const data = events.pipe(Stream.map((event) => `data: ${JSON.stringify(event)}\n\n`));
        const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(Stream.map(() => ": ping\n\n"));
        return HttpServerResponse.stream(
          data.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            // no-transform keeps the compression middleware from buffering the stream.
            headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
          },
        );
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
    const request = yield* HttpServerRequest.HttpServerRequest;
    const itemId = new URLSearchParams(request.url.split("?", 2)[1] ?? "").get("item");
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

export const layer = Layer.mergeAll(
  redeemRoute,
  sessionRoute,
  submitRoute,
  streamRoute,
  renderRoute,
);
