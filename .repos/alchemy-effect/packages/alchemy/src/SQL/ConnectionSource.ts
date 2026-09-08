import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "../Output.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { sha256 } from "../Util/sha256.ts";

/**
 * A database connection-string source, in every shape alchemy hands them
 * out:
 *
 * - a literal / `Redacted` string
 * - a resource Output (Neon `project.connectionUri`, PlanetScale
 *   `role.connectionUrl`, Prisma `connection.databaseUrl`, ...) — bound
 *   into the host environment at deploy and read back at runtime
 * - a runtime-only Effect (Cloudflare Hyperdrive's per-invocation
 *   `connectionString`)
 */
export type ConnectionSource =
  | string
  | Redacted.Redacted<string>
  | Output.Output<string>
  | Output.Output<Redacted.Redacted<string>>
  | Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;

/**
 * The deploy-resolvable subset of {@link ConnectionSource}: literals and
 * resource Outputs. Runtime-only Effects (Hyperdrive) are excluded —
 * deploy-time consumers (migrations, seeds) need a value that resolves
 * during stack evaluation.
 */
export type StaticConnectionSource = Exclude<
  ConnectionSource,
  Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>
>;

const toRedacted = (
  value: string | Redacted.Redacted<string>,
): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/**
 * Resolve a {@link ConnectionSource} to its runtime accessor effect.
 *
 * Outputs are yielded NOW (binding into the host environment during a
 * host init, or recording an Action capture during an Action init) and
 * the returned accessor reads the resolved value back later; Effects pass
 * through untouched; literals wrap.
 */
export const resolveConnectionSource = (
  source: ConnectionSource,
): Effect.Effect<Effect.Effect<Redacted.Redacted<string>>> =>
  Effect.gen(function* () {
    if (Output.isOutput(source)) {
      const accessor = yield* source;
      return Effect.map(
        accessor as Effect.Effect<string | Redacted.Redacted<string>>,
        toRedacted,
      );
    }
    if (Effect.isEffect(source)) {
      return source as Effect.Effect<Redacted.Redacted<string>>;
    }
    return Effect.succeed(toRedacted(source));
  }) as Effect.Effect<Effect.Effect<Redacted.Redacted<string>>>;

/**
 * Pick the deploy-resolvable source for deploy-time work (migrations,
 * seeds): an explicit override wins, `false` disables, and the primary
 * source is a valid default only when it is itself deploy-resolvable.
 */
export const staticConnectionSource = (
  source: ConnectionSource,
  override: StaticConnectionSource | false | undefined,
): StaticConnectionSource | undefined => {
  if (override === false) {
    return undefined;
  }
  if (override !== undefined) {
    return override;
  }
  return Effect.isEffect(source) && !Output.isOutput(source)
    ? undefined
    : (source as StaticConnectionSource);
};

/**
 * Non-secret digest of a connection source — a sha256 Output suitable for
 * persisted identity inputs (e.g. a migration Action's diff key) where the
 * connection string itself must never be stored.
 */
export const connectionSourceDigest = (
  source: StaticConnectionSource,
): Output.Output<string> => {
  const digest = (value: string | Redacted.Redacted<string>) =>
    sha256(typeof value === "string" ? value : Redacted.value(value));
  return Output.isOutput(source)
    ? (Output.mapEffect(digest)(
        source as Output.Output<string | Redacted.Redacted<string>>,
      ) as Output.Output<string>)
    : (Output.fromEffect(digest(source)) as Output.Output<string>);
};
