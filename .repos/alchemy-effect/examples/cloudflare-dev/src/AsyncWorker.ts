import { DurableObject } from "cloudflare:workers";
import type { AsyncWorkerEnv } from "../alchemy.run.ts";
import wasm from "./modules/wasm-example.wasm";

interface AddInstance {
  exports: {
    add(a: number, b: number): number;
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/env":
        return Response.json(env);
      case "/wasm":
        const instance = (await WebAssembly.instantiate(wasm)) as AddInstance;
        return Response.json({ result: instance.exports.add(3, 4) });
      case "/queue/send": {
        const body = await request.json<Message["body"]>();
        const queue = await env.QUEUE.send(body);
        return Response.json({ queue });
      }
      case "/queue/messages": {
        const storage = env.MESSAGES.getByName("global");
        const messages = await storage.list();
        return Response.json(messages);
      }
      case "/counter": {
        const counter = env.COUNTER.getByName("my-counter");
        const count = await counter.increment();
        return new Response(`Hello, world! ${count}`);
      }
      case "/r2": {
        await env.BUCKET.put("hello.txt", "hello from r2");
        const object = await env.BUCKET.get("hello.txt");
        const text = object === null ? null : await object.text();
        const list = await env.BUCKET.list();
        return Response.json({
          text,
          keys: list.objects.map((o) => o.key),
        });
      }
      case "/d1": {
        // The `greetings` table comes from ./migrations — no DDL here, so a
        // failing migration apply fails this route loudly.
        await env.DB.prepare("INSERT INTO greetings (text) VALUES (?)")
          .bind("hello from d1")
          .run();
        const row = await env.DB.prepare(
          "SELECT text FROM greetings ORDER BY id DESC LIMIT 1",
        ).first<{ text: string }>();
        return Response.json({ text: row?.text ?? null });
      }
      case "/cache": {
        // The local runtime ships an always-on Cache API simulator
        // (persisted under `.alchemy/local`), so `caches.default` works
        // exactly like in production. The caller supplies a key to keep
        // "first fetch misses" deterministic across runs.
        const keyName = url.searchParams.get("key") ?? "cached-resource";
        const key = new Request(`https://example.com/${keyName}`);
        let hit = true;
        let cached = await caches.default.match(key);
        if (!cached) {
          hit = false;
          cached = new Response("cached-body", {
            headers: { "Cache-Control": "public, max-age=60" },
          });
          await caches.default.put(key, cached.clone());
        }
        return Response.json({ hit, body: await cached.text() });
      }
      case "/ratelimit": {
        // THROTTLE allows 2 requests per 10s per key — the third call with
        // the same key observes `success: false`.
        const key = url.searchParams.get("key") ?? "default";
        const { success } = await env.THROTTLE.limit({ key });
        return Response.json({ success });
      }
      case "/version": {
        // Version metadata binding; locally stubbed with a random `id`.
        return Response.json(env.CF_VERSION_METADATA);
      }
      case "/service": {
        // Service binding: call the Effect-native worker's `/url` route
        // (worker → worker, no public hop).
        const response = await env.SERVICE.fetch("http://effect-worker/url");
        return Response.json(await response.json());
      }
      case "/kv-live": {
        // LIVE_KV opted out of local emulation via `Alchemy.remote()` — the
        // roundtrip below lands in the REAL cloud namespace even in dev.
        const key = url.searchParams.get("key") ?? "hello";
        const value = url.searchParams.get("value");
        if (value !== null) {
          await env.LIVE_KV.put(key, value);
        }
        return Response.json({ value: await env.LIVE_KV.get(key) });
      }
      case "/tail-ping": {
        // Logged marker rides the trace batch delivered to the tail worker.
        console.log("cloudflare-dev-tail-marker");
        return new Response("pinged");
      }
      default:
        return env.ASSETS.fetch(request);
    }
  },
  async queue(batch, env) {
    const storage = env.MESSAGES.getByName("global");
    for (const message of batch.messages) {
      await storage.put({
        id: message.id,
        body: message.body as Message["body"],
      });
    }
  },
} satisfies ExportedHandler<AsyncWorkerEnv>;

export class Counter extends DurableObject {
  async increment() {
    return ++this.counter;
  }

  get counter() {
    return this.ctx.storage.kv.get<number>("counter") ?? 0;
  }

  set counter(value: number) {
    this.ctx.storage.kv.put("counter", value);
  }
}

export interface Message {
  id: string;
  body: {
    text: string;
    sentAt: number;
  };
}

export class QueueMessages extends DurableObject {
  async put(message: Message) {
    this.ctx.storage.kv.put(message.id, message);
  }

  async list(): Promise<Message[]> {
    const messages = new Map(this.ctx.storage.kv.list<Message>());
    return Array.from(messages.values());
  }
}
