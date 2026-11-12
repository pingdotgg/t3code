import { EmailMessage } from "cloudflare:email";
/// <reference types="vite/client" />
// Mirrors the runtime-feature playgrounds of `@cloudflare/vite-plugin`:
// `bindings`, `durable-objects`, `block-concurrency-while`, `workflows`,
// `websockets`, `ctx-exports`, `same-worker-service-bindings`,
// `importable-env`, `explicit-resource-management`, `cron-triggers`,
// `email-worker`, `stream-binding`, `external-durable-objects` and
// `external-workflows`.
// Each route is the playground's handler for the spec it backs.
import {
  DurableObject,
  WorkerEntrypoint,
  WorkflowEntrypoint,
  env as importedEnv,
} from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Counter as ExternalCounter } from "../worker-b/index.ts";
import image from "./image.png?inline";

interface Env {
  KV: KVNamespace;
  IMAGES: ImagesBinding;
  WAE: AnalyticsEngineDataset;
  RATE_LIMITER: RateLimit;
  COUNTERS: DurableObjectNamespace<Counter>;
  LEGACY: DurableObjectNamespace;
  KV_BACKED?: DurableObjectNamespace<KvBacked>;
  INITIALIZED: DurableObjectNamespace<BlockConcurrency>;
  WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServer>;
  MY_WORKFLOW: Workflow;
  EXTERNAL_COUNTERS: DurableObjectNamespace<ExternalCounter>;
  EXTERNAL_WORKFLOW: Workflow;
  NAMED_ENTRYPOINT: Service<NamedEntrypoint>;
  LEGACY_ENTRYPOINT: Fetcher;
  EMAIL: SendEmail;
  STREAM: StreamBinding;
  "importable-env_VAR": string;
  "importable-env_SECRET": string;
}

// `importable-env`: the env import resolves at module scope.
const importedVar = (importedEnv as unknown as Env)["importable-env_VAR"];

// `durable-objects`
export class Counter extends DurableObject {
  #log: Array<string> = [];

  async getCounterValue() {
    return ((await this.ctx.storage.get("value")) as number) || 0;
  }

  record(value: string) {
    this.#log.push(value);
  }

  getLog() {
    return this.#log;
  }

  async increment(amount = 1) {
    const value = (((await this.ctx.storage.get("value")) as number) || 0) + amount;
    await this.ctx.storage.put("value", value);
    return value;
  }

  async decrement(amount = 1) {
    const value = (((await this.ctx.storage.get("value")) as number) || 0) - amount;
    await this.ctx.storage.put("value", value);
    return value;
  }
}

// `durable-objects`: a class that doesn't extend `DurableObject`.
export class Legacy {
  fetch() {
    return new Response("Legacy Durable Object");
  }
}

// `block-concurrency-while`
// `durable-objects`: a class declared `storage: "legacy-kv"`, which has no
// SQL storage.
export class KvBacked extends DurableObject {
  hasSql() {
    try {
      this.ctx.storage.sql.exec("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}

export class BlockConcurrency extends DurableObject {
  #isInitialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.#isInitialized = true;
    });
  }

  get isInitialized() {
    return this.#isInitialized;
  }
}

// `websockets`
export class WebSocketServer extends DurableObject {
  override fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    ws.send(`Durable Object received client message: '${data}' of type '${typeof data}'.`);
  }
}

// `workflows`
export class MyWorkflow extends WorkflowEntrypoint {
  override async run(_: WorkflowEvent<unknown>, step: WorkflowStep) {
    await step.do("first step", async () => ({ output: "First step result" }));
    await step.sleep("sleep", "1 second");
    await step.do("second step", async () => ({ output: "Second step result" }));
    return "Workflow output";
  }
}

// `ctx-exports` and `same-worker-service-bindings`
export class NamedEntrypoint extends WorkerEntrypoint {
  multiply(a: number, b: number) {
    return a * b;
  }

  greet() {
    return "Hello World from a Worker Entrypoint";
  }
}

// `same-worker-service-bindings`: a plain object entrypoint.
export const legacy = {
  fetch() {
    return new Response("Legacy Worker entrypoint");
  },
};

const workflowRoutes = async (workflow: Workflow, url: URL) => {
  const id = url.searchParams.get("id") ?? undefined;
  if (url.pathname.endsWith("/create")) {
    let instance: WorkflowInstance;
    try {
      instance = await workflow.create(id === undefined ? undefined : { id });
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("instance.already_exists"))) {
        throw error;
      }
      instance = await workflow.get(id!);
    }
    return Response.json({ id: instance.id, status: await instance.status() });
  }
  return Response.json(await (await workflow.get(id!)).status());
};

const entries = (value: object) =>
  Object.entries(value)
    .filter(([key]) => key.startsWith("importable-env_"))
    .map(([key, value]) => ({ key, value }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "default";
    switch (url.pathname) {
      // `bindings`
      case "/kv": {
        const value = Math.floor(Date.now() * Math.random()).toString(36);
        await env.KV.put("value", value);
        return value === (await env.KV.get("value"))
          ? new Response("KV binding works")
          : new Response("KV binding failed to set value", { status: 500 });
      }
      case "/images": {
        const response = await fetch(image);
        const info = await env.IMAGES.info(response.body!);
        return info.format === "image/png"
          ? new Response("Images binding works")
          : new Response("Images binding returns an incorrect format", { status: 500 });
      }
      case "/ae":
        env.WAE.writeDataPoint({ doubles: [2, 3] });
        return new Response("AE binding works");
      case "/rate-limit": {
        const key = url.searchParams.get("key") ?? "shared-key";
        const { success: first } = await env.RATE_LIMITER.limit({ key });
        const { success: second } = await env.RATE_LIMITER.limit({ key });
        return new Response(`Rate limit binding works: first: ${first}, second: ${second}`);
      }
      // `durable-objects`
      case "/do":
      case "/do/increment":
      case "/do/decrement": {
        const stub = env.COUNTERS.get(env.COUNTERS.idFromName(name));
        const count = url.pathname.endsWith("/increment")
          ? await stub.increment()
          : url.pathname.endsWith("/decrement")
            ? await stub.decrement()
            : await stub.getCounterValue();
        return new Response(`Durable Object '${name}' count: ${count}`);
      }
      case "/do/kv-backed":
        return Response.json({
          hasSql: await env.KV_BACKED!.get(env.KV_BACKED!.idFromName("kv")).hasSql(),
        });
      case "/do/legacy":
        return env.LEGACY.get(env.LEGACY.idFromName("test")).fetch(request);
      case "/do/rpc-ordering": {
        const stub = env.COUNTERS.get(env.COUNTERS.idFromName(name));
        await Promise.all(Array.from({ length: 100 }, (_, i) => stub.record(`call-${i}`)));
        const actual = await stub.getLog();
        const expected = Array.from({ length: 100 }, (_, i) => `call-${i}`);
        return Response.json({ inOrder: JSON.stringify(actual) === JSON.stringify(expected) });
      }
      // `block-concurrency-while`
      case "/do/block-concurrency": {
        const stub = env.INITIALIZED.get(env.INITIALIZED.idFromName("test-id"));
        return Response.json({ isInitialized: await stub.isInitialized });
      }
      // `websockets`
      case "/websocket":
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Durable Object expected Upgrade: websocket", { status: 426 });
        }
        return env.WEBSOCKET_SERVER.get(env.WEBSOCKET_SERVER.idFromName("id")).fetch(request);
      // `workflows` and `external-workflows`
      case "/workflow/create":
      case "/workflow/get":
        return workflowRoutes(env.MY_WORKFLOW, url);
      case "/external-workflow/create":
      case "/external-workflow/get":
        return workflowRoutes(env.EXTERNAL_WORKFLOW, url);
      // `external-durable-objects`
      case "/external-do":
      case "/external-do/increment": {
        const stub = env.EXTERNAL_COUNTERS.get(env.EXTERNAL_COUNTERS.idFromName(name));
        const count = url.pathname.endsWith("/increment")
          ? await stub.increment()
          : await stub.getCounterValue();
        return new Response(`From worker-a: ${JSON.stringify({ name, count })}`);
      }
      // `ctx-exports`
      case "/ctx-exports/worker-entrypoint": {
        const exports = ctx.exports as unknown as { NamedEntrypoint: Service<NamedEntrypoint> };
        return new Response(await exports.NamedEntrypoint.greet());
      }
      // `same-worker-service-bindings`
      case "/service/named":
        return Response.json({ result: await env.NAMED_ENTRYPOINT.multiply(4, 5) });
      case "/service/legacy":
        return env.LEGACY_ENTRYPOINT.fetch(request);
      // `importable-env`
      case "/importable-env":
        return Response.json({
          importedAtModuleScope: importedVar,
          handlerEnv: entries(env),
          importedEnv: entries(importedEnv),
        });
      // `explicit-resource-management`
      case "/explicit-resource-management": {
        const disposed: Array<string> = [];
        {
          await using _session = {
            async [Symbol.asyncDispose]() {
              disposed.push("session");
            },
          };
          using _socket = {
            [Symbol.dispose]() {
              disposed.push("socket");
            },
          };
        }
        return Response.json(disposed);
      }
      // `cron-triggers` (cf-worker-header): an outbound fetch to the test's
      // echo server, which reports the `CF-Worker` header it received.
      case "/cf-worker-header":
        return fetch(url.searchParams.get("echoUrl")!);
      // Miniflare's outbound `cf.image` mock: the origin image is resized
      // locally.
      case "/cf-image":
        return fetch(url.searchParams.get("imageUrl")!, {
          cf: { image: { width: 4, format: "png" } },
        });
      // `stream-binding`: the binding fetches the bytes from `/video-asset`.
      case "/video-asset":
        return new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      case "/stream/upload": {
        const video = await env.STREAM.upload(`${url.origin}/video-asset`);
        return Response.json({ preview: video.preview, id: video.id });
      }
      // `cron-triggers` and `email-worker`: the handlers below record what
      // they received.
      case "/handled":
        return Response.json({
          scheduled: await env.KV.get("scheduled"),
          email: await env.KV.get("email"),
        });
      case "/send": {
        const raw = [
          'From: "Sending email test" <sender@example.com>',
          "To: recipient@example.com",
          "Subject: An email generated in a Worker",
          `Message-ID: <${crypto.randomUUID()}@example.com>`,
          `Date: ${new Date().toUTCString()}`,
          "Content-Type: text/plain",
          "",
          "Congratulations, you just sent an email from a Worker.",
        ].join("\r\n");
        await env.EMAIL.send(new EmailMessage("sender@example.com", "recipient@example.com", raw));
        return new Response("Email message sent successfully!");
      }
    }
    return new Response("vite-runtime-worker");
  },

  async scheduled(controller: ScheduledController, env: Env) {
    await env.KV.put("scheduled", controller.cron || "manual");
  },

  async email(message: ForwardableEmailMessage, env: Env) {
    const raw = await new Response(message.raw).text();
    await env.KV.put("email", `${message.from} ${raw.includes("Hi there") ? "Hi there" : ""}`);
  },
};
