import { AuthOrchestrationReadScope, type PrinterId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { authenticateMediaRequest } from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import type { PrinterMediaAssetKind } from "./PrinterAdapter.ts";
import * as PrinterService from "./PrinterService.ts";

const MEDIA_ROUTE_PATTERN = /^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/(camera|cover|pick)$/;

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method !== "GET") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const url = requestUrl(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const subPath = url.value.pathname.slice(PrinterService.PRINTER_MEDIA_ROUTE_PREFIX.length);
  const match = subPath.match(MEDIA_ROUTE_PATTERN);
  if (!match) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  // Explicitly require an authenticated environment session with read scope (never guest/public).
  yield* authenticateMediaRequest(AuthOrchestrationReadScope);

  const printerId = match[1]! as PrinterId;
  const assetKind = match[2]! as PrinterMediaAssetKind;
  const printers = yield* PrinterService.PrinterService;

  const asset = yield* Effect.option(printers.fetchMedia(printerId, assetKind));
  if (Option.isNone(asset)) {
    return HttpServerResponse.text("Printer media unavailable", { status: 503 });
  }

  return HttpServerResponse.uint8Array(asset.value.bytes, {
    contentType: asset.value.contentType,
    headers: {
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "x-printer-captured-at": asset.value.capturedAt,
      "x-printer-frame-stale": asset.value.stale ? "true" : "false",
      "x-printer-online": asset.value.online ? "true" : "false",
    },
  });
});

export const layer = HttpRouter.add(
  "GET",
  `${PrinterService.PRINTER_MEDIA_ROUTE_PREFIX}/*`,
  handler,
);
