import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { KV } from "./KV.ts";
import NotifyWorkflow from "./NotifyWorkflow.ts";
import SandboxDO from "./SandboxDO.ts";

/**
 * Analytics Engine dataset — a plain binding value, not a cloud resource.
 * In local dev `writeDataPoint` is accepted and discarded (Miniflare
 * parity); on a live deploy the points land in the real dataset.
 */
export const Events = Cloudflare.AnalyticsEngine.Dataset("Events", {
  dataset: "cloudflare_dev_events",
});

/**
 * Checked-in HMAC key material for the `secret_key` binding (32 bytes,
 * base64) — never generate key material at deploy time.
 */
const HMAC_KEY_BASE64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

interface AddInstance {
  exports: {
    add(a: number, b: number): number;
  };
}
interface Message {
  id: string;
  body: {
    text: string;
    sentAt: number;
  };
}

export default class EffectWorker extends Cloudflare.Worker<EffectWorker>()(
  "EffectWorker",
  {
    main: import.meta.url,
    dev: {
      port: Config.number("PORT").pipe(Config.withDefault(1338)),
    },
    build: {
      bundleAnalyzer: true,
    },
  },
  Effect.gen(function* () {
    const publicUrl = yield* Cloudflare.Worker.URL;
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(KV);
    const queue = yield* Cloudflare.Queues.Queue("EffectWorkerQueue");
    const queueBinding = yield* Cloudflare.Queues.WriteQueue(queue);
    const sandbox = yield* SandboxDO;
    const queueMessages = yield* QueueMessages;
    const workflow = yield* NotifyWorkflow;
    const cronFires = yield* CronFires;
    const analytics = yield* Cloudflare.AnalyticsEngine.WriteDataset(Events);
    // `secret_key` binding: workerd imports the key material as a
    // non-extractable CryptoKey. The accessor is deferred — `yield*` it
    // again inside the handler to get the CryptoKey.
    const hmacKey = yield* Cloudflare.Workers.SecretKey("HMAC_KEY", {
      format: "raw",
      algorithm: { name: "HMAC", hash: "SHA-256" },
      usages: ["sign", "verify"],
      keyBase64: Redacted.make(HMAC_KEY_BASE64),
    });

    // Cron trigger: registered at init; locally you can fire it on demand
    // via `POST /cdn-cgi/handler/scheduled?cron=* * * * *&time=<ms>` instead
    // of waiting for the minute boundary.
    yield* Cloudflare.Workers.cron("* * * * *", (controller) =>
      cronFires.getByName("default").record(controller.scheduledTime),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<Message["body"]>(
      queue,
      (stream) =>
        Stream.runForEach(stream, (msg) =>
          queueMessages
            .getByName("global")
            .put({ id: msg.id, body: msg.body })
            .pipe(Effect.asVoid),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://internal");
        if (url.pathname.startsWith("/sandbox")) {
          const stub = sandbox.getByName("sandbox-test");
          return yield* stub.fetch(request).pipe(Effect.orDie);
        } else if (url.pathname === "/wasm") {
          const instance = yield* Effect.promise(async () => {
            // This is dynamically imported so that the WASM import doesn't occur at deploy-time, which works in Bun but fails in Node.
            const wasm = await import("./modules/wasm-example.wasm");
            return (await WebAssembly.instantiate(wasm.default)) as AddInstance;
          });
          return yield* HttpServerResponse.json({
            result: instance.exports.add(3, 4),
          });
        } else if (url.pathname.startsWith("/workflow/start/")) {
          const roomId = url.pathname.split("/workflow/start/")[1];
          if (!roomId) {
            return yield* HttpServerResponse.json(
              { error: "roomId is required" },
              { status: 400 },
            );
          }
          const instance = yield* workflow.create({
            params: {
              roomId,
              message: "hello from workflow",
            },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        } else if (url.pathname.startsWith("/workflow/status/")) {
          const instanceId = url.pathname.split("/workflow/status/")[1];
          if (!instanceId) {
            return yield* HttpServerResponse.json(
              { error: "instanceId is required" },
              { status: 400 },
            );
          }
          const instance = yield* workflow.get(instanceId);
          const status = yield* instance.status();
          return yield* HttpServerResponse.json(status);
        } else if (url.pathname.startsWith("/queue/send")) {
          const body = yield* request.json;
          yield* queueBinding.send(body).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: body });
        } else if (url.pathname.startsWith("/queue/messages")) {
          const messages = yield* queueMessages.getByName("global").list();
          return yield* HttpServerResponse.json(messages);
        } else if (url.pathname.startsWith("/url")) {
          return yield* HttpServerResponse.json({ url: yield* publicUrl });
        } else if (url.pathname.startsWith("/cron/times")) {
          const snapshot = yield* cronFires.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        } else if (url.pathname.startsWith("/secret-key")) {
          const key = yield* hmacKey;
          const data = new TextEncoder().encode(
            url.searchParams.get("message") ?? "hello",
          );
          const signature = yield* Effect.promise(() =>
            crypto.subtle.sign("HMAC", key, data),
          );
          const verified = yield* Effect.promise(() =>
            crypto.subtle.verify("HMAC", key, signature, data),
          );
          return yield* HttpServerResponse.json({
            verified,
            algorithm: key.algorithm.name,
            // Bound keys are never extractable — local lowering matches.
            extractable: key.extractable,
            signatureBase64: btoa(
              String.fromCharCode(...new Uint8Array(signature)),
            ),
          });
        } else if (url.pathname.startsWith("/analytics")) {
          // A documented no-op in local dev — the write succeeding (not
          // throwing) is the observable behavior.
          yield* analytics
            .writeDataPoint({
              indexes: ["example"],
              blobs: ["visit"],
              doubles: [1],
            })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }
        const value = yield* kv.list().pipe(Effect.orDie);
        return yield* HttpServerResponse.json(value);
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.KV.ReadWriteNamespaceBinding,
      Cloudflare.Queues.WriteQueueBinding,
      Cloudflare.Queues.EventSourceLive,
      Cloudflare.Workers.CronEventSourceLive,
      Cloudflare.Workers.SecretKeyBinding,
      Cloudflare.AnalyticsEngine.WriteDatasetBinding,
    ]),
  ),
) {}

/**
 * Records each `scheduledTime` the cron handler observes; the integ test
 * fires the trigger route and polls `GET /cron/times` until it shows up.
 */
export class CronFires extends Cloudflare.DurableObject<CronFires>()(
  "CronFires",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        record: Effect.fn(function* (time: number) {
          const times = (yield* state.storage.get<number[]>("times")) ?? [];
          yield* state.storage.put("times", [...times, time]);
        }),
        snapshot: Effect.fn(function* () {
          return { times: (yield* state.storage.get<number[]>("times")) ?? [] };
        }),
      };
    }),
  ),
) {}

export class QueueMessages extends Cloudflare.DurableObject<QueueMessages>()(
  "QueueMessages",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        put: Effect.fn(function* (message: Message) {
          yield* state.storage.put(message.id, message);
        }),
        list: Effect.fn(function* () {
          const messages = new Map<string, Message>(
            state.storage.kv.list<Message>(),
          );
          return Array.from(messages.values());
        }),
      };
    }),
  ),
) {}
