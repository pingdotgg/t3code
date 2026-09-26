import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import type { Resource } from "../Resource.ts";
import { unpackEnvValue, type RuntimeContext } from "../RuntimeContext.ts";
import {
  ConnectPostgres,
  PostgresUrlMissing,
  connectEnvKeys,
  type ConnectPostgresClient,
} from "./ConnectPostgres.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import {
  DATABASE_URL_SECRET,
  DIRECT_DATABASE_URL_SECRET,
  type Postgres,
} from "./Postgres.ts";

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A>,
): Effect.Effect<A, never, RuntimeContext> =>
  output.bind(key).pipe(Effect.flatMap((effect) => effect));

const asRedactedUrl = (
  value: string,
  name: string,
): Effect.Effect<Redacted.Redacted<string>, PostgresUrlMissing> =>
  value.length > 0
    ? Effect.succeed(Redacted.make(value))
    : Effect.fail(new PostgresUrlMissing({ name }));

const fromProcessEnv = (key: string): string => {
  const unpacked = unpackEnvValue<unknown>(process.env[key]);
  if (typeof unpacked === "string") return unpacked;
  if (Redacted.isRedacted(unpacked)) {
    const inner = Redacted.value(unpacked);
    return typeof inner === "string" ? inner : "";
  }
  return "";
};

const firstUrl = (
  values: ReadonlyArray<string>,
  name: string,
): Effect.Effect<Redacted.Redacted<string>, PostgresUrlMissing> => {
  const found = values.find((value) => value.length > 0);
  return found !== undefined
    ? asRedactedUrl(found, name)
    : Effect.fail(new PostgresUrlMissing({ name }));
};

/**
 * Implementation of {@link ConnectPostgres}. Provide it on the
 * {@link Service} Effect.
 *
 * At deploy time this registers the cluster on the host so Service
 * reconcile can attach it (6PN) and pack the connection URI. At
 * runtime the client reads `process.env` (`FLY_POSTGRES_*`, then
 * Fly's `DATABASE_URL` secret).
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
 * @provides Fly.ConnectPostgres
 */
export const ConnectPostgresHttp = Layer.effect(
  ConnectPostgres,
  Effect.succeed(
    Effect.fn(function* (postgres: Postgres) {
      const keys = connectEnvKeys(postgres);
      const name = postgres.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          yield* host.bind`${postgres}`({
            postgres: { clusterId: postgres.clusterId },
            env: {
              [keys.pooled]: postgres.pooledConnectionUri,
              [keys.direct]: postgres.connectionUri,
            },
          });
        }
      }

      const fromEnv = (preferDirect: boolean) =>
        firstUrl(
          preferDirect
            ? [
                fromProcessEnv(keys.direct),
                fromProcessEnv(DIRECT_DATABASE_URL_SECRET),
                fromProcessEnv(keys.pooled),
                fromProcessEnv(DATABASE_URL_SECRET),
              ]
            : [
                fromProcessEnv(keys.pooled),
                fromProcessEnv(DATABASE_URL_SECRET),
                fromProcessEnv(keys.direct),
                fromProcessEnv(DIRECT_DATABASE_URL_SECRET),
              ],
          name,
        );

      if (globalThis.__ALCHEMY_RUNTIME__) {
        return {
          connectionString: fromEnv(false),
          directConnectionString: fromEnv(true),
        } satisfies ConnectPostgresClient;
      }

      const pooled = runtimeOutput(keys.pooled, postgres.pooledConnectionUri);
      const direct = runtimeOutput(keys.direct, postgres.connectionUri);

      return {
        connectionString: Effect.gen(function* () {
          const packed = yield* pooled;
          const unpacked = yield* direct;
          return yield* firstUrl(
            [
              typeof packed === "string" ? packed : "",
              fromProcessEnv(keys.pooled),
              fromProcessEnv(DATABASE_URL_SECRET),
              typeof unpacked === "string" ? unpacked : "",
              fromProcessEnv(keys.direct),
              fromProcessEnv(DIRECT_DATABASE_URL_SECRET),
            ],
            name,
          );
        }),
        directConnectionString: Effect.gen(function* () {
          const unpacked = yield* direct;
          const packed = yield* pooled;
          return yield* firstUrl(
            [
              typeof unpacked === "string" ? unpacked : "",
              fromProcessEnv(keys.direct),
              fromProcessEnv(DIRECT_DATABASE_URL_SECRET),
              typeof packed === "string" ? packed : "",
              fromProcessEnv(keys.pooled),
              fromProcessEnv(DATABASE_URL_SECRET),
            ],
            name,
          );
        }),
      } satisfies ConnectPostgresClient;
    }),
  ),
);
