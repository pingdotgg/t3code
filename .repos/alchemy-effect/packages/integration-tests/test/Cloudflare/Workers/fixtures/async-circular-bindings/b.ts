/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";
import type { BEnv } from "./stack.ts";

export default class B extends WorkerEntrypoint<BEnv> {
  async start(id: string): Promise<string> {
    return this.env.A_CALLBACKS.done(id);
  }

  async fetch(): Promise<Response> {
    return new Response("b");
  }
}
