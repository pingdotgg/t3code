/// <reference types="@cloudflare/workers-types" />

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const TENANT_PROPS = { tenant: "acme" };

/** Fetch `/props` through a loopback stub; the host is irrelevant. */
const fetchProps = async (entrypoint: Fetcher) =>
  (await entrypoint.fetch("http://self/props")).text();

/** `ctx.exports`, keyed by entrypoint name (workerd types it per module). */
type Loopback = Record<
  string,
  ((options: { props: Record<string, unknown> }) => Fetcher) | undefined
>;

const echoProps = (props: unknown) => new Response(`props=${JSON.stringify(props ?? {})}`);

/** A named entrypoint: echoes the `ctx.props` its stub was minted with. */
export class Api extends WorkerEntrypoint {
  fetch() {
    return echoProps(this.ctx.props);
  }
}

/**
 * Durable Object that mints a stub to its host Worker's default entrypoint
 * with props via `this.ctx.exports`.
 */
export class AsyncPropsMinter extends DurableObject {
  async mint() {
    const exports = this.ctx.exports as unknown as Loopback;
    return fetchProps(exports.default!({ props: TENANT_PROPS }));
  }
}

interface Env {
  MINTER: DurableObjectNamespace<AsyncPropsMinter>;
}

/**
 * Async counterpart of `effect-worker.ts` for `WorkerEntrypoint.test.ts`.
 *
 * `GET /props` echoes `ctx.props`. `GET /mint` mints a `default` loopback
 * stub with props from the fetch handler and fetches `/props` through it;
 * `GET /mint-named` does the same through the named `Api` entrypoint;
 * `GET /mint-do` does it from a Durable Object. `GET /missing` looks up an
 * entrypoint the Worker does not export.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const exports = ctx.exports as unknown as Loopback;
    if (url.pathname === "/props") {
      return echoProps(ctx.props);
    }
    if (url.pathname === "/mint") {
      return new Response(
        `via-worker:${await fetchProps(exports.default!({ props: TENANT_PROPS }))}`,
      );
    }
    if (url.pathname === "/mint-named") {
      return new Response(`via-named:${await fetchProps(exports.Api!({ props: TENANT_PROPS }))}`);
    }
    if (url.pathname === "/mint-do") {
      return new Response(`via-do:${await env.MINTER.getByName("default").mint()}`);
    }
    if (url.pathname === "/missing") {
      return new Response(`${typeof exports.Missing}:Missing`);
    }
    return new Response("Not Found", { status: 404 });
  },
};
