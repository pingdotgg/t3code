import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as Metrics from "../observability/Metrics.ts";
import { makeRelayDeliveryVerifier } from "./relayDeliveryProof.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

/** Largest request body a webhook accepts. The relay enforces the same cap. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/** Response header naming what happened to the request; the relay records it. */
const WEBHOOK_OUTCOME_HEADER = "x-t3-hook-outcome";

const json = (status: number, body: Record<string, string>, outcome: string) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { [WEBHOOK_OUTCOME_HEADER]: outcome } });

/**
 * Handles `/api/hooks/:hookId/:token` for every accepted method. The endpoint
 * is raw so the signature is checked over the exact body bytes; the service
 * checks the token and signature. It is reachable directly, over the managed
 * tunnel, or through the relay's stable `/v1/hooks/:endpointKey/:hookId/:token`
 * URL, where the endpoint key is this environment's managed tunnel key.
 */
const handleWebhook =
  (
    scheduledTasks: ScheduledTaskService.ScheduledTaskService["Service"],
    verifyRelayDelivery: Effect.Success<typeof makeRelayDeliveryVerifier>,
  ) =>
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
        return json(413, { error: "body_too_large" }, "body_too_large");
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
      // Refused before a task is looked up, so the service never sees them.
      const tooLarge = (error: string) =>
        Metrics.increment(Metrics.webhookDeliveriesTotal, {
          outcome: "body_too_large",
          source: request.headers["x-t3-relay-delivery-id"] ? "relay" : "direct",
        }).pipe(Effect.as(json(413, { error }, "body_too_large")));
      if (Option.isNone(body)) return yield* tooLarge("body_too_large_or_unreadable");
      if (body.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
        return yield* tooLarge("body_too_large");
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[name.toLowerCase()] = value;
      }
      const queryIndex = request.url.indexOf("?");
      // The relay's delivery id and receive time count only with its signed
      // proof; the URL can also be called directly. The receive time matters
      // for requests the relay held while we were offline.
      const relay = yield* verifyRelayDelivery({ headers, hookId: params.hookId });
      const relayDeliveryId = Option.isSome(relay) ? relay.value.deliveryId : undefined;
      const relayReceivedAt = Option.isSome(relay) ? relay.value.receivedAt : undefined;

      // A relay delivery joins the relay's trace, and goes to the T3 Connect
      // tracer with it. Anyone else's traceparent is never trusted.
      const relayParent = Option.isSome(relay)
        ? HttpTraceContext.fromHeaders(request.headers)
        : Option.none<Tracer.ExternalSpan>();
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
          ...(relayDeliveryId ? { relayDeliveryId } : {}),
          ...(relayReceivedAt ? { receivedAt: relayReceivedAt } : {}),
        })
        .pipe(
          Option.isSome(relayParent)
            ? (effect) =>
                effect.pipe(Effect.withParentSpan(relayParent.value), withRelayClientTracing)
            : (effect) => effect,
          // Defects too, so the sender only ever sees the fixed error body.
          Effect.catchCause((cause) =>
            Effect.logWarning("Webhook delivery failed").pipe(
              Effect.annotateLogs({ hookId: params.hookId }),
              Effect.andThen(Effect.logDebug("Webhook delivery failure cause", { cause })),
              Effect.as({ _tag: "error" as const }),
            ),
          ),
        );

      switch (result._tag) {
        case "accepted":
          return json(202, { deliveryId: result.deliveryId }, result.outcome);
        case "not_found":
          return json(404, { error: "hook_not_found" }, "not_found");
        case "rejected_signature":
          return json(401, { error: "invalid_signature" }, "rejected_signature");
        case "disabled":
          return json(409, { error: "hook_disabled" }, "disabled");
        case "rate_limited":
          return json(429, { error: "rate_limited" }, result.outcome);
        case "expired":
          return json(410, { error: "delivery_too_old" }, "expired");
        case "error":
          return json(500, { error: "internal_error" }, "error");
      }
    });

export const webhookHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webhooks",
  Effect.fnUntraced(function* (handlers) {
    const handler = handleWebhook(
      yield* ScheduledTaskService.ScheduledTaskService,
      yield* makeRelayDeliveryVerifier,
    );
    return handlers
      .handleRaw("webhookPost", handler)
      .handleRaw("webhookPut", handler)
      .handleRaw("webhookPatch", handler)
      .handleRaw("webhookGet", handler);
  }),
);
