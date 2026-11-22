import { DurableObject } from "cloudflare:workers";

const COUNT_KEY = "count";

type CounterStub = {
  get(): Promise<number>;
  increment(): Promise<number>;
  reset(): Promise<void>;
};

type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  Counter: {
    getByName(name: string): CounterStub;
  };
};

export class Counter extends DurableObject {
  async get() {
    return (await this.ctx.storage.get<number>(COUNT_KEY)) ?? 0;
  }

  async increment() {
    const next = (await this.get()) + 1;
    await this.ctx.storage.put(COUNT_KEY, next);
    return next;
  }

  async reset() {
    await this.ctx.storage.delete(COUNT_KEY);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const counter = env.Counter.getByName("vite-do-fixture");

    if (url.pathname === "/api/count") {
      return Response.json({ count: await counter.increment() });
    }

    if (url.pathname === "/api/current") {
      return Response.json({ count: await counter.get() });
    }

    if (url.pathname === "/api/reset") {
      await counter.reset();
      return Response.json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};
