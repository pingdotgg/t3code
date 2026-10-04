/**
 * `/api/preview-stream/ws`: one server preview tab over a WebSocket.
 *
 * Frames go out as binary JPEG messages, viewport changes as JSON text, and
 * viewer input comes back as JSON text. The viewer acknowledges each frame and
 * Chromium's acknowledgement waits for it, so a slow link (phone over T3
 * Connect) gets fewer frames instead of a growing buffer. Authentication
 * matches the device hub proxy; the socket drives the page, so it needs
 * operate scope.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const PREVIEW_STREAM_ROUTE_PREFIX = "/api/preview-stream";
/** Matches `PREVIEW_STREAM_TAB_GONE_CODE` in the client. */
const TAB_GONE_CODE = 4404;

const DEFAULT_QUALITY = 70;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_UNACKNOWLEDGED_FRAMES = 64;
const textDecoder = new TextDecoder();

const intParam = (params: URLSearchParams, name: string, fallback: number, max: number) => {
  const value = Number(params.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};

const isAck = (message: unknown) =>
  typeof message === "object" && message !== null && "type" in message && message.type === "ack";

const parseMessage = (chunk: Uint8Array | string): unknown => {
  try {
    return JSON.parse(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
  } catch {
    return null;
  }
};

const makeHandler = (browser: ServerBrowser.ServerBrowser["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    if (
      url.value.pathname !== `${PREVIEW_STREAM_ROUTE_PREFIX}/ws` ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
    const params = url.value.searchParams;
    const threadId = params.get("threadId") ?? "";
    const tabId = params.get("tabId") ?? "";
    if (!browser.enabled || threadId.length === 0 || tabId.length === 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const attached = yield* browser
          .attachViewer({
            threadId,
            tabId,
            maxWidth: intParam(params, "maxWidth", 1280, 7680),
            maxHeight: intParam(params, "maxHeight", 800, 4320),
            quality: intParam(params, "quality", DEFAULT_QUALITY, 100),
          })
          .pipe(
            Effect.map(Option.some),
            Effect.catchTag("ServerBrowserTabNotFoundError", () => Effect.succeedNone),
          );
        const incoming = NodeHttpServerRequest.toIncomingMessage(request);
        // JPEGs are already compressed. Disabling deflate also keeps all
        // pending writes in the socket buffer we bound below, not a zlib queue.
        delete incoming.headers["sec-websocket-extensions"];
        const transport = incoming.socket;
        const socket = yield* request.upgrade;
        // The reader performs the upgrade; writes wait for it.
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        // A refused upgrade reads as an auth failure to ticket clients, so a
        // missing tab is a close code they stop on.
        const gone = writer.write(new Socket.CloseEvent(TAB_GONE_CODE, "tab closed"));
        if (Option.isNone(attached)) {
          yield* gone;
          return HttpServerResponse.empty();
        }
        const viewer = attached.value;
        // `write` returns once the frame is queued, so Chromium's ack for each
        // frame waits for the viewer's `ack` message instead.
        const unacknowledged: Array<Effect.Effect<void>> = [];
        const disconnectSlowViewer = Effect.sync(() => transport.destroy()).pipe(
          Effect.andThen(Effect.interrupt),
        );
        const write = (data: Uint8Array | string) =>
          Effect.suspend(() => {
            const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
            // Include the WebSocket frame header in the budget.
            if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
              return disconnectSlowViewer;
            }
            return writer.write(data);
          });
        const sendOutput = Queue.take(viewer.output).pipe(
          Effect.flatMap((output) => {
            switch (output._tag) {
              case "frame":
                if (unacknowledged.length >= MAX_UNACKNOWLEDGED_FRAMES) {
                  return disconnectSlowViewer;
                }
                return write(output.data).pipe(
                  Effect.andThen(Effect.sync(() => unacknowledged.push(output.ack))),
                );
              case "viewport":
                return write(
                  JSON.stringify({ type: "viewport", width: output.width, height: output.height }),
                );
              case "probe":
                return write(
                  JSON.stringify({
                    type: "probe",
                    x: output.x,
                    y: output.y,
                    editable: output.editable,
                  }),
                );
              case "gone":
                return gone.pipe(Effect.andThen(Effect.interrupt));
            }
          }),
        );
        const receive = (chunk: Uint8Array | string) => {
          const message = parseMessage(chunk);
          if (!isAck(message)) return viewer.input(message);
          const ack = unacknowledged.shift();
          // Forked: Chromium acks are paced and must not hold up input.
          return ack ? Effect.forkScoped(ack).pipe(Effect.asVoid) : Effect.void;
        };
        const receiveInput = reader.pull.pipe(
          Effect.flatMap((chunks) => Effect.forEach(chunks, receive, { discard: true })),
        );
        // Whichever side ends first closes the other through scope teardown.
        return yield* Effect.raceFirst(Effect.forever(sendOutput), Effect.forever(receiveInput));
      }),
    ).pipe(
      Effect.catchTag("ServerBrowserLaunchError", (error) =>
        Effect.logWarning("server preview browser failed to start", { cause: error.cause }).pipe(
          Effect.as(HttpServerResponse.text("Service Unavailable", { status: 503 })),
        ),
      ),
      // A dropped socket is a normal end of viewing.
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty())),
    );
  });

// Route handlers only see request-scoped services, so the browser is captured
// when the route is registered.
export const routeLayer = HttpRouter.use((router) =>
  Effect.flatMap(ServerBrowser.ServerBrowser, (browser) =>
    router.add("GET", `${PREVIEW_STREAM_ROUTE_PREFIX}/*`, makeHandler(browser)),
  ),
);
