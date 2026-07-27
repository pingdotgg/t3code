import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { type Db, MongoClient, type MongoClientOptions } from "mongodb";
import { makeExecutionMemo } from "../../Runtime/ExecutionMemo.ts";
import type { MongoConnectionInfo } from "./Connect.ts";

/** A failure raised by the underlying `mongodb` driver. */
export class MongoError extends Data.TaggedError("AWS.DocDB.MongoError")<{
  cause: unknown;
}> {
  override get message() {
    return String(this.cause);
  }
}

/**
 * A connected, Effect-typed MongoDB client over a DocumentDB cluster. Built
 * at most once per execution (Lambda invoke, Worker event) and closed when
 * the execution settles — see {@link mongo}.
 */
export interface MongoClusterClient {
  /** The connected native `mongodb` driver client. */
  readonly client: MongoClient;
  /**
   * The default database — from {@link MongoOptions.database}, the
   * connection info's `database`, or the cluster's default.
   */
  readonly db: Db;
  /**
   * Run a promise-returning function against the client as a typed Effect —
   * driver rejections surface as {@link MongoError}.
   */
  readonly use: <T>(
    fn: (db: Db, client: MongoClient) => Promise<T>,
  ) => Effect.Effect<T, MongoError>;
}

export interface MongoOptions {
  /** Database to select (overrides the connection info's `database`). */
  database?: string;
  /**
   * PEM bundle of the Amazon RDS CA (`global-bundle.pem` from
   * `truststore.pki.rds.amazonaws.com`). When provided, full TLS identity
   * verification is enabled; without it the connection encrypts but does not
   * verify the server certificate (DocumentDB certs chain to a private CA
   * absent from Node's trust store).
   */
  ca?: string;
  /** Extra options passed through to the `mongodb` driver. */
  clientOptions?: MongoClientOptions;
}

/**
 * Open an Effect-typed MongoDB client from a DocumentDB connection (the
 * runtime Effect produced by binding `AWS.DocDB.Connect`).
 *
 * The connect work is deferred until first use and memoized on the current
 * execution's `Scope` (via `makeExecutionMemo`), so the driver connection is
 * built at most once per execution — a Lambda invocation or Worker event —
 * and its `close` finalizer fires when the execution settles, never held
 * across events. This is the one legal pooling shape on workerd (sockets are
 * IoContext-pinned) and the correct one on Lambda.
 *
 * DocumentDB authenticates over the MongoDB wire protocol: database users
 * and their built-in roles (`read`, `readWrite`, `dbAdmin`,
 * `clusterAdmin`, …) are managed *inside* the database with
 * `db.createUser(...)` — IAM only governs the management plane.
 * @binding
 * @section Connecting to a Cluster
 * @example Query a Collection inside a Function
 * ```typescript
 * // init — bind the cluster, then build the client
 * const connect = yield* AWS.DocDB.Connect(cluster, { database: "app" });
 * const db = yield* AWS.DocDB.mongo(connect);
 *
 * // runtime — one driver connection per execution, closed on settle
 * const { use } = yield* db;
 * const open = yield* use((db) =>
 *   db.collection("orders").find({ open: true }).toArray(),
 * );
 * ```
 *
 * @example Create a Database User (DB-plane auth)
 * ```typescript
 * const { use } = yield* db;
 * yield* use((db) =>
 *   db.admin().command({
 *     createUser: "reporting",
 *     pwd: reportingPassword,
 *     roles: [{ role: "read", db: "app" }],
 *   }),
 * );
 * ```
 */
export const mongo = <E, R>(
  connection: Effect.Effect<MongoConnectionInfo, E, R>,
  options?: MongoOptions,
) =>
  makeExecutionMemo(
    Effect.gen(function* () {
      const info = yield* connection;
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            new MongoClient(Redacted.value(info.url), {
              ...(options?.ca !== undefined
                ? // A caller-supplied CA restores full identity verification
                  // (overriding the URL's tlsAllowInvalidCertificates).
                  { ca: options.ca, tlsAllowInvalidCertificates: false }
                : {}),
              ...options?.clientOptions,
            }).connect(),
          catch: (cause) => new MongoError({ cause }),
        }),
        (client) => Effect.promise(() => client.close().catch(() => {})),
      );
      const db = client.db(options?.database ?? info.database);
      const use = <T>(fn: (db: Db, client: MongoClient) => Promise<T>) =>
        Effect.tryPromise({
          try: () => fn(db, client),
          catch: (cause) => new MongoError({ cause }),
        });
      return { client, db, use } satisfies MongoClusterClient;
    }),
  );
