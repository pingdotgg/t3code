/**
 * The user's own worker entry, deployed via `Website.Waku`'s `main` prop
 * (the user-entry seam: framework-core `DeployTarget.entry`, carried by
 * the waku cloudflare target's `main` config).
 *
 * It wraps waku's emitted fetch handler — imported from the stable
 * `virtual:waku/server-entry` seam, so every framework route still works —
 * and ADDITIONALLY exports the `Counter` Durable Object class, which must
 * live on the same worker for the `COUNTER` namespace binding to resolve.
 * Mirrors `Website.Vite`'s custom-entry pattern (vite-do-fixture).
 */
import { DurableObject } from "cloudflare:workers";
import wakuHandler from "virtual:waku/server-entry";

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
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const url = new URL(request.url);
    const counter = env.COUNTER.getByName("waku-custom-entry");

    if (url.pathname === "/api/entry") {
      return Response.json({ entry: "worker-entry" });
    }

    if (url.pathname === "/api/counter/increment") {
      return Response.json({ count: await counter.increment() });
    }

    if (url.pathname === "/api/counter") {
      return Response.json({ count: await counter.get() });
    }

    return wakuHandler.fetch(request, env, ctx);
  },
};
