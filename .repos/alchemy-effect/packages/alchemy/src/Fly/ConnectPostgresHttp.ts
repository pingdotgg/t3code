import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import {
  ConnectPostgres,
  PostgresUrlMissing,
  type ConnectPostgresClient,
} from "./ConnectPostgres.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import { type Postgres } from "./Postgres.ts";

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const asRedactedUrl = (
  value: unknown,
  name: string,
): Effect.Effect<Redacted.Redacted<string>, PostgresUrlMissing> => {
  const plain =
    typeof value === "string"
      ? value
      : Redacted.isRedacted(value)
        ? Redacted.value(value)
        : "";
  const url = typeof plain === "string" ? plain : "";
  return url.length > 0
    ? Effect.succeed(Redacted.make(url))
    : Effect.fail(new PostgresUrlMissing({ name }));
};

/**
 * Implementation of {@link ConnectPostgres}. Provide it on the
 * {@link Service} Effect.
 *
 * Registers the cluster attachment for Fly's private network. Alchemy
 * transports each cluster's connection URIs through resource Outputs,
 * so callers do not configure connection-string environment variables.
 *
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const conn = yield* Fly.ConnectPostgres(Db);
 *   const db = yield* Drizzle.Postgres(conn.connectionString);
 * }).pipe(Effect.provide(Fly.ConnectPostgresHttp))
 * ```
 *
 * @layer
 * @product Postgres
 * @provides Fly.ConnectPostgres
 */
export const ConnectPostgresHttp = Layer.effect(
  ConnectPostgres,
  Effect.succeed(
    Effect.fn(function* (postgres: Postgres) {
      const name = postgres.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${postgres}`({
            postgres: { clusterId: postgres.clusterId },
          });
        }
      }

      const pooled = yield* postgres.pooledConnectionUri;
      const direct = yield* postgres.connectionUri;

      return {
        connectionString: pooled.pipe(
          Effect.flatMap((value) => asRedactedUrl(value, name)),
        ),
        directConnectionString: direct.pipe(
          Effect.flatMap((value) => asRedactedUrl(value, name)),
        ),
      } satisfies ConnectPostgresClient;
    }),
  ),
);
