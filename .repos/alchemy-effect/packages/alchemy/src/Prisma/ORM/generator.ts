import type { SchemaOptions } from "./Schema.ts";

/** Optional outputs alongside Prisma's canonical contract artifacts. */
export interface EffectGeneratorOptions extends SchemaOptions {
  /** Emit the contract-bound Effect client factory. Defaults to true. */
  readonly client?: boolean;
  /** Emit standalone Effect row schemas. Defaults to true. */
  readonly schemas?: boolean;
}

export const effectGeneratorKey = Symbol.for("alchemy/Prisma/ORM/generator");

/**
 * Attach Effect generation to the ORM section of a Prisma configuration.
 * Run `alchemy prisma generate --config ./prisma.config.ts` to emit outputs.
 * Native Prisma commands continue to work and do not run this generator.
 *
 * ```typescript
 * export default definePrismaConfig({
 *   orm: withEffect(ormConfig({ contract: "./contract.psl", output: "./generated" }), {
 *     client: true,
 *     schemas: true,
 *   }),
 * });
 * ```
 */
export function withEffect<C extends object>(
  config: C,
  options: EffectGeneratorOptions = {},
): C & {
  readonly [effectGeneratorKey]: EffectGeneratorOptions;
} {
  return { ...config, [effectGeneratorKey]: options };
}
