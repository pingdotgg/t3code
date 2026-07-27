import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

// A fresh workers.dev URL transiently 404s/5xxs while the edge converges.
// `Test.getWhenReady` / `Test.executeWhenReady` retry through that window and
// return the first non-cold-start response to assert on.
const { getWhenReady, executeWhenReady } = Test;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
);

test(
  "echoes env.API_KEY",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const response = yield* getWhenReady(`${url}/api-key`);
    expect(response.status).toBe(200);
    const body = yield* response.text;
    expect(body).toBe("SOME_API_KEY");
  }),
  // `getWhenReady` rides out the edge cold-start window with exponential
  // backoff (up to 20 attempts), which routinely exceeds bun's default 5s
  // test timeout on a fresh workers.dev URL. Match the other HTTP cases.
  { timeout: 120_000 },
);

/**
 * Native (async) queue handler round-trip. The async worker exports
 * a plain `queue(batch, env)` handler that writes each message body
 * to R2 at `/queue/<id>`. POST /queue/send enqueues a message;
 * GET /<path> reads from R2, so we read /queue/<id> back.
 *
 * Pairs with the cloudflare-worker example, which exercises the
 * Effect-style `Cloudflare.Queues.consumeQueueMessages(Queue, handler)` path
 * against the same producer/consumer round-trip.
 */
test(
  "native queue() handler round-trip",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const text = `hello-${Date.now()}`;
    type Message = { id: string; text: string; sentAt: number };

    const send = Effect.gen(function* () {
      const sendResponse = yield* executeWhenReady(
        HttpClientRequest.post(
          `${url}/queue/send?text=${encodeURIComponent(text)}`,
        ),
      );
      expect(sendResponse.status).toBe(202);
      const { sent } = (yield* sendResponse.json) as { sent: Message };
      expect(sent.id).toBeTypeOf("string");
      return sent;
    });

    const sent: Message[] = [yield* send];

    // First delivery on a freshly created queue+consumer can lag well past
    // the settled steady state (consumer attachment propagates through
    // Cloudflare's queue subsystem asynchronously). Poll for ANY of the
    // messages we sent, re-sending every ~20s in case an early message was
    // published into the propagation window; the consumer persists each
    // message to R2 keyed by its id, so the first one to land wins.
    let polls = 0;
    const findConsumed = Effect.gen(function* () {
      polls++;
      if (polls % 10 === 0 && sent.length < 5) {
        sent.push(yield* send);
      }
      for (const message of sent) {
        const resultResponse = yield* HttpClient.get(
          `${url}/queue/${message.id}`,
        );
        if (resultResponse.status === 200) {
          const body = yield* resultResponse.text;
          if (body) return JSON.parse(body) as Message;
        }
      }
      return undefined;
    });

    const consumed = yield* findConsumed.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (message) => message !== undefined,
        times: 75,
      }),
    );

    expect(consumed).toBeDefined();
    expect(sent.map((message) => message.id)).toContain(consumed!.id);
    expect(consumed!.text).toBe(text);
  }),
  { timeout: 180_000 },
);
