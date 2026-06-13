import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Schema, SchemaProvider } from "./Schema.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Drizzle",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build-time providers for managing Drizzle schemas as Alchemy resources.
 * Drizzle.Schema regenerates migration SQL via drizzle-kit's programmatic
 * API on every deploy when the source schema changes.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Drizzle from "alchemy/Drizzle";
 * import * as Neon from "alchemy/Neon";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Layer.mergeAll(
 *       Cloudflare.providers(),
 *       Drizzle.providers(),
 *       Neon.providers(),
 *     ),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const schema = yield* Drizzle.Schema("app-schema", {
 *       schema: "./src/schema.ts",
 *     });
 *     const project = yield* Neon.Project("app-db");
 *     const branch = yield* Neon.Branch("app-branch", {
 *       project,
 *       migrationsDir: schema.out,
 *     });
 *     return { branchId: branch.branchId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Schema])).pipe(
    Layer.provide(SchemaProvider()),
    Layer.orDie,
  );
