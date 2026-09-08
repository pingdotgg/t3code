import { PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ENGINE_FRAMES_ROUTE_PREFIX, PlaywrightPreviewHost } from "../mcp/PlaywrightPreviewHost.ts";

const BOUNDARY = "t3frame";
const decodeTabId = Schema.decodeUnknownOption(PreviewTabId);
const encoder = new TextEncoder();
// The boundary follows each frame so Chromium draws it as soon as it arrives.
const preamble = encoder.encode(`--${BOUNDARY}\r\n`);
const framePart = (frame: Uint8Array) => {
  const header = encoder.encode(
    `Content-Type: image/jpeg\r\nContent-Length: ${frame.byteLength}\r\n\r\n`,
  );
  const part = new Uint8Array(header.byteLength + frame.byteLength + preamble.byteLength + 2);
  part.set(header, 0);
  part.set(frame, header.byteLength);
  part.set(encoder.encode("\r\n"), header.byteLength + frame.byteLength);
  part.set(preamble, header.byteLength + frame.byteLength + 2);
  return part;
};

/** Streams an engine page as MJPEG. The tab secret in the path is the only credential. */
export const engineFramesRouteLayer = Layer.unwrap(
  Effect.map(PlaywrightPreviewHost, (host) =>
    HttpRouter.add(
      "GET",
      `${ENGINE_FRAMES_ROUTE_PREFIX}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
        const [rawTabId, secret, ...rest] = url.value.pathname
          .slice(`${ENGINE_FRAMES_ROUTE_PREFIX}/`.length)
          .split("/");
        const tabId = decodeTabId(rawTabId);
        if (Option.isNone(tabId) || secret === undefined || rest.length > 0) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const frames = host.frames(tabId.value, secret);
        if (frames === undefined) return HttpServerResponse.text("Not Found", { status: 404 });
        return HttpServerResponse.stream(
          Stream.concat(Stream.make(preamble), Stream.map(frames, framePart)),
          {
            headers: {
              "content-type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
              "cache-control": "no-store",
            },
          },
        );
      }),
    ),
  ),
);
