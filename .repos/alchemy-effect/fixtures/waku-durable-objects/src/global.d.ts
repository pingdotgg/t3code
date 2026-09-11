declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export const waitUntil: (promise: Promise<unknown>) => void;
  /** Minimal structural declaration for the fixture (no @cloudflare/workers-types in `types` to avoid DOM lib conflicts). */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: {
      storage: {
        sql: {
          exec(
            query: string,
            ...bindings: Array<unknown>
          ): {
            toArray(): Array<Record<string, unknown>>;
          };
        };
      };
    };
    protected env: Env;
    constructor(ctx: unknown, env: unknown);
  }
}

/**
 * The import seam for wrapping waku's server handler from a custom worker
 * entry: resolved by `makeWakuServerEntryPlugin` (injected by the waku
 * integration for every deploy target) to
 * `<wakuDirectory>/dist/lib/vite-entries/entry.server.js` (whose default
 * export is the adapter's ExportedHandler). See README.
 */
declare module "virtual:waku/server-entry" {
  const handler: {
    fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
  };
  export default handler;
}
