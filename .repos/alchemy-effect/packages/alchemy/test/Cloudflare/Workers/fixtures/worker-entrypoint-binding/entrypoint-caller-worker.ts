/// <reference types="@cloudflare/workers-types" />

/**
 * Plain (non-Effect) Worker whose `API` binding was declared with
 * `Cloudflare.WorkerEntrypoint(target, { entrypoint: "Api", props })`.
 *
 * GET /greet?name=foo  →  target's `Api.greet(name)` through the binding
 * GET /props           →  JSON of the target's `ctx.props` (delivery probe)
 *
 * Errors surface as a 500 with the message in the body so the test can
 * assert against it directly.
 */
export default {
  async fetch(
    request: Request,
    env: {
      API: Service & {
        greet: (name: string) => Promise<string>;
        getProps: () => Promise<Record<string, unknown>>;
      };
    },
  ): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/greet") {
        const name = url.searchParams.get("name") ?? "world";
        return new Response(await env.API.greet(name));
      }
      if (url.pathname === "/props") {
        return Response.json(await env.API.getProps());
      }
      return new Response("caller up");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`caller failed: ${message}`, { status: 500 });
    }
  },
};
