import { PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ENGINE_FRAMES_ROUTE_PREFIX, PlaywrightPreviewHost } from "../mcp/PlaywrightPreviewHost.ts";

const decodeTabId = Schema.decodeUnknownOption(PreviewTabId);

/** Big-endian byte length, then the PNG or JPEG bytes. */
const framePart = (frame: Uint8Array) => {
  const part = new Uint8Array(4 + frame.byteLength);
  new DataView(part.buffer).setUint32(0, frame.byteLength);
  part.set(frame, 4);
  return part;
};

/** Streams engine page frames as length-prefixed images. The tab secret in the path is the only credential. */
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
        return HttpServerResponse.stream(Stream.map(frames, framePart), {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
        });
      }),
    ),
  ),
);
