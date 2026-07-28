import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { KV } from "./KV.ts";
import NotifyWorkflow from "./NotifyWorkflow.ts";
import SandboxDO from "./SandboxDO.ts";

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
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(KV);
    const queue = yield* Cloudflare.Queues.Queue("EffectWorkerQueue");
    const queueBinding = yield* Cloudflare.Queues.WriteQueue(queue);
    const sandbox = yield* SandboxDO;
    const queueMessages = yield* QueueMessages;
    const workflow = yield* NotifyWorkflow;

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
    ]),
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
