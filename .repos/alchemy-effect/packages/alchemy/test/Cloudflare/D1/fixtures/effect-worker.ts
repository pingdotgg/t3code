import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { TestDatabase } from "./database.ts";
import { d1Routes } from "./routes.ts";

/**
 * Effect-native Worker fixture. Binds the shared {@link TestDatabase} via
 * `Cloudflare.D1.QueryDatabase(...)` during Init (with `QueryDatabaseBinding`
 * provided to the worker effect) and delegates to the shared
 * {@link d1Routes}, stamping rows with `style = "effect"`.
 */
export default class D1EffectWorker extends Cloudflare.Worker<D1EffectWorker>()(
  "D1EffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const database = yield* TestDatabase;
    const db = yield* Cloudflare.D1.QueryDatabase(database);
    return {
      fetch: d1Routes(db, "effect"),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
