import * as Queue from "../../core/bindings/queue/Queue.ts";
import cloudflareVitePlugin from "../plugin.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vite from "vite";
import { afterEach, describe, expect, test } from "vitest";

/**
 * A Worker that both produces to and consumes from one queue.
 *
 * `POST /send` enqueues a message. `GET /received` reports what the `queue()`
 * handler has seen. The handler accumulates on `globalThis` — the dev server
 * runs one Worker instance, so the producer request, the delivery and the
 * readback all share an isolate.
 */
const workerSource = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      await env.QUEUE.send({ id: url.searchParams.get("id") });
      return new Response("sent");
    }
    return Response.json(globalThis.__received ?? []);
  },

  async queue(batch) {
    globalThis.__received ??= [];
    for (const message of batch.messages) {
      globalThis.__received.push(message.body.id);
      message.ack();
    }
  },
};
`;

const QUEUE_NAME = "vite-plugin-queue-consumer-test";

/** Under `.cache` so a crashed run cannot leave untracked files behind. */
const TMP_ROOT = path.resolve(import.meta.dirname, "../.cache/test-roots");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function startDevServer() {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(TMP_ROOT, "queue-consumer-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));

  const entry = path.join(root, "worker.js");
  await fs.writeFile(entry, workerSource);

  const server = await vite.createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [
      cloudflareVitePlugin({
        main: entry,
        compatibilityDate: "2026-03-10",
        worker: {
          name: "vite-plugin-queue-consumer-test",
          bindings: [Queue.local({ binding: "QUEUE", queueName: QUEUE_NAME })],
          // The worker consumes the same queue it produces to, so the producer
          // binding must resolve to a local broker rather than the dev-registry
          // proxy. That only happens if this option reaches `runtime.start`.
          queueConsumers: [
            { queueName: QUEUE_NAME, maxBatchSize: 1, maxBatchTimeout: 0 },
          ],
        },
      }),
    ],
  });
  cleanups.push(() => server.close());
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (!url) {
    throw new Error("Dev server did not report a local URL");
  }

  return {
    send: (id: string) =>
      fetch(new URL(`/send?id=${id}`, url), {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      }),
    received: async (): Promise<Array<string>> => {
      const response = await fetch(new URL("/received", url), {
        signal: AbortSignal.timeout(10_000),
      });
      return (await response.json()) as Array<string>;
    },
  };
}

/** Delivery is asynchronous, so poll rather than assert on the first read. */
async function receivedEventually(
  received: () => Promise<Array<string>>,
  count: number,
): Promise<Array<string>> {
  const deadline = Date.now() + 30_000;
  let last = await received();
  while (last.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await received();
  }
  return last;
}

describe("queue consumers in dev", () => {
  /**
   * Regression test for a dropped option: `serve()` built its `runtime.start`
   * call by listing worker options one at a time and omitted `queueConsumers`.
   * The type allowed it, so callers passed it and it was silently discarded.
   *
   * The worker then started with no consumers, its producer binding resolved to
   * the dev-registry `ExternalQueueConsumer` instead of a local broker, and that
   * accepts-and-drops:
   *
   *   [registry] No consumer registered for queue "…". Accepting and dropping message.
   *
   * Two things failed, and this test covers both: `queue()` never ran, and
   * `send()` never settled — so the request hung rather than erroring.
   */
  test("delivers a message to the queue() handler of the worker that produced it", async () => {
    const { send, received } = await startDevServer();

    // `send()` not settling was half the fault, so await the producer request
    // rather than fire-and-forget. The AbortSignal turns a hang into a failure.
    const response = await send("first");
    expect(response.status).toBe(200);

    expect(await receivedEventually(received, 1)).toEqual(["first"]);
  });

  test("delivers every message when several are produced", async () => {
    const { send, received } = await startDevServer();

    await send("a");
    await send("b");
    await send("c");

    expect((await receivedEventually(received, 3)).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
