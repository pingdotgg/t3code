/// <reference types="@cloudflare/workers-types" />

/**
 * Plain (non-Effect) Worker exposing a NAMED entrypoint alongside its
 * default handler. workerd treats every named class export of an entry
 * module as an entrypoint; `Api` is only reachable through a service
 * binding that names it — the default entrypoint has no `greet`, so a
 * caller succeeding proves the binding targeted the named class.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

export class Api extends WorkerEntrypoint<unknown, Record<string, unknown>> {
  async greet(name: string): Promise<string> {
    return `hello ${name} from Api`;
  }

  /** Echoes the binding's `ctx.props` so callers can assert delivery. */
  async getProps(): Promise<Record<string, unknown>> {
    return this.ctx.props ?? {};
  }
}

/**
 * `SELF` is `Cloudflare.WorkerEntrypoint<Api>({ entrypoint: "Api", props })`:
 * this Worker's own `Api` entrypoint, bound by name.
 *
 * GET /self-greet?name=foo  →  `Api.greet(name)` through the self binding
 * GET /self-props           →  JSON of `Api`'s `ctx.props` via the self binding
 * GET /self-default         →  this Worker's default export through
 *                              `Cloudflare.WorkerEntrypoint()` (`SELF_DEFAULT`)
 */
export default {
  async fetch(
    request: Request,
    env: { SELF: Service<Api>; SELF_DEFAULT: Service },
  ): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/self-greet") {
        return new Response(await env.SELF.greet(url.searchParams.get("name") ?? "world"));
      }
      if (url.pathname === "/self-default") {
        const inner = await env.SELF_DEFAULT.fetch("https://self.internal/");
        return new Response(`via self default: ${await inner.text()}`, { status: inner.status });
      }
      if (url.pathname === "/self-props") {
        return Response.json(await env.SELF.getProps());
      }
      return new Response("hello from EntrypointTargetWorker");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`target failed: ${message}`, { status: 500 });
    }
  },
};
