/**
 * The user's own worker entry, deployed via `Website.Astro`'s `main` prop.
 *
 * It wraps Astro's handler — imported from the vendored server entrypoint,
 * so every Astro route still works — and ADDITIONALLY exports the `Counter`
 * Durable Object class, which must live on the same worker for the
 * `COUNTER` namespace binding to resolve. Mirrors the Waku and Vite
 * custom-entry fixtures.
 */
import handler from "@alchemy.run/frontend-frameworks/astro/entrypoints/server";
import { DurableObject } from "cloudflare:workers";

const COUNT_KEY = "count";

type CounterStub = {
  get(): Promise<number>;
  increment(): Promise<number>;
};

type Env = {
  COUNTER: {
    getByName(name: string): CounterStub;
  };
};

/** A Durable Object owned by the user app, not the framework. */
export class Counter extends DurableObject {
  async get() {
    return (await this.ctx.storage.get<number>(COUNT_KEY)) ?? 0;
  }

  async increment() {
    const next = (await this.get()) + 1;
    await this.ctx.storage.put(COUNT_KEY, next);
    return next;
  }
}

export default {
  ...handler,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const counter = env.COUNTER.getByName("astro-custom-entry");

    if (url.pathname === "/api/entry") {
      return Response.json({ entry: "worker-entry" });
    }

    if (url.pathname === "/api/counter/increment") {
      return Response.json({ count: await counter.increment() });
    }

    if (url.pathname === "/api/counter") {
      return Response.json({ count: await counter.get() });
    }

    return handler.fetch(request as never, env as never, ctx);
  },
};
