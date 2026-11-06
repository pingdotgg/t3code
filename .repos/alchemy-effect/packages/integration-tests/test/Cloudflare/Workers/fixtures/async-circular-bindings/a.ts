/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";
import type { AEnv } from "./stack.ts";

/** Called back by B through its `A_CALLBACKS` binding. */
export class Callbacks extends WorkerEntrypoint<AEnv> {
  async done(id: string): Promise<string> {
    return `a got ${id}`;
  }
}

/** GET /?id=foo → B.start(id) → A's `Callbacks.done(id)`. */
export default {
  async fetch(request: Request, env: AEnv): Promise<Response> {
    const id = new URL(request.url).searchParams.get("id") ?? "1";
    return new Response(await env.B.start(id));
  },
} satisfies ExportedHandler<AEnv>;
