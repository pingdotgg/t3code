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
      default:
        const counter = env.COUNTER.getByName("my-counter");
        const count = await counter.increment();
        return new Response(`Hello, world! ${count}`);
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
