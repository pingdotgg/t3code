import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Connection } from "./Connection.ts";

/**
 * A typed accessor for a Cloudflare Hyperdrive runtime binding inside a
 * Worker. Provides the same shape as the raw `Hyperdrive` runtime object
 * (connection string, host, port, user, password, database) plus a `raw`
 * escape hatch for libraries that want direct access.
 *
 * @example Bind Hyperdrive in a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(MyConnection);
 * const url = yield* hd.connectionString;
 * ```
 *
 * @binding
 * @product Hyperdrive
 * @category Storage & Databases
 */
/**
 * Bind a {@link Connection} to a Worker and obtain the Effect-native
 * Hyperdrive client (connection string, host, port, …).
 *
 * `Connect` is a single identifier that is simultaneously the binding's Context
 * tag, its type, and the callable — `yield* Cloudflare.Hyperdrive.Connect(conn)`.
 *
 * @example Using Hyperdrive inside a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(MyConnection);
 * const url = yield* hd.connectionString;
 * ```
 *
 * @binding
 * @product Hyperdrive
 * @category Storage & Databases
 */
export interface Connect extends Binding.Service<
  Connect,
  "Cloudflare.Hyperdrive.Connect",
  (connection: Connection) => Effect.Effect<ConnectClient>
> {}

export const Connect = Binding.Service<Connect>(
  "Cloudflare.Hyperdrive.Connect",
);

export interface ConnectClient {
  /**
   * The raw runtime `Hyperdrive` binding. Use this when integrating with a
   * driver that wants direct access to the Cloudflare object.
   */
  raw: Effect.Effect<runtime.Hyperdrive, never, RuntimeContext>;
  /**
   * A valid DB connection string for use with a driver/ORM.
   */
  connectionString: Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  >;
  /**
   * Hostname valid only within the current Worker invocation.
   */
  host: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Port to pair with `host`.
   */
  port: Effect.Effect<number, never, RuntimeContext>;
  /**
   * Database user.
   */
  user: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Randomly generated password valid only within the current Worker
   * invocation.
   */
  password: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
  /**
   * Database name.
   */
  database: Effect.Effect<string, never, RuntimeContext>;
}
