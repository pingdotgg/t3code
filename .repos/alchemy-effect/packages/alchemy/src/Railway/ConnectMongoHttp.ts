import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { unpackEnvValue, type RuntimeContext } from "../RuntimeContext.ts";
import {
  ConnectMongo,
  MongoUrlMissing,
  connectEnvKeys,
  type ConnectMongoClient,
} from "./ConnectMongo.ts";
import { isRailwayHost } from "./MountVolume.ts";
import {
  MONGO_URL_SECRET,
  MONGO_PUBLIC_URL_SECRET,
  type Mongo,
} from "./Mongo.ts";

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A>,
): Effect.Effect<A, never, RuntimeContext> =>
  output.bind(key).pipe(Effect.flatMap((effect) => effect));

const asRedactedUrl = (
  value: string,
  name: string,
): Effect.Effect<Redacted.Redacted<string>, MongoUrlMissing> =>
  value.length > 0
    ? Effect.succeed(Redacted.make(value))
    : Effect.fail(new MongoUrlMissing({ name }));

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
): Effect.Effect<Redacted.Redacted<string>, MongoUrlMissing> => {
  const found = values.find((value) => value.length > 0);
  return found !== undefined
    ? asRedactedUrl(found, name)
    : Effect.fail(new MongoUrlMissing({ name }));
};

/**
 * Implementation of {@link ConnectMongo}. Provide it on the
 * {@link Service} Effect.
 *
 * At deploy time this packs the private connection URI onto the host
 * (`RAILWAY_MONGO_*`, `MONGO_URL`). At runtime the client reads
 * `process.env`.
 *
 *
 * ### Provide the layer
 * **Example:** On a Service
 * ```typescript
 * Effect.gen(function* () {
 *   const conn = yield* Railway.ConnectMongo(Db);
 *   const url = yield* conn.connectionString;
 * }).pipe(Effect.provide(Railway.ConnectMongoHttp))
 * ```
 *
 * @layer
 * @provides Railway.ConnectMongo
 */
export const ConnectMongoHttp = Layer.effect(
  ConnectMongo,
  Effect.succeed(
    Effect.fn(function* (mongo: Mongo) {
      const keys = connectEnvKeys(mongo);
      const name = mongo.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRailwayHost(host)) {
          yield* host.bind`${mongo}`({
            env: {
              [keys.pooled]: mongo.connectionUri,
              [keys.direct]: mongo.connectionUri,
              [MONGO_URL_SECRET]: mongo.connectionUri,
            },
          });
        }
      }

      const fromEnv = (preferDirect: boolean) =>
        firstUrl(
          preferDirect
            ? [
                fromProcessEnv(keys.direct),
                fromProcessEnv(MONGO_URL_SECRET),
                fromProcessEnv(keys.pooled),
                fromProcessEnv(MONGO_PUBLIC_URL_SECRET),
              ]
            : [
                fromProcessEnv(keys.pooled),
                fromProcessEnv(MONGO_URL_SECRET),
                fromProcessEnv(keys.direct),
                fromProcessEnv(MONGO_PUBLIC_URL_SECRET),
              ],
          name,
        );

      if (globalThis.__ALCHEMY_RUNTIME__) {
        return {
          connectionString: fromEnv(false),
          directConnectionString: fromEnv(true),
        } satisfies ConnectMongoClient;
      }

      const pooled = runtimeOutput(keys.pooled, mongo.connectionUri);
      const direct = runtimeOutput(keys.direct, mongo.connectionUri);

      return {
        connectionString: Effect.gen(function* () {
          const packed = yield* pooled;
          const unpacked = yield* direct;
          return yield* firstUrl(
            [
              typeof packed === "string" ? packed : "",
              fromProcessEnv(keys.pooled),
              fromProcessEnv(MONGO_URL_SECRET),
              typeof unpacked === "string" ? unpacked : "",
              fromProcessEnv(keys.direct),
              fromProcessEnv(MONGO_PUBLIC_URL_SECRET),
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
              fromProcessEnv(MONGO_URL_SECRET),
              typeof packed === "string" ? packed : "",
              fromProcessEnv(keys.pooled),
              fromProcessEnv(MONGO_PUBLIC_URL_SECRET),
            ],
            name,
          );
        }),
      } satisfies ConnectMongoClient;
    }),
  ),
);
