import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { Db } from "./postgres-shared.ts";
import { Partition, Site } from "./suite-env.ts";

export { Db, Site };

/**
 * Async (non-Effect) canvas Function. Postgres is declared on `env` as a
 * string URI — Railway has no native bindings, so {@link Railway.InferEnv}
 * maps every key to `string`. The handler in `async-postgres.ts` reads
 * `env.DATABASE_URL` with plain `pg`.
 *
 * Props are an Effect so `Db` is yielded first and `connectionUri` is a
 * resolved Output (not a nested Effect that `toEnvRecord` would drop).
 */
export const PostgresFn = Railway.Function(
  "PostgresFn",
  Effect.gen(function* () {
    const db = yield* Db;
    return {
      project: Site,
      environment: Partition,
      main: pathe.resolve(import.meta.dirname, "async-postgres.ts"),
      env: {
        DATABASE_URL: db.connectionUri,
      },
      build: { install: ["pg"] },
    };
  }),
);

export type PostgresFnEnv = Railway.InferEnv<typeof PostgresFn>;
