/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

// Plain-JS Durable Object host. `received` echoes exactly the arguments the
// runtime delivered, so a caller can tell if anything was appended to them.
export class RestArgs extends DurableObject {
  async received(...args: unknown[]) {
    return args;
  }
}

export default {
  fetch: async () => new Response("ok"),
};
