import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ScheduledTaskService from "./ScheduledTaskService.ts";

/** Largest request body a webhook accepts. The relay enforces the same cap. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const json = (status: number, body: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, { status });

/**
 * Handles `/api/hooks/:hookId/:token` for every accepted method. The endpoint
 * is raw so the signature is checked over the exact body bytes; the service
 * checks the token and signature. It is reachable directly, over the managed
 * tunnel, or through the relay's stable `/v1/hooks/...` URL.
 */
const handleWebhook =
  (scheduledTasks: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  ({
    params,
    request,
  }: {
    readonly params: { readonly hookId: string; readonly token: string };
    readonly request: HttpServerRequest.HttpServerRequest;
  }) =>
    Effect.gen(function* () {
      const contentLength = Number(request.headers["content-length"] ?? "0");
      if (!Number.isFinite(contentLength) || contentLength > WEBHOOK_MAX_BODY_BYTES) {
        return json(413, { error: "body_too_large" });
      }
      // Chunked requests carry no content-length, so the reader itself is capped.
      const body = yield* request.arrayBuffer.pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.provideService(
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(WEBHOOK_MAX_BODY_BYTES),
        ),
        Effect.option,
      );
      if (Option.isNone(body)) return json(413, { error: "body_too_large_or_unreadable" });
      if (body.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
        return json(413, { error: "body_too_large" });
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name.toLowerCase()] = value;
      }
      const queryIndex = request.url.indexOf("?");

      const result = yield* scheduledTasks
        .triggerWebhook({
          hookId: params.hookId,
          token: params.token,
          method: request.method,
          path: `${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(params.hookId)}`,
          query: queryIndex === -1 ? "" : request.url.slice(queryIndex + 1),
          headers,
          body: body.value,
          bodyText: new TextDecoder().decode(body.value),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Webhook delivery failed").pipe(
              Effect.annotateLogs({ hookId: params.hookId }),
              Effect.andThen(Effect.logDebug("Webhook delivery failure cause", { cause })),
              Effect.as({ _tag: "error" as const }),
            ),
          ),
        );

      switch (result._tag) {
        case "accepted":
          return json(202, { deliveryId: result.deliveryId });
        case "not_found":
          return json(404, { error: "hook_not_found" });
        case "rejected_signature":
          return json(401, { error: "invalid_signature" });
        case "disabled":
          return json(409, { error: "hook_disabled" });
        case "rate_limited":
          return json(429, { error: "rate_limited" });
        case "error":
          return json(500, { error: "internal_error" });
      }
    });

export const webhookHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webhooks",
  Effect.fnUntraced(function* (handlers) {
    const handler = handleWebhook(yield* ScheduledTaskService.ScheduledTaskService);
    return handlers
      .handleRaw("webhookPost", handler)
      .handleRaw("webhookPut", handler)
      .handleRaw("webhookPatch", handler)
      .handleRaw("webhookGet", handler);
  }),
);
