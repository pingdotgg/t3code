import type { MessageBatchMetadata } from "@cloudflare/workers-types/experimental";
import { assert, expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "../../bindings/queue/Queue.ts";
import {
  localRuntimeLayer,
  poll,
  PredicateFailed,
  startTestWorker,
  waitForRegistryEntry,
  type TestWorker,
} from "../helpers/runtime.ts";

// Combined producer + consumer worker. The `queue()` handler records every
// delivered message into a module-global array, which the test reads back via
// `GET /received`. Messages whose body carries `failUntil` are retried while
// `attempts < failUntil`, letting tests drive retry / dead-letter behaviour.
const QUEUE_SCRIPT = `
delete Date.prototype.toJSON; // so JSON.stringify reaches the replacer for Date
const received = (globalThis.__received ??= []);
function replacer(_, value) {
  if (value instanceof ArrayBuffer) {
    return { $type: "ArrayBuffer", value: Array.from(new Uint8Array(value)) };
  }
  if (value instanceof Date) {
    return { $type: "Date", value: value.getTime() };
  }
  return value;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const { binding, body, options } = await request.json();
      try {
        await env[binding].send(body, options);
        return new Response(null, { status: 204 });
      } catch (e) {
        return Response.json({ error: e?.message ?? String(e) }, { status: 500 });
      }
    }
    if (url.pathname === "/sendBatch") {
      const { binding, messages, options } = await request.json();
      await env[binding].sendBatch(messages, options);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/sendTypes") {
      await env.QUEUE.send("msg-text", { contentType: "text" });
      await env.QUEUE.send([{ message: "msg-json" }], { contentType: "json" });
      await env.QUEUE.send(new Uint8Array([0, 1, 2, 3]), { contentType: "bytes" });
      await env.QUEUE.send(new Date(1600000000000), { contentType: "v8" });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/received") {
      return new Response(JSON.stringify(received, replacer), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      received.push({
        queue: batch.queue,
        id: message.id,
        attempts: message.attempts,
        body: message.body,
      });
      if (
        message.body &&
        typeof message.body === "object" &&
        typeof message.body.failUntil === "number" &&
        message.attempts < message.body.failUntil
      ) {
        message.retry();
      }
    }
  },
};
`;

// Records each delivered batch as an array of message bodies, so tests can
// assert batch boundaries (size / timeout / overflow splitting). Read back via
// `GET /batches`.
const BATCH_SCRIPT = `
const batches = (globalThis.__batches ??= []);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const { body } = await request.json();
      await env.QUEUE.send(body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/sendBatch") {
      const { messages } = await request.json();
      await env.QUEUE.sendBatch(messages);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/batches") {
      return Response.json(batches);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    batches.push(batch.messages.map((message) => message.body));
  },
};
`;

// Round-trips a broad set of structured-cloneable values through the queue
// (v8 content type). The consumer deep-compares each delivered value against
// the original and records the first failure, read back via `GET /result`.
const CLONE_SCRIPT = `
import assert from "node:assert";

const arrayBuffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
const cyclic = { a: 1 };
cyclic.b = cyclic;

const VALUES = {
  Object: { w: 1, x: 42n, y: true, z: "string" },
  Cyclic: cyclic,
  Array: [0, 1, [2, 3]],
  Date: new Date(1000),
  Map: new Map([["a", 1], ["b", 2], ["c", 3]]),
  Set: new Set(["a", "b", "c"]),
  RegExp: /ab?c/g,
  ArrayBuffer: arrayBuffer,
  DataView: new DataView(arrayBuffer, 2, 3),
  Int8Array: new Int8Array(arrayBuffer),
  Uint8Array: new Uint8Array(arrayBuffer, 1, 4),
  Uint8ClampedArray: new Uint8ClampedArray(arrayBuffer),
  Int16Array: new Int16Array(arrayBuffer),
  Uint16Array: new Uint16Array(arrayBuffer),
  Int32Array: new Int32Array(arrayBuffer),
  Uint32Array: new Uint32Array(arrayBuffer),
  Float32Array: new Float32Array(arrayBuffer),
  Float64Array: new Float64Array(arrayBuffer),
  BigInt64Array: new BigInt64Array(arrayBuffer),
  BigUint64Array: new BigUint64Array(arrayBuffer),
  Error: new Error("message", { cause: new Error("cause") }),
  EvalError: new EvalError("message"),
  RangeError: new RangeError("message"),
  ReferenceError: new ReferenceError("message"),
  SyntaxError: new SyntaxError("message"),
  TypeError: new TypeError("message"),
  URIError: new URIError("message"),
};
const EXTRA_CHECKS = {
  Cyclic(value) {
    assert(value.b === value, "Cyclic: cycle");
  },
  Error(value) {
    assert.deepStrictEqual(value.cause, VALUES.Error.cause, "Error: cause");
  },
};

let result = "pending";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      // Structured-clone types (BigInt, Map, Set, ...) require the v8 content
      // type; the default "json" format only supports JSON-serializable values.
      await env.QUEUE.sendBatch(
        Object.entries(VALUES).map(([key, value]) => ({
          body: { name: key, value },
          contentType: "v8",
        })),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/result") {
      return Response.json({ result });
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    try {
      for (const message of batch.messages) {
        const { name, value } = message.body;
        assert.deepStrictEqual(value, VALUES[name], name);
        EXTRA_CHECKS[name]?.(value);
      }
      result = "ok";
    } catch (e) {
      result = e?.stack ?? String(e);
    }
  },
};
`;

// Drives the three retry mechanisms from the message body: `batch.retryAll()`,
// throwing from the handler, or explicit `message.retry()`. Each delivery is
// recorded so tests can assert the attempt sequence, read via `GET /received`.
const RETRY_SCRIPT = `
const received = (globalThis.__received ??= []);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const { body } = await request.json();
      await env.QUEUE.send(body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/received") {
      return Response.json(received);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      received.push({ queue: batch.queue, id: message.id, attempts: message.attempts, body: message.body, at: Date.now() });
    }
    const body = batch.messages[0]?.body ?? {};
    const attempts = batch.messages[0]?.attempts ?? 1;
    if (attempts < (body.failUntil ?? 0)) {
      if (body.action === "retryAll") {
        batch.retryAll();
      } else if (body.action === "throw") {
        throw new Error("intentional failure");
      } else {
        for (const message of batch.messages) message.retry();
      }
    }
  },
};
`;

// Explicitly acks the message tagged "keep" and then retries the entire batch
// (while attempts < 2). An explicit ack must take precedence over retryAll, so
// "keep" should be delivered exactly once while "redo" is redelivered. Records
// each delivery, read back via \`GET /received\`.
const ACK_SCRIPT = `
const received = (globalThis.__received ??= []);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/sendBatch") {
      const { messages } = await request.json();
      await env.QUEUE.sendBatch(messages);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/received") {
      return Response.json(received);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      received.push({ id: message.id, tag: message.body.tag, attempts: message.attempts });
    }
    if ((batch.messages[0]?.attempts ?? 1) < 2) {
      for (const message of batch.messages) {
        if (message.body.tag === "keep") {
          message.ack();
        }
      }
      batch.retryAll();
    }
  },
};
`;

// Explicitly acks the message tagged "keep" and then *throws* (while attempts <
// 2). A thrown handler retries the batch, but explicitly acked messages must
// still survive: "keep" is delivered once while "redo" is redelivered. Records
// each delivery, read back via \`GET /received\`.
const THROW_AFTER_ACK_SCRIPT = `
const received = (globalThis.__received ??= []);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/sendBatch") {
      const { messages } = await request.json();
      await env.QUEUE.sendBatch(messages);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/received") {
      return Response.json(received);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      received.push({ id: message.id, tag: message.body.tag, attempts: message.attempts });
    }
    if ((batch.messages[0]?.attempts ?? 1) < 2) {
      for (const message of batch.messages) {
        if (message.body.tag === "keep") {
          message.ack();
        }
      }
      throw new Error("intentional failure after ack");
    }
  },
};
`;

// Producer/consumer worker that returns the value resolved by send()/sendBatch()
// so tests can assert the backlog metadata. The consumer holds messages (high
// batch timeout) so the backlog is observable.
const METADATA_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const resp = await env.QUEUE.send("msg");
      return Response.json(resp ?? null);
    }
    if (url.pathname === "/sendBatch") {
      const resp = await env.QUEUE.sendBatch([{ body: "m1" }, { body: "m2" }]);
      return Response.json(resp ?? null);
    }
    return new Response("not found", { status: 404 });
  },
  async queue(batch, env) {},
};
`;

interface ReceivedMessage {
  queue: string;
  id: string;
  attempts: number;
  body: unknown;
  at?: number;
}

interface AckRecord {
  id: string;
  tag: string;
  attempts: number;
}

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Queues binding",
  (it) => {
    it.effect("delivers single messages and batches to the consumer", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-basic",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "basic-queue" }),
          ],
          queueConsumers: [{ queueName: "basic-queue", maxBatchTimeout: 0 }],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({ binding: "QUEUE", body: "hello" }),
        });
        yield* worker.fetch("/sendBatch", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            messages: [{ body: "a" }, { body: "b" }],
          }),
        });

        const received = yield* pollMessages(worker, (r) => r.length >= 3);
        expect(received.length).toBe(3);
        const bodies = received.map((message) => message.body).sort();
        expect(bodies).toEqual(["a", "b", "hello"]);
        for (const message of received) {
          expect(message.queue).toBe("basic-queue");
          expect(message.attempts).toBe(1);
          expect(message.id).toMatch(/^[0-9a-f]{32}$/);
        }
      }),
    );

    it.effect("supports text, json, bytes and v8 content types", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-content-types",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "types-queue" }),
          ],
          queueConsumers: [{ queueName: "types-queue", maxBatchTimeout: 0 }],
        });

        yield* worker.fetch("/sendTypes", { method: "POST" });

        const received = yield* pollMessages(worker, (r) => r.length >= 4);
        const bodies = received.map((message) => message.body);
        expect(bodies).toContainEqual("msg-text");
        expect(bodies).toContainEqual([{ message: "msg-json" }]);
        expect(bodies).toContainEqual({
          $type: "ArrayBuffer",
          value: [0, 1, 2, 3],
        });
        expect(bodies).toContainEqual({ $type: "Date", value: 1600000000000 });
      }),
    );

    it.effect("retries a message until it is acked", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-retry",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "retry-queue" }),
          ],
          queueConsumers: [
            { queueName: "retry-queue", maxBatchTimeout: 0, maxRetries: 2 },
          ],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 2 } }),
        });

        const received = yield* pollMessages(worker, (r) =>
          r.some((m) => m.attempts === 2),
        );
        const attempts = received.map((message) => message.attempts).sort();
        expect(attempts).toEqual([1, 2]);
        // Same message id is redelivered on retry.
        expect(new Set(received.map((message) => message.id)).size).toBe(1);
      }),
    );

    it.effect("retries the whole batch via batch.retryAll()", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-retry-all",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: RETRY_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "retry-all-queue" }),
          ],
          queueConsumers: [
            { queueName: "retry-all-queue", maxBatchTimeout: 0, maxRetries: 2 },
          ],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            body: { action: "retryAll", failUntil: 2 },
          }),
        });

        const received = yield* pollMessages(worker, (r) =>
          r.some((m) => m.attempts === 2),
        );
        expect(received.map((message) => message.attempts).sort()).toEqual([
          1, 2,
        ]);
        expect(new Set(received.map((message) => message.id)).size).toBe(1);
      }),
    );

    it.effect("retries when the consumer throws an exception", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-retry-throw",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: RETRY_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "retry-throw-queue" }),
          ],
          queueConsumers: [
            {
              queueName: "retry-throw-queue",
              maxBatchTimeout: 0,
              maxRetries: 2,
            },
          ],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            body: { action: "throw", failUntil: 2 },
          }),
        });

        const received = yield* pollMessages(worker, (r) =>
          r.some((m) => m.attempts === 2),
        );
        expect(received.map((message) => message.attempts).sort()).toEqual([
          1, 2,
        ]);
        expect(new Set(received.map((message) => message.id)).size).toBe(1);
      }),
    );

    it.effect(
      "drops a message after exhausting retries with no dead letter queue",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-drop",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: RETRY_SCRIPT },
            ],
            bindings: [
              Queue.local({ binding: "QUEUE", queueName: "drop-queue" }),
            ],
            queueConsumers: [
              { queueName: "drop-queue", maxBatchTimeout: 0, maxRetries: 1 },
            ],
          });

          yield* worker.fetch("/send", {
            method: "POST",
            body: JSON.stringify({
              binding: "QUEUE",
              body: { action: "throw", failUntil: 99 },
            }),
          });

          // maxRetries 1 => delivered at most twice (attempts 1 and 2), then dropped.
          yield* pollMessages(worker, (r) => r.some((m) => m.attempts === 2));
          // Give any (incorrect) extra redelivery a chance to show up.
          yield* Effect.sleep("500 millis");
          const received =
            yield* worker.fetchJson<ReadonlyArray<ReceivedMessage>>(
              "/received",
            );
          expect(received.map((message) => message.attempts).sort()).toEqual([
            1, 2,
          ]);
        }),
    );

    it.effect("honors an explicit message.ack() over a batch retryAll()", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-explicit-ack",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [{ name: "main.js", type: "ESModule", content: ACK_SCRIPT }],
          bindings: [Queue.local({ binding: "QUEUE", queueName: "ack-queue" })],
          queueConsumers: [
            { queueName: "ack-queue", maxBatchTimeout: 0, maxRetries: 2 },
          ],
        });

        yield* worker.fetch("/sendBatch", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            messages: [{ body: { tag: "keep" } }, { body: { tag: "redo" } }],
          }),
        });

        // Wait until the un-acked message has been redelivered (attempt 2).
        yield* poll<ReadonlyArray<AckRecord>>(worker, "/received", (r) =>
          r.some((m) => m.tag === "redo" && m.attempts === 2),
        );
        // Give any (incorrect) redelivery of the acked message a chance to surface.
        yield* Effect.sleep("300 millis");
        const received =
          yield* worker.fetchJson<ReadonlyArray<AckRecord>>("/received");

        // The explicitly acked message is delivered exactly once despite retryAll().
        expect(
          received.filter((m) => m.tag === "keep").map((m) => m.attempts),
        ).toEqual([1]);
        // The un-acked message is retried as usual.
        expect(
          received
            .filter((m) => m.tag === "redo")
            .map((m) => m.attempts)
            .sort(),
        ).toEqual([1, 2]);
      }),
    );

    it.effect(
      "preserves an explicit message.ack() when the handler then throws",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-ack-then-throw",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              {
                name: "main.js",
                type: "ESModule",
                content: THROW_AFTER_ACK_SCRIPT,
              },
            ],
            bindings: [
              Queue.local({ binding: "QUEUE", queueName: "ack-throw-queue" }),
            ],
            queueConsumers: [
              {
                queueName: "ack-throw-queue",
                maxBatchTimeout: 0,
                maxRetries: 2,
              },
            ],
          });

          yield* worker.fetch("/sendBatch", {
            method: "POST",
            body: JSON.stringify({
              binding: "QUEUE",
              messages: [{ body: { tag: "keep" } }, { body: { tag: "redo" } }],
            }),
          });

          // Wait until the un-acked message has been redelivered (attempt 2).
          yield* poll<ReadonlyArray<AckRecord>>(worker, "/received", (r) =>
            r.some((m) => m.tag === "redo" && m.attempts === 2),
          );
          // Give any (incorrect) redelivery of the acked message a chance to surface.
          yield* Effect.sleep("300 millis");
          const received =
            yield* worker.fetchJson<ReadonlyArray<AckRecord>>("/received");

          // The acked message survives the thrown handler: delivered exactly once.
          expect(
            received.filter((m) => m.tag === "keep").map((m) => m.attempts),
          ).toEqual([1]);
          // The un-acked message is retried by the exception.
          expect(
            received
              .filter((m) => m.tag === "redo")
              .map((m) => m.attempts)
              .sort(),
          ).toEqual([1, 2]);
        }),
    );

    it.effect("delays redelivery by the consumer retryDelay", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-retry-delay",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: RETRY_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "retry-delay-queue" }),
          ],
          queueConsumers: [
            {
              queueName: "retry-delay-queue",
              maxBatchTimeout: 0,
              maxRetries: 1,
              retryDelay: 1,
            },
          ],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            body: { action: "retryAll", failUntil: 2 },
          }),
        });

        const received = yield* pollMessages(worker, (r) =>
          r.some((m) => m.attempts === 2),
        );
        const first = received.find((m) => m.attempts === 1);
        const second = received.find((m) => m.attempts === 2);
        expect(first?.at).toBeDefined();
        expect(second?.at).toBeDefined();
        // retryDelay is 1 second; redelivery must wait roughly that long.
        expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(
          900,
        );
      }),
    );

    it.effect(
      "moves messages to a dead letter queue after exhausting retries",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-dlq",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
            ],
            bindings: [Queue.local({ binding: "QUEUE", queueName: "bad" })],
            queueConsumers: [
              {
                queueName: "bad",
                maxBatchTimeout: 0,
                maxRetries: 0,
                deadLetterQueue: "dlq",
              },
              { queueName: "dlq", maxBatchTimeout: 0, maxRetries: 0 },
            ],
          });

          yield* worker.fetch("/send", {
            method: "POST",
            body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 99 } }),
          });

          const received = yield* pollMessages(worker, (r) =>
            r.some((m) => m.queue === "dlq"),
          );
          expect(received.some((message) => message.queue === "bad")).toBe(
            true,
          );
          expect(received.some((message) => message.queue === "dlq")).toBe(
            true,
          );
        }),
    );

    it.effect(
      "starts a consumer whose dead letter queue has no consumer anywhere",
      () =>
        Effect.gen(function* () {
          // Regression test for alchemy-run/alchemy#988: a DLQ that this worker
          // does not itself consume resolves to the registry proxy. The subscribe
          // used to happen inside this plugin's `defer`, racing the RegistryProxy
          // defer that decides whether to emit the proxy service at all — workerd
          // then failed to start with a binding referencing the undefined service
          // `cloudflare-runtime:registry-proxy`.
          const worker = yield* startTestWorker({
            name: "queues-orphan-dlq",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
            ],
            bindings: [
              Queue.local({ binding: "QUEUE", queueName: "orphan-dlq-src" }),
            ],
            queueConsumers: [
              {
                queueName: "orphan-dlq-src",
                maxBatchTimeout: 0,
                maxRetries: 0,
                deadLetterQueue: "orphan-dlq",
              },
            ],
          });

          // Exhaust retries: the dead-lettered message routes to the proxy, which
          // accepts and drops it because no consumer of "orphan-dlq" is running.
          yield* worker.fetch("/send", {
            method: "POST",
            body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 99 } }),
          });
          yield* pollMessages(worker, (r) => r.length >= 1);

          // The worker stays functional after the drop.
          yield* worker.fetch("/send", {
            method: "POST",
            body: JSON.stringify({ binding: "QUEUE", body: "still-alive" }),
          });
          const received = yield* pollMessages(worker, (r) =>
            r.some((m) => m.body === "still-alive"),
          );
          expect(
            received.every((message) => message.queue === "orphan-dlq-src"),
          ).toBe(true);
        }),
    );

    it.effect(
      "allows a cyclic dead letter queue path across multiple queues",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-cyclic-dlq",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
            ],
            bindings: [Queue.local({ binding: "QUEUE", queueName: "bad" })],
            queueConsumers: [
              {
                queueName: "bad",
                maxBatchTimeout: 0,
                maxRetries: 0,
                deadLetterQueue: "dlq",
              },
              // `dlq` dead-letters back to `bad`: a cycle that is allowed because the
              // two queues are distinct (only a queue pointing at *itself* is rejected).
              {
                queueName: "dlq",
                maxBatchTimeout: 0,
                maxRetries: 0,
                deadLetterQueue: "bad",
              },
            ],
          });

          yield* worker.fetch("/send", {
            method: "POST",
            body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 99 } }),
          });

          // The message bounces bad -> dlq -> bad, proving the cycle is permitted.
          const received = yield* pollMessages(
            worker,
            (r) =>
              r.filter((m) => m.queue === "bad").length >= 2 &&
              r.some((m) => m.queue === "dlq"),
          );
          const queues = received.map((message) => message.queue);
          expect(queues.slice(0, 3)).toEqual(["bad", "dlq", "bad"]);
        }),
    );

    it.effect("applies a delivery delay to messages", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-delay",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "delay-queue" }),
          ],
          queueConsumers: [{ queueName: "delay-queue", maxBatchTimeout: 0 }],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            body: "delayed",
            options: { delaySeconds: 1 },
          }),
        });
        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({ binding: "QUEUE", body: "immediate" }),
        });

        // The immediate message arrives well before the delayed one.
        const afterImmediate = yield* pollMessages(
          worker,
          (r) => r.length >= 1,
          500,
        );
        expect(afterImmediate.map((message) => message.body)).toEqual([
          "immediate",
        ]);

        // Generous deadline: delayed delivery is timer-driven and the Windows CI
        // runner can lag several seconds behind wall-clock under load.
        const all = yield* pollMessages(worker, (r) => r.length >= 2, 15_000);
        expect(all.map((message) => message.body).sort()).toEqual([
          "delayed",
          "immediate",
        ]);
      }),
    );

    it.effect(
      "applies the producer's default delivery delay to send() and sendBatch()",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-default-delay",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
            ],
            bindings: [
              Queue.local({
                binding: "QUEUE",
                queueName: "default-delay-queue",
                deliveryDelay: 1,
              }),
            ],
            queueConsumers: [
              { queueName: "default-delay-queue", maxBatchTimeout: 0 },
            ],
          });

          yield* worker.fetch("/send", {
            method: "POST",
            body: JSON.stringify({ binding: "QUEUE", body: "via-send" }),
          });
          yield* worker.fetch("/sendBatch", {
            method: "POST",
            body: JSON.stringify({
              binding: "QUEUE",
              messages: [{ body: "via-batch" }],
            }),
          });

          // Nothing should be delivered before the 1s default delay elapses.
          const early = yield* pollMessages(
            worker,
            (r) => r.length >= 1,
            500,
          ).pipe(Effect.flip);
          expect(early).toBeInstanceOf(PredicateFailed);

          const all = yield* pollMessages(worker, (r) => r.length >= 2, 15_000);
          expect(all.map((message) => message.body).sort()).toEqual([
            "via-batch",
            "via-send",
          ]);
        }),
    );

    it.effect("applies a per-batch delaySeconds option to sendBatch()", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-batch-delay",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "batch-delay-queue" }),
          ],
          queueConsumers: [
            { queueName: "batch-delay-queue", maxBatchTimeout: 0 },
          ],
        });

        yield* worker.fetch("/sendBatch", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            messages: [{ body: "a" }, { body: "b" }],
            options: { delaySeconds: 1 },
          }),
        });

        const early = yield* pollMessages(
          worker,
          (r) => r.length >= 1,
          500,
        ).pipe(Effect.flip);
        expect(early).toBeInstanceOf(PredicateFailed);

        const all = yield* pollMessages(worker, (r) => r.length >= 2, 15_000);
        expect(all.map((message) => message.body).sort()).toEqual(["a", "b"]);
      }),
    );

    it.effect("applies per-message delaySeconds within a sendBatch()", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-batch-msg-delay",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({
              binding: "QUEUE",
              queueName: "batch-msg-delay-queue",
            }),
          ],
          queueConsumers: [
            { queueName: "batch-msg-delay-queue", maxBatchTimeout: 0 },
          ],
        });

        yield* worker.fetch("/sendBatch", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            messages: [{ body: "now" }, { body: "later", delaySeconds: 1 }],
          }),
        });

        // The undelayed message arrives well before the delayed one.
        const afterImmediate = yield* pollMessages(
          worker,
          (r) => r.length >= 1,
        );
        expect(afterImmediate.map((message) => message.body)).toEqual(["now"]);

        const all = yield* pollMessages(worker, (r) => r.length >= 2);
        expect(all.map((message) => message.body).sort()).toEqual([
          "later",
          "now",
        ]);
      }),
    );

    it.effect("returns backlog metadata from send()", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-send-metadata",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: ["experimental"],
          modules: [
            { name: "main.js", type: "ESModule", content: METADATA_SCRIPT },
          ],
          bindings: [Queue.local({ binding: "QUEUE", queueName: "send-meta" })],
          // High timeout so the first message stays in the backlog.
          queueConsumers: [{ queueName: "send-meta", maxBatchTimeout: 30 }],
        });

        // First send populates the backlog; the second send observes it.
        yield* worker.fetch("/send", { method: "POST" });
        const json = yield* worker.fetchJson<MessageBatchMetadata>("/send", {
          method: "POST",
        });
        expect(json).toMatchObject({
          metadata: {
            metrics: {
              backlogCount: 1,
              backlogBytes: expect.any(Number),
            },
          },
        });
      }),
    );

    it.effect("returns backlog metadata from sendBatch()", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-send-batch-metadata",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: ["experimental"],
          modules: [
            { name: "main.js", type: "ESModule", content: METADATA_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "send-batch-meta" }),
          ],
          queueConsumers: [
            { queueName: "send-batch-meta", maxBatchTimeout: 30 },
          ],
        });

        yield* worker.fetch("/sendBatch", { method: "POST" });
        const json = yield* worker.fetchJson<MessageBatchMetadata>(
          "/sendBatch",
          { method: "POST" },
        );
        expect(json).toMatchObject({
          metadata: {
            metrics: {
              backlogCount: 2,
              backlogBytes: expect.any(Number),
            },
          },
        });
      }),
    );

    it.effect("permits strange queue names", () =>
      Effect.gen(function* () {
        const queueName = "my/ Queue";
        const worker = yield* startTestWorker({
          name: "queues-strange-name",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [Queue.local({ binding: "QUEUE", queueName })],
          queueConsumers: [{ queueName, maxBatchTimeout: 0 }],
        });

        yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({ binding: "QUEUE", body: "msg1" }),
        });
        yield* worker.fetch("/sendBatch", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            messages: [{ body: "msg2" }],
          }),
        });

        const received = yield* pollMessages(worker, (r) => r.length >= 2);
        expect(received.map((message) => message.body).sort()).toEqual([
          "msg1",
          "msg2",
        ]);
        for (const message of received) {
          expect(message.queue).toBe(queueName);
        }
      }),
    );

    it.effect("rejects messages that exceed the size limit", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-size",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "size-queue" }),
          ],
          queueConsumers: [{ queueName: "size-queue", maxBatchTimeout: 0 }],
        });

        const res = yield* worker.fetch("/send", {
          method: "POST",
          body: JSON.stringify({
            binding: "QUEUE",
            body: "x".repeat(128 * 1000 + 1),
            options: { contentType: "text" },
          }),
        });
        expect(res.status).toBe(500);
        const { error } = (yield* Effect.promise(() => res.json())) as {
          error: string;
        };
        // workerd surfaces the broker's 413 to the producer as "Payload Too Large".
        expect(error).toMatch(/Payload Too Large|exceeds limit/i);
      }),
    );

    it.effect("round-trips all structured cloneable types", () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "queues-structured-clone",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            { name: "main.js", type: "ESModule", content: CLONE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "clone-queue" }),
          ],
          queueConsumers: [
            {
              queueName: "clone-queue",
              maxBatchSize: 100,
              maxBatchTimeout: 0,
              maxRetries: 0,
            },
          ],
        });

        yield* worker.fetch("/send", { method: "POST" });

        const { result } = yield* poll<{ result: string }>(
          worker,
          "/result",
          (r) => r.result !== "pending",
        );
        expect(result).toBe("ok");
      }),
    );

    it.effect(
      "flushes a full batch immediately without waiting for the timeout",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-full-batch",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: BATCH_SCRIPT },
            ],
            bindings: [
              Queue.local({ binding: "QUEUE", queueName: "full-batch" }),
            ],
            // High timeout so a partial batch would *not* flush during the test;
            // only a full batch (size 3) should be delivered.
            queueConsumers: [
              { queueName: "full-batch", maxBatchSize: 3, maxBatchTimeout: 30 },
            ],
          });

          yield* worker.fetch("/sendBatch", {
            method: "POST",
            body: JSON.stringify({
              binding: "QUEUE",
              messages: [{ body: "a" }, { body: "b" }, { body: "c" }],
            }),
          });

          const batches = yield* pollBatch(worker, (b) => b.length >= 1);
          expect(batches.length).toBe(1);
          expect([...batches[0]].sort()).toEqual(["a", "b", "c"]);
        }),
    );

    it.effect(
      "splits an overflowing batch into a full batch and a remainder",
      () =>
        Effect.gen(function* () {
          const worker = yield* startTestWorker({
            name: "queues-overflow-batch",
            compatibilityDate: "2024-11-20",
            compatibilityFlags: [],
            modules: [
              { name: "main.js", type: "ESModule", content: BATCH_SCRIPT },
            ],
            bindings: [
              Queue.local({ binding: "QUEUE", queueName: "overflow-batch" }),
            ],
            queueConsumers: [
              {
                queueName: "overflow-batch",
                maxBatchSize: 5,
                maxBatchTimeout: 1,
              },
            ],
          });

          yield* worker.fetch("/sendBatch", {
            method: "POST",
            body: JSON.stringify({
              binding: "QUEUE",
              messages: Array.from({ length: 7 }, (_, i) => ({ body: i })),
            }),
          });

          const batches = yield* pollBatch(worker, (b) => b.flat().length >= 7);
          const sizes = batches
            .map((batch) => batch.length)
            .sort((a, b) => b - a);
          expect(sizes).toEqual([5, 2]);
          expect(
            batches.flat().sort((a, b) => (a as number) - (b as number)),
          ).toEqual([0, 1, 2, 3, 4, 5, 6]);
        }),
    );
  },
);

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Queues binding validation",
  (it) => {
    it.effect("rejects a queue configured as its own dead letter queue", () =>
      Effect.gen(function* () {
        const error = yield* startTestWorker({
          name: "queues-self-cycle",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [Queue.local({ binding: "QUEUE", queueName: "loop" })],
          queueConsumers: [{ queueName: "loop", deadLetterQueue: "loop" }],
        }).pipe(Effect.flip);
        assert.equal(error._tag, "ConfigError");
        expect(error.message).toContain("cannot be itself");
      }),
    );

    it.effect("rejects a consumer maxBatchTimeout greater than 60", () =>
      Effect.gen(function* () {
        const error = yield* startTestWorker({
          name: "queues-bad-batch-timeout",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "bad-timeout" }),
          ],
          queueConsumers: [{ queueName: "bad-timeout", maxBatchTimeout: 61 }],
        }).pipe(Effect.flip);
        assert.equal(error._tag, "ConfigError");
        expect(error.message).toMatch(/maxBatchTimeout/);
      }),
    );
  },
);

// Cross-instance: a producer in one `Runtime` sends to a queue consumed by a
// worker in a *different* `Runtime`. The producer's binding routes through the
// dev-registry proxy to the consumer instance's broker. Both runtimes run
// in-process and communicate via the on-disk dev registry.
const CROSS_PRODUCER_SCRIPT = `
export default {
  async fetch(request, env) {
    await env.QUEUE.send({ hello: "from-producer" });
    return new Response(null, { status: 204 });
  },
};
`;

layer(localRuntimeLayer, {
  excludeTestServices: true,
})("Queues binding cross-instance", (it) => {
  it.effect(
    "delivers messages from a producer instance to a consumer instance",
    () =>
      Effect.gen(function* () {
        // Consumer instance: owns the broker for "cross-queue".
        const consumer = yield* startTestWorker({
          name: "cross-consumer",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "cross-queue" }),
          ],
          queueConsumers: [{ queueName: "cross-queue", maxBatchTimeout: 0 }],
        });

        // Producer instance: declares a producer for a queue it does not
        // consume, so the binding routes through the proxy.
        const producer = yield* startTestWorker({
          name: "cross-producer",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: CROSS_PRODUCER_SCRIPT,
            },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "cross-queue" }),
          ],
        });

        yield* waitForRegistryEntry({
          kind: "queue-consumer",
          queueName: "cross-queue",
        });
        yield* producer.fetch("/", { method: "POST" });

        const received = yield* pollMessages(consumer, (r) => r.length >= 1);
        expect(received.length).toBeGreaterThanOrEqual(1);
        expect(received[0]?.queue).toBe("cross-queue");
        expect(received[0]?.body).toEqual({ hello: "from-producer" });
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "settles send() when no consumer of the queue is running anywhere",
    () =>
      Effect.gen(function* () {
        // Producer only: the binding routes through the registry proxy,
        // which has no target and accepts-and-drops (with a `[registry]`
        // warning). The drop must still settle the producer's `send()` —
        // the stub previously responded without draining the request body,
        // and workerd's queue client only settles once the body has been
        // consumed, so `send()` (and this fetch) hung forever
        // (alchemy-run/alchemy#1109).
        const producer = yield* startTestWorker({
          name: "drop-producer",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: CROSS_PRODUCER_SCRIPT,
            },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "nobody-consumes" }),
          ],
        });

        const res = yield* producer
          .fetch("/", { method: "POST" })
          .pipe(Effect.timeout("15 seconds"));
        expect(res.status).toBe(204);
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "dead-letters messages to a consumer in a different instance",
    () =>
      Effect.gen(function* () {
        // DLQ consumer instance: owns the broker for "cross-dlq".
        const dlqConsumer = yield* startTestWorker({
          name: "cross-dlq-consumer",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [Queue.local({ binding: "QUEUE", queueName: "cross-dlq" })],
          queueConsumers: [{ queueName: "cross-dlq", maxBatchTimeout: 0 }],
        });

        // Source instance: consumes its own queue but dead-letters to a queue
        // consumed by the other instance, so the DLQ binding routes through
        // the registry proxy.
        const source = yield* startTestWorker({
          name: "cross-dlq-source",
          compatibilityDate: "2024-11-20",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: QUEUE_SCRIPT },
          ],
          bindings: [
            Queue.local({ binding: "QUEUE", queueName: "cross-dlq-src" }),
          ],
          queueConsumers: [
            {
              queueName: "cross-dlq-src",
              maxBatchTimeout: 0,
              maxRetries: 0,
              deadLetterQueue: "cross-dlq",
            },
          ],
        });

        yield* waitForRegistryEntry({
          kind: "queue-consumer",
          queueName: "cross-dlq",
        });
        yield* source.fetch("/send", {
          method: "POST",
          body: JSON.stringify({ binding: "QUEUE", body: { failUntil: 99 } }),
        });

        const received = yield* pollMessages(dlqConsumer, (r) =>
          r.some((m) => m.queue === "cross-dlq"),
        );
        const deadLettered = received.find((m) => m.queue === "cross-dlq");
        expect(deadLettered?.body).toEqual({ failUntil: 99 });
      }),
    { timeout: 60_000 },
  );
});

const pollMessages = (
  worker: TestWorker,
  predicate: (json: ReadonlyArray<ReceivedMessage>) => boolean,
  timeout?: number,
) => poll(worker, "/received", predicate, timeout);

const pollBatch = (
  worker: TestWorker,
  predicate: (json: ReadonlyArray<ReadonlyArray<unknown>>) => boolean,
  timeout?: number,
) => poll(worker, "/batches", predicate, timeout);
