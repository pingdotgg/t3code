import {
  GUEST_ATTACHMENT_ROUTE,
  GUEST_COMMAND_OUTPUT_ROUTE,
  GUEST_ITEM_ROUTE,
  GUEST_RENDER_ROUTE,
  GUEST_ROUTE_PREFIX,
  GUEST_SHARE_PARAM,
  GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  GUEST_MESSAGE_MAX_ATTACHMENTS,
  GUEST_SHARE_TTL_MS,
  GuestItemDetail,
  GuestRedeemRequest,
  GuestStreamEvent,
  GuestSubmitRequest,
  guestSessionCookieName,
  isProviderSendTurnSupportedImageMimeType,
  OrchestrationV2CommandOutputFrame,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse, Multipart } from "effect/http";

import { htmlRenderFileName } from "@t3tools/shared/htmlRender";

import { assetFileResponse, downloadContentDisposition } from "../http.ts";
import type { GuestUpload } from "./guestAttachments.ts";
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
          : error.reason === "empty" ||
              error.reason === "too_many_files" ||
              error.reason === "too_large" ||
              error.reason === "unsupported_file"
            ? 400
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

// The parser stops a request with too many parts or bytes before it reaches the disk; the
// service checks the exact limits and types.
const UPLOAD_LIMITS = Multipart.limitsServices({
  maxParts: GUEST_MESSAGE_MAX_ATTACHMENTS + 4,
  maxFileSize: GUEST_MESSAGE_MAX_ATTACHMENT_BYTES,
  maxTotalSize: GUEST_MESSAGE_MAX_ATTACHMENT_BYTES + 64 * 1024,
});

/** A message as JSON (text only), or as multipart form data with `file` parts. */
const readSubmission = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!request.headers["content-type"]?.startsWith("multipart/form-data")) {
    const body = yield* request.json.pipe(Effect.flatMap(decodeSubmit), Effect.option);
    return body._tag === "None" ? null : { fields: body.value, uploads: [] };
  }
  const parts = yield* request.multipart.pipe(
    Effect.provideContext(UPLOAD_LIMITS),
    Effect.mapError(
      (error) =>
        new GuestShareAccessError({
          reason:
            error.reason._tag === "TooManyParts"
              ? "too_many_files"
              : error.reason._tag === "Parse"
                ? "rejected"
                : "too_large",
        }),
    ),
  );
  const fields = yield* decodeSubmit({ shareId: parts.shareId, text: parts.text ?? "" }).pipe(
    Effect.option,
  );
  if (fields._tag === "None") return null;
  const files = parts.file;
  const uploads: ReadonlyArray<GuestUpload> = Array.isArray(files)
    ? files.filter(Multipart.isPersistedFile).map(({ name, contentType, path }) => ({
        name,
        contentType,
        path,
      }))
    : [];
  return { fields: fields.value, uploads };
});

const submitRoute = HttpRouter.add(
  "POST",
  `${GUEST_ROUTE_PREFIX}/messages`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const guestShares = yield* GuestShareService;
    const submission = yield* readSubmission;
    if (submission === null) return yield* badRequest;
    yield* guestShares.submit(
      sessionFor(request, submission.fields.shareId),
      submission.fields,
      submission.uploads,
    );
    return HttpServerResponse.empty({ status: 204, headers: NO_STORE });
  }).pipe(
    Effect.catchTags({ GuestShareAccessError: errorResponse }),
    // The parser's temporary files are removed once the response is ready.
    Effect.scoped,
  ),
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

// Images of the four checked types load inline; anything else downloads as bytes, so a guest's
// HTML or SVG never renders as a page on this origin.
const attachmentRoute = HttpRouter.add(
  "GET",
  GUEST_ATTACHMENT_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const attachmentId = queryParams(request).get("id");
    if (!attachmentId) return yield* badRequest;
    const guestShares = yield* GuestShareService;
    return yield* guestShares.attachment(yield* sessionToken, attachmentId).pipe(
      Effect.flatMap(({ path, attachment }) =>
        HttpServerResponse.file(path, {
          headers: {
            ...NO_STORE,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            ...(attachment.type === "image" &&
            isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
              ? { "content-type": attachment.mimeType }
              : {
                  "content-type": "application/octet-stream",
                  "content-disposition": downloadContentDisposition(attachment.name),
                }),
          },
        }),
      ),
      Effect.catchTags({ GuestShareAccessError: errorResponse }),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
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
  attachmentRoute,
);
