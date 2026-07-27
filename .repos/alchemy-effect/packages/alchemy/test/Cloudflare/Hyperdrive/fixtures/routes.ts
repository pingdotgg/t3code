import type { ConnectClient } from "@/Cloudflare/Hyperdrive/Connect.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared routes exercised by the effect-worker fixture so every member of
 * {@link ConnectClient} (`host`, `port`, `user`, `database`,
 * `connectionString`, `raw`) is driven over `fetch`. Returns `undefined`
 * when the path is not a known route so the caller can fall through.
 *
 * The runtime password / connection string are valid only within the
 * current Worker invocation, so the route reports their *shape*
 * (non-empty, parseable URL) rather than echoing secret material.
 */
export const connectionRoutes = (hd: ConnectClient, url: URL) =>
  Effect.gen(function* () {
    if (url.pathname === "/meta") {
      const host = yield* hd.host;
      const port = yield* hd.port;
      const user = yield* hd.user;
      const database = yield* hd.database;
      const connectionString = Redacted.value(yield* hd.connectionString);
      const password = Redacted.value(yield* hd.password);
      // Parse the connection string so we prove it is a real, well-formed
      // URI rather than echoing the secret back to the test.
      const parsed = new URL(connectionString);
      return yield* HttpServerResponse.json({
        host,
        port,
        user,
        database,
        // Booleans only — never leak the runtime secret over the wire.
        hasConnectionString: connectionString.length > 0,
        hasPassword: password.length > 0,
        connectionStringProtocol: parsed.protocol,
        connectionStringHost: parsed.hostname,
      });
    }
    if (url.pathname === "/raw") {
      // `raw` is the escape hatch driver libraries use. Prove it resolves
      // to the runtime Hyperdrive object exposing the same host.
      const raw = yield* hd.raw;
      return yield* HttpServerResponse.json({
        host: raw.host,
        port: raw.port,
        user: raw.user,
        database: raw.database,
      });
    }
    return undefined;
  });
