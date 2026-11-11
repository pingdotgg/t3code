import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  EnvironmentHttpApi,
  ScheduledTaskWebhookDeliveryId,
  ScheduledTaskError,
} from "@t3tools/contracts";
import {
  ScheduledTaskService,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "./ScheduledTaskService.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhookRoute.ts";
import * as WebhookRoute from "./webhookRoute.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(Layer.mock(ScheduledTaskService)({ triggerWebhook: trigger })),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
    { disableLogger: true },
  );

const post = (
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request(`http://env.local${path}`, { method: "POST", body, headers });

describe("webhook route", () => {
  it("answers 400 for an invalid idempotency key and passes a valid one through", async () => {
    let received: WebhookTriggerRequest | undefined;
    const { handler, dispose } = handlerFor((request) => {
      received = request;
      return Effect.succeed(
        request.headers["idempotency-key"] === "bad key"
          ? { _tag: "invalid_idempotency_key" }
          : {
              _tag: "accepted",
              deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:key:1"),
              outcome: "duplicate",
            },
      );
    });
    try {
      const invalid = await handler(
        post("/api/hooks/id/tok", "{}", { "Idempotency-Key": "bad key" }),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "invalid_idempotency_key" });
      expect(invalid.headers.get("x-t3-hook-outcome")).toBe("invalid_idempotency_key");

      const valid = await handler(post("/api/hooks/id/tok", "{}", { "Idempotency-Key": "k-1" }));
      expect(valid.status).toBe(202);
      expect(valid.headers.get("x-t3-hook-outcome")).toBe("duplicate");
      expect(received?.headers["idempotency-key"]).toBe("k-1");
    } finally {
      await dispose();
    }
  });

  it("maps service outcomes to status codes and names each outcome", async () => {
    const deliveryId = ScheduledTaskWebhookDeliveryId.make("delivery:1");
    const cases: ReadonlyArray<[WebhookTriggerResult, number, string]> = [
      [{ _tag: "accepted", deliveryId, outcome: "accepted" }, 202, "accepted"],
      [{ _tag: "accepted", deliveryId, outcome: "duplicate" }, 202, "duplicate"],
      [{ _tag: "accepted", deliveryId, outcome: "prompt_too_long" }, 202, "prompt_too_long"],
      [{ _tag: "accepted", deliveryId, outcome: "filtered" }, 202, "filtered"],
      [{ _tag: "not_found" }, 404, "not_found"],
      [{ _tag: "rejected_signature" }, 401, "rejected_signature"],
      [{ _tag: "disabled" }, 409, "disabled"],
      [{ _tag: "blocked_by_policy" }, 403, "blocked_by_policy"],
      [{ _tag: "rate_limited", outcome: "rate_limited" }, 429, "rate_limited"],
      [{ _tag: "rate_limited", outcome: "queue_full" }, 429, "queue_full"],
    ];
    for (const [result, status, outcome] of cases) {
      const { handler, dispose } = handlerFor(() => Effect.succeed(result));
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(status);
        expect(response.headers.get("x-t3-hook-outcome")).toBe(outcome);
        if (status === 429) expect(await response.json()).toEqual({ error: outcome });
      } finally {
        await dispose();
      }
    }
  });

  it("rejects oversized bodies and malformed paths before reaching the service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
      expect((await handler(post("/api/hooks/id/tok", big))).status).toBe(413);
      expect((await handler(post("/api/hooks/id", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/id/tok/extra", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/%E0/tok", "{}"))).status).toBe(404);
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      const streamed = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          method: "POST",
          body: chunked,
          // Node's fetch needs duplex for streamed bodies.
          duplex: "half",
        }),
      );
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("refuses HEAD probes without triggering the hook", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({
        _tag: "accepted",
        deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
        outcome: "accepted",
      });
    });
    try {
      const response = await handler(
        new Request("http://env.local/api/hooks/id/tok", { method: "HEAD" }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST, PUT, PATCH");
      expect(response.headers.get("x-t3-hook-outcome")).toBe("method_not_allowed");
      expect(calls).toBe(0);
      const get = await handler(new Request("http://env.local/api/hooks/id/tok"));
      expect(get.status).toBe(202);
      expect(calls).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("hides service failures and defects behind a fixed 500", async () => {
    const failures = [
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
      Effect.die(new Error("database exploded")),
    ];
    for (const failure of failures) {
      const { handler, dispose } = handlerFor(() => failure);
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
      } finally {
        await dispose();
      }
    }
  });
});
