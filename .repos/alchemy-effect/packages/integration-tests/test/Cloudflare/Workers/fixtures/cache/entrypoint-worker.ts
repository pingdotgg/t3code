import type * as cf from "@cloudflare/workers-types";
import { WorkerEntrypoint } from "cloudflare:workers";

/** The loopback `ctx.exports` entrypoint this module defines. */
interface EntrypointExports {
  Public: cf.Fetcher;
}

/** A cacheable entrypoint stamping each invocation with a fresh id. */
export class Public extends WorkerEntrypoint {
  override async fetch() {
    return new Response(`pub:${crypto.randomUUID()}`, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }
}

/** Gateway: stamps its own id and forwards to `Public` via `ctx.exports`. */
export default {
  async fetch(request: Request, _env: unknown, ctx: cf.ExecutionContext) {
    const exports = ctx.exports as unknown as EntrypointExports;
    const inner = await exports.Public.fetch(request.url);
    return new Response(`gw:${crypto.randomUUID()}|${await inner.text()}`, {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  },
};
