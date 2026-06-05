import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = typeof out === "string" ? out : (out as { url: string }).url;
    expect(url).toBeString();
  }),
);

test(
  "echoes env.API_KEY",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = typeof out === "string" ? out : (out as { url: string }).url;

    const response = yield* HttpClient.get(`${url}/api-key`);
    expect(response.status).toBe(200);
    const body = yield* response.text;
    expect(body).toBe("SOME_API_KEY");
  }),
);

/**
 * Native (async) queue handler round-trip. The async worker exports
 * a plain `queue(batch, env)` handler that writes each message body
 * to R2 at `/queue/<id>`. POST /queue/send enqueues a message;
 * GET /<path> reads from R2, so we read /queue/<id> back.
 *
 * Pairs with the cloudflare-worker example, which exercises the
 * Effect-style `Cloudflare.messages(Queue).subscribe(...)` path
 * against the same producer/consumer round-trip.
 */
test(
  "native queue() handler round-trip",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = typeof out === "string" ? out : (out as { url: string }).url;
    const text = `hello-${Date.now()}`;

    const sendResponse = yield* HttpClient.execute(
      HttpClientRequest.post(
        `${url}/queue/send?text=${encodeURIComponent(text)}`,
      ),
    );
    expect(sendResponse.status).toBe(202);
    const { sent } = (yield* sendResponse.json) as {
      sent: { id: string; text: string; sentAt: number };
    };
    expect(sent.id).toBeTypeOf("string");

    const deadline = Date.now() + 60_000;
    let consumed: { id: string; text: string; sentAt: number } | undefined;
    while (Date.now() < deadline) {
      const resultResponse = yield* HttpClient.get(`${url}/queue/${sent.id}`);
      if (resultResponse.status === 200) {
        const body = yield* resultResponse.text;
        if (body) {
          consumed = JSON.parse(body);
          break;
        }
      }
      yield* Effect.sleep("2 seconds");
    }

    expect(consumed).toBeDefined();
    expect(consumed!.id).toBe(sent.id);
    expect(consumed!.text).toBe(text);
  }),
  { timeout: 120_000 },
);
