import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { getSchema } from "better-auth/db";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Database, type DatabaseInput } from "./Database.ts";

/**
 * In-memory database layer for Better Auth — tests and throwaway dev
 * only. Data lives in the provided (or an internal) record for the
 * lifetime of the process/isolate; nothing is persisted and there is no
 * migration step (tables are seeded from the resolved auth schema).
 *
 *
 * ### Testing
 * **Example:** Unit-testing auth flows without a database
 * ```typescript
 * import { BetterAuth, Memory } from "@alchemy.run/better-auth";
 *
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({
 *     emailAndPassword: { enabled: true },
 *     secret: "test-secret",
 *   });
 *   const signUp = yield* auth.api.signUpEmail({
 *     body: { email: "a@b.co", password: "password1234", name: "A" },
 *   });
 * }).pipe(Effect.provide(Memory()))
 * ```
 *
 * @layer
 * @provides BetterAuth.Database
 * @product Memory
 */
export const Memory = (db?: MemoryDB): Layer.Layer<Database> =>
  Layer.effect(
    Database,
    Effect.sync(() => {
      // One backing store per layer instance — executions share it so data
      // survives across events within the same isolate/process. The memory
      // adapter throws "Model X not found" for absent tables (and its
      // transaction support `structuredClone`s the store, so no Proxy
      // tricks) — seed an empty array per model from the resolved schema
      // inside the adapter factory, which receives the full options.
      const store: MemoryDB = db ?? {};
      const adapter: DatabaseInput = (options) => {
        for (const modelName of Object.keys(getSchema(options))) {
          store[modelName] ??= [];
        }
        return memoryAdapter(store)(options);
      };
      return {
        provider: "sqlite",
        runtime: Effect.succeed(adapter),
      };
    }),
  );
