import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as TailnetDevices from "./TailnetDevices.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "tailnetDevices",
  Effect.fnUntraced(function* (handlers) {
    const devices = yield* TailnetDevices.TailnetDevices;
    return handlers
      .handle("request", ({ payload, request }) => devices.handleRequest(payload, request))
      .handle("join", ({ payload }) => devices.handleJoin(payload))
      .handle("confirm", ({ payload }) => devices.handleConfirm(payload))
      .handle("grant", ({ payload }) => devices.handleGrant(payload))
      .handle("sync", ({ payload, request }) => devices.handleSync(request, payload))
      .handle("clientCredential", ({ payload, request }) =>
        devices.handleClientCredential(request, payload),
      );
  }),
);
