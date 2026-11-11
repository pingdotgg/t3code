import type * as Output from "alchemy/Output";
import { CurrentRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Env key carrying one field of a Neon resource into the host runtime.
 * Uppercase, so every host stores it verbatim (Prisma Compute uppercases
 * keys) and the runtime readers find it under the same name.
 */
export const backendEnvKey = (id: string, field: string) =>
  `NEON_BINDING_${Array.from(id, (char) => char.codePointAt(0)!.toString(16).toUpperCase()).join("_")}_${field}`;

type EnvValue = string | Redacted.Redacted<string>;

/**
 * Carry `env` into the hosting Function/Worker through its RuntimeContext:
 * env vars on Neon Functions, Lambda, Containers and Prisma Compute,
 * `plain_text`/`secret_text` bindings on Workers. Any Platform host works;
 * `Redacted` values stay secret. Read the values back at runtime with
 * {@link backendString} / {@link backendSecret}.
 */
export const bindBackendEnvironment = Effect.fn(function* (
  id: string,
  env: Record<string, Output.Output<EnvValue>>,
) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const runtime = yield* CurrentRuntimeContext;
  if (!runtime) {
    return yield* Effect.die(
      new Error(`${id}: Neon bindings must be bound while initializing a Function or Worker`),
    );
  }
  for (const [key, value] of Object.entries(env)) {
    const stored = yield* runtime.set(key, value);
    // The runtime readers look the value up by `key`, so a host that
    // rewrites keys would silently lose it.
    if (stored !== key) {
      return yield* Effect.die(
        new Error(`${id}: host ${runtime.Type} stored binding ${key} as ${stored}`),
      );
    }
  }
});

const backendValue = (key: string): Effect.Effect<EnvValue, never, RuntimeContext> =>
  RuntimeContext.pipe(
    Effect.flatMap((runtime) => runtime.get<EnvValue>(key)),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.die(new Error(`Neon binding ${key} is not set on this host`))
        : Effect.succeed(value),
    ),
  );

export const backendString = (key: string): Effect.Effect<string, never, RuntimeContext> =>
  backendValue(key).pipe(
    Effect.map((value) => (Redacted.isRedacted(value) ? Redacted.value(value) : value)),
  );

export const backendSecret = (
  key: string,
): Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext> =>
  backendValue(key).pipe(
    Effect.map((value) => (Redacted.isRedacted(value) ? value : Redacted.make(value))),
  );
