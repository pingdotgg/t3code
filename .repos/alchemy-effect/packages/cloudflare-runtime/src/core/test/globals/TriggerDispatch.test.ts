/**
 * Regression tests for non-fetch event dispatch through the entry middleware
 * when downstream fetch middlewares are present.
 *
 * The `images` and `stream` bindings register entry-chain middlewares
 * (`images:delivery`, `stream:router`) at `order: 1` — *after* the entry
 * middleware — so the entry's `USER_WORKER` upstream binding points at a
 * fetch-only middleware instead of the raw user worker. The entry's JSRPC
 * dispatch for non-fetch events (`.queue(...)`, `.scheduled(...)`,
 * `.email(...)`) then failed with `TypeError: The RPC receiver does not
 * implement the method "email"` (a 500 on the trigger routes).
 *
 * The fix routes non-fetch dispatch through a direct binding to
 * `SERVICE_USER_WORKER` (`BINDING_USER_WORKER_DIRECT`), bypassing fetch
 * middlewares entirely — mirroring Miniflare's RPCProxyWorker, whose `fetch`
 * traverses the router chain while every other RPC method forwards straight
 * to the user worker. These tests pin that topology: one worker per
 * middleware type, with the trigger routes exercised against it, plus a check
 * that the middleware's own fetch route still intercepts.
 */
import { expect, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Images from "../../bindings/images/index.ts";
import * as Stream from "../../bindings/stream/index.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

// Records every non-fetch event into module-global arrays, read back via
// fetch routes. The fetch handler also proves regular requests still flow
// through the middleware chain to the user worker.
const EVENTS_SCRIPT = `
const fires = (globalThis.__fires ??= []);
const received = (globalThis.__received ??= []);
const batches = (globalThis.__batches ??= []);
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fires") return Response.json(fires);
    if (url.pathname === "/received") return Response.json(received);
    if (url.pathname === "/batches") return Response.json(batches);
    return new Response("fetch-ok");
  },
  async scheduled(controller) {
    fires.push({ cron: controller.cron, scheduledTime: controller.scheduledTime });
  },
  async email(message) {
    received.push({ from: message.from, to: message.to });
  },
  async queue(batch) {
    batches.push({
      queue: batch.queue,
      messages: batch.messages.map((message) => ({ id: message.id, body: message.body })),
    });
    batch.ackAll();
  },
};
`;

const VALID_EMAIL = [
  "From: someone <someone@example.com>",
  "To: someone else <someone-else@example.com>",
  "Message-ID: <trigger-dispatch-test@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain",
  "",
  "This is a random email body.",
].join("\n");

const EMAIL_PATH = `/cdn-cgi/handler/email?${new URLSearchParams({
  from: "someone@example.com",
  to: "someone-else@example.com",
}).toString()}`;

interface Fire {
  cron: string;
  scheduledTime: number;
}

interface ReceivedEmail {
  from: string;
  to: string;
}

interface RecordedBatch {
  queue: string;
  messages: Array<{ id: string; body: unknown }>;
}

/** Every trigger route against one worker; the fix is topology-level, so the
 * same coverage applies regardless of which middleware sits downstream. */
const testTriggerRoutes = (worker: TestWorker) =>
  Effect.gen(function* () {
    // scheduled()
    const scheduledResponse = yield* worker.fetch(
      "/cdn-cgi/handler/scheduled?cron=trigger-test&time=1000",
      { method: "POST" },
    );
    expect(scheduledResponse.status).toBe(200);
    expect(yield* Effect.promise(() => scheduledResponse.text())).toBe("ok");
    const fires = yield* worker.fetchJson<Array<Fire>>("/fires");
    expect(fires).toContainEqual({ cron: "trigger-test", scheduledTime: 1000 });

    // email()
    const emailResponse = yield* worker.fetch(EMAIL_PATH, {
      method: "POST",
      body: VALID_EMAIL,
    });
    expect(yield* Effect.promise(() => emailResponse.text())).toBe(
      "Worker successfully processed email",
    );
    expect(emailResponse.status).toBe(200);
    const received = yield* worker.fetchJson<Array<ReceivedEmail>>("/received");
    expect(received).toContainEqual({
      from: "someone@example.com",
      to: "someone-else@example.com",
    });

    // queue()
    const queueResponse = yield* worker.fetch("/cdn-cgi/handler/queue", {
      method: "POST",
      body: JSON.stringify({
        queue: "trigger-test-queue",
        messages: [
          { id: "message-1", timestamp: 1000, attempts: 1, body: "hello" },
        ],
      }),
    });
    expect(queueResponse.status).toBe(200);
    const batches = yield* worker.fetchJson<Array<RecordedBatch>>("/batches");
    expect(batches).toContainEqual({
      queue: "trigger-test-queue",
      messages: [{ id: "message-1", body: "hello" }],
    });

    // Regular fetch still flows through the middleware chain to the user
    // worker.
    expect(yield* worker.fetchText("/anything")).toBe("fetch-ok");
  });

class ImagesEventsWorker extends Context.Service<
  ImagesEventsWorker,
  TestWorker
>()("test/ImagesEventsWorker") {}

class StreamEventsWorker extends Context.Service<
  StreamEventsWorker,
  TestWorker
>()("test/StreamEventsWorker") {}

const EventsWorkersLive = Layer.mergeAll(
  Layer.effect(
    ImagesEventsWorker,
    startTestWorker({
      name: "trigger-dispatch-images",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      modules: [{ name: "main.js", type: "ESModule", content: EVENTS_SCRIPT }],
      bindings: [Images.local({ binding: "IMAGES" })],
    }),
  ),
  Layer.effect(
    StreamEventsWorker,
    startTestWorker({
      name: "trigger-dispatch-stream",
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      modules: [{ name: "main.js", type: "ESModule", content: EVENTS_SCRIPT }],
      bindings: [Stream.local({ binding: "STREAM" })],
    }),
  ),
);

layer(EventsWorkersLive.pipe(Layer.provideMerge(localRuntimeLayer)), {
  excludeTestServices: true,
})("non-fetch dispatch past fetch middlewares", (it) => {
  it.effect("images binding: trigger routes reach the user worker", () =>
    Effect.gen(function* () {
      const worker = yield* ImagesEventsWorker;
      yield* testTriggerRoutes(worker);
      // The images delivery middleware still intercepts its own path (the
      // user worker would answer "fetch-ok" with a 200).
      const delivery = yield* worker.fetch(
        "/cdn-cgi/mf/imagedelivery/does-not-exist/public",
      );
      expect(delivery.status).toBe(404);
      yield* Effect.promise(() => delivery.arrayBuffer());
    }),
  );

  it.effect("stream binding: trigger routes reach the user worker", () =>
    Effect.gen(function* () {
      const worker = yield* StreamEventsWorker;
      yield* testTriggerRoutes(worker);
    }),
  );
});
