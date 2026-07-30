/// <reference types="@cloudflare/workers-types" />

/**
 * Plain (non-Effect) Cloudflare Worker that calls a service-binding RPC
 * method (`env.TARGET.greet(name)`) the same way any normal Cloudflare
 * Worker would.
 *
 * GET /?name=foo  →  responds with whatever the target returns ("hello foo"),
 * surfacing any error as a 500 with the message in the body so the test can
 * assert against it directly instead of spelunking worker logs.
 */
export default {
  async fetch(
    request: Request,
    env: {
      TARGET: Service & {
        greet: (name: string) => Promise<string>;
      };
    },
  ): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? "world";
    try {
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
