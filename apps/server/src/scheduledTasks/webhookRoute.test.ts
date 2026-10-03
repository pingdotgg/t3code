import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

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
import { WEBHOOK_MAX_BODY_BYTES, webhookHttpApiLayer } from "./webhookRoute.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(webhookHttpApiLayer),
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
  it("passes the raw request to the service and answers 202 with the delivery id", async () => {
    let received: WebhookTriggerRequest | undefined;
    const { handler, dispose } = handlerFor((request) => {
      received = request;
      return Effect.succeed({
        _tag: "accepted",
        deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
      });
    });
    try {
      const response = await handler(
        post("/api/hooks/scheduled-task%3Ahook/tok?x=1", '{"a":1}', {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
        }),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ deliveryId: "delivery:1" });
      expect(received?.hookId).toBe("scheduled-task:hook");
      expect(received?.token).toBe("tok");
      expect(received?.query).toBe("x=1");
      expect(received?.headers["x-github-event"]).toBe("push");
      expect(received?.bodyText).toBe('{"a":1}');
    } finally {
      await dispose();
    }
  });

  it("maps service outcomes to status codes", async () => {
    const cases: ReadonlyArray<[WebhookTriggerResult["_tag"], number]> = [
      ["not_found", 404],
      ["rejected_signature", 401],
      ["disabled", 409],
      ["rate_limited", 429],
    ];
    for (const [tag, status] of cases) {
      const { handler, dispose } = handlerFor(() =>
        Effect.succeed({ _tag: tag } as WebhookTriggerResult),
      );
      try {
        expect((await handler(post("/api/hooks/id/tok", "{}"))).status).toBe(status);
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
      // No content-length: the reader cap must still apply.
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

  it("hides service failures behind a 500", async () => {
    const { handler, dispose } = handlerFor(() =>
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
    );
    try {
      const response = await handler(post("/api/hooks/id/tok", "{}"));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("database");
    } finally {
      await dispose();
    }
  });
});
