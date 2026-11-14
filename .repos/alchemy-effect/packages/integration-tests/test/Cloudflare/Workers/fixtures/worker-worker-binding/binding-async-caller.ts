/// <reference types="@cloudflare/workers-types" />

import { toRpcAsync } from "@alchemy.run/cloudflare/Workers/RpcAsync";
import type BindingTargetWorker from "./binding-target-worker.ts";

type TargetBinding = Service & {
  greet: (name: string) => Promise<string>;
};

/**
 * Hands a `toRpcAsync` view across an `await` boundary, the way a helper or
 * route loader that resolves the client would. If the view were a thenable,
 * the runtime would call `then` on it as an RPC and this would never settle.
 */
const resolveTarget = async (env: { TARGET: TargetBinding }) =>
  toRpcAsync<BindingTargetWorker>(env.TARGET);

const timeout = (ms: number) =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
  );

/**
 * Plain (non-Effect) Cloudflare Worker that calls a service-binding RPC
 * method (`env.TARGET.greet(name)`) the same way any normal Cloudflare
 * Worker would.
 *
 * GET /?name=foo  →  responds with whatever the target returns ("hello foo"),
 * surfacing any error as a 500 with the message in the body so the test can
 * assert against it directly instead of spelunking worker logs.
 *
 * GET /rpc-async?name=foo  →  the same call through a `toRpcAsync` view that
 * was returned from an `async` function.
 *
 * GET /self?name=foo  →  re-enters this Worker through its `SELF` binding.
 */
export default {
  async fetch(request: Request, env: { TARGET: TargetBinding; SELF: Service }): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "world";
    try {
      // `SELF` is `Cloudflare.Workers.Self`: a service binding to this
      // Worker's own default export. `/self` re-enters through it and the
      // inner request answers `/self-inner`.
      if (url.pathname === "/self") {
        const inner = await env.SELF.fetch(`https://self.internal/self-inner?name=${name}`);
        return new Response(`via self: ${await inner.text()}`, { status: inner.status });
      }
      if (url.pathname === "/self-inner") {
        return new Response(`inner ${name}`);
      }
      if (url.pathname === "/rpc-async") {
        const target = await Promise.race([resolveTarget(env), timeout(5_000)]);
        return new Response(String(await target.greet(name)));
      }
      console.log("async caller calling target");
      const greeting = await env.TARGET.greet(name);
      console.log("async caller got greeting", greeting);
      return new Response(String(greeting));
    } catch (err) {
      console.log("async caller failed", err);
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`async caller failed: ${message}`, { status: 500 });
    }
  },
};
