import type { AsyncWorkerEnv } from "./stack.ts";

/**
 * Async (non-Effect) Worker fixture for the Cloudflare Hyperdrive binding
 * declared via `env: { HD: connection }`. `InferEnv` maps the
 * `Hyperdrive.Connection` resource to the native runtime `Hyperdrive`
 * binding, so the handler reads `env.HD.host` / `.port` / `.user` /
 * `.database` / `.connectionString` directly.
 *
 * The runtime connection string / password are valid only within the
 * current invocation, so the handler reports their *shape* (non-empty,
 * parseable URI) rather than echoing secret material over the wire.
 */
export default {
  async fetch(request: Request, env: AsyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/meta") {
      const hd = env.HD;
      const connectionString = hd.connectionString;
      const parsed = new URL(connectionString);
      return Response.json({
        mode: "async",
        host: hd.host,
        port: hd.port,
        user: hd.user,
        database: hd.database,
        hasConnectionString: connectionString.length > 0,
        hasPassword: hd.password.length > 0,
        connectionStringProtocol: parsed.protocol,
        connectionStringHost: parsed.hostname,
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
