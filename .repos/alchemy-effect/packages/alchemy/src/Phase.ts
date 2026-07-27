import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

declare global {
  /**
   * Build-time flag marking the runtime (post-bundle) phase.
   *
   * The bundler folds this to `true` in every runtime artifact (see
   * `ALCHEMY_DEFINE` in `Bundle/Bundle.ts`), so plan-only code guarded by
   * `if (!globalThis.__ALCHEMY_RUNTIME__)` is dead-code-eliminated from deployed
   * Workers/Lambdas/Containers.
   *
   * When running source directly with bun/node (no bundler) it is `undefined`
   * (falsy), so plan-only branches run. Reading it never throws because it is a
   * property access on `globalThis`.
   */
  var __ALCHEMY_RUNTIME__: boolean | undefined;
}

export type AlchemyPhase = "plan" | "runtime";

export const ALCHEMY_PHASE = Config.string("ALCHEMY_PHASE").pipe(
  Config.withDefault("plan"),
  Config.mapOrFail((value) => {
    if (value !== "plan" && value !== "runtime") {
      return Effect.die(new Error(`Invalid ALCHEMY_PHASE: ${value}`));
    }
    return Effect.succeed(value as AlchemyPhase);
  }),
  Effect.orDie,
);

/**
 * Whether the program is running under `alchemy dev` (local development with
 * hot reload), exposed as the `ALCHEMY_DEV` environment variable / config key.
 *
 * The `alchemy dev` CLI command sets `ALCHEMY_DEV=true` on the spawned process;
 * every other entrypoint (`deploy`, `plan`, deployed runtime) leaves it unset,
 * so it defaults to `false`. Accepts the usual truthy strings (`true`, `1`,
 * `yes`, `on`).
 *
 * Read it from user code to branch on dev mode:
 *
 * ```typescript
 * import { ALCHEMY_DEV } from "alchemy";
 *
 * Effect.gen(function* () {
 *   if (yield* ALCHEMY_DEV) {
 *     // local-dev-only behavior
 *   }
 * });
 * ```
 */
export const ALCHEMY_DEV = Config.boolean("ALCHEMY_DEV").pipe(
  Config.withDefault(false),
);
