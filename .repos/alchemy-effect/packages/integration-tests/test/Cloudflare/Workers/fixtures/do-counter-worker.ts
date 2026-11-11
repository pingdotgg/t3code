import { DurableObject } from "cloudflare:workers";

// Minimal async (non-Effect) Worker that hosts Durable Object classes.
// Used by the `durableObjectNamespaces` stability tests: deploying with a DO
// binding populates `worker.durableObjectNamespaces.<ClassName>` with the
// namespace id Cloudflare assigns, which a downstream resource then references.
export class Counter extends DurableObject {
  async increment() {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return count;
  }
}

export class Meter extends DurableObject {
  async read() {
    return (await this.ctx.storage.get<number>("value")) ?? 0;
  }
}

export default {
  // The DOs only need to be *hosted* (declared + class exported) to populate
  // `worker.durableObjectNamespaces`; the fetch handler intentionally doesn't
  // invoke them so the webhook's live URL probe always gets a clean 200.
  fetch: async () => new Response("ok"),
};
