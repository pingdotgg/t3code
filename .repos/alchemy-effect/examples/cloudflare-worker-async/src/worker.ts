import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

/**
 * Type of messages we send on the queue — kept minimal so the example stays
 * self-contained. Both producer (`env.Queue.send(...)`) and consumer (the
 * `queue()` handler below) use this shape.
 */
interface QueueMessage {
  id: string;
  text: string;
  sentAt: number;
}

export default {
  async fetch(request: Request, env: WorkerEnv) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Echo back env.API_KEY so the integ test can verify the env round-trip.
    if (request.method === "GET" && path === "/api-key") {
      return new Response(env.API_KEY, {
        headers: { "content-type": "text/plain" },
      });
    }

    // Queue producer — POST /queue/send?text=...
    //
    // Exercises Cloudflare.QueueBinding by calling `env.Queue.send(...)`.
    // The message is persisted by the consumer handler into R2 at /queue/<id>
    // so the integ test can read it back and assert the full round-trip.
    if (request.method === "POST" && path === "/queue/send") {
      const text = url.searchParams.get("text") ?? "hello queue";
      const msg: QueueMessage = {
        id: crypto.randomUUID(),
        text,
        sentAt: Date.now(),
      };
      await env.Queue.send(msg);
      return new Response(JSON.stringify({ sent: msg }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "GET") {
      return new Response((await env.Bucket.get(path))?.body ?? null);
    } else if (request.method === "PUT") {
      const object = (await env.Bucket.put(path, request.body))!;
      return new Response(
        JSON.stringify({
          key: object.key,
          size: object.size,
        }),
        { status: 201 },
      );
    } else if (request.method === "POST") {
      const counter = env.Counter.getByName("counter");
      return new Response(JSON.stringify({ count: await counter.increment() }));
    }
    return env.ASSETS.fetch(request);
  },

  /**
   * Queue consumer handler — invoked by Cloudflare when messages accumulate
   * on the Queue registered as a QueueConsumer for this worker.
   *
   * Persists each message body into R2 under `/queue/<id>` so the integ test
   * (or a manual `GET /queue/<id>`) can verify the round-trip succeeded.
   * `msg.ack()` marks the message as consumed so it isn't redelivered.
   */
  async queue(batch: MessageBatch<QueueMessage>, env: WorkerEnv) {
    for (const msg of batch.messages) {
      await env.Bucket.put(`/queue/${msg.body.id}`, JSON.stringify(msg.body), {
        httpMetadata: { contentType: "application/json" },
      });
      msg.ack();
    }
  },
};

export class Counter extends DurableObject {
  private counter = 0;

  async increment() {
    return ++this.counter;
  }
}
