import * as PgClient from "@effect/sql-pg/PgClient";
import { env } from "cloudflare:workers";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

const services = Layer.mergeAll(
  ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromUnknown(env))),
  Reactivity.layer,
);

export const fetchSql = () =>
  Effect.gen(function* () {
    const url = yield* Config.redacted("TEST_POSTGRES_URL");
    const client = yield* PgClient.make({ url });
    const result = yield* client`SELECT 1`;
    return result;
  }).pipe(Effect.provide(services), Effect.scoped, Effect.runPromise);
