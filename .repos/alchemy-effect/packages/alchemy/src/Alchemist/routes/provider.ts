import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { EnvironmentVariable } from "../../Auth/AuthProvider.ts";
import { getEnv } from "../../Auth/Env.ts";
import { resolveProfileName } from "../../Auth/Resolve.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { AlchemistInvalidInput } from "../Errors.ts";
import {
  collectAuthProviders,
  DEFAULT_ENTRYPOINT,
  type Target,
} from "../Session.ts";

export interface CheckEnvironmentInput extends Target {
  /** Providers to check. Omitted means every registered provider. */
  readonly providers?: ReadonlyArray<string>;
}

export interface EnvironmentCheck {
  readonly provider: string;
  readonly status: "satisfied" | "missing" | "no-contract";
  readonly missing: ReadonlyArray<{
    readonly alternatives: ReadonlyArray<string>;
  }>;
}

export interface EnvironmentCheckResult {
  readonly checks: ReadonlyArray<EnvironmentCheck>;
  readonly satisfied: boolean;
}

const satisfied = (variable: EnvironmentVariable) =>
  Effect.gen(function* () {
    for (const name of [variable.name, ...(variable.alternatives ?? [])]) {
      const value = yield* getEnv(name);
      if (value !== undefined && value.length > 0) return true;
    }
    return false;
  });

/**
 * Verify the environment variables each registered provider's CI contract
 * requires are present.
 */
export const checkEnvironment = Effect.fn(
  "Alchemist.provider.checkEnvironment",
)(function* (input: CheckEnvironmentInput) {
  const profile = yield* resolveProfileName(
    Option.fromNullishOr(input.envFile),
    input.profile,
  );
  const registry = yield* collectAuthProviders({
    main: input.entrypoint ?? DEFAULT_ENTRYPOINT,
    envFile: Option.fromNullishOr(input.envFile),
    profile,
  });
  const known = Object.keys(registry).sort();
  const names = yield* input.providers?.length
    ? Effect.forEach(input.providers, (requested) => {
        const name = known.find(
          (candidate) => candidate.toLowerCase() === requested.toLowerCase(),
        );
        return name === undefined
          ? Effect.fail(
              new AlchemistInvalidInput({
                field: "providers",
                message: `Unknown provider '${requested}'. Registered: ${known.join(", ")}.`,
              }),
            )
          : Effect.succeed(name);
      })
    : Effect.succeed(known);
  const checks = yield* Effect.forEach(names, (name) =>
    Effect.gen(function* () {
      const contract = registry[name]!.environment;
      const missing: Array<{ alternatives: ReadonlyArray<string> }> = [];
      for (const variable of contract) {
        if (variable.required && !(yield* satisfied(variable))) {
          missing.push({
            alternatives: [variable.name, ...(variable.alternatives ?? [])],
          });
        }
      }
      return {
        provider: name,
        status:
          contract.length === 0
            ? ("no-contract" as const)
            : missing.length === 0
              ? ("satisfied" as const)
              : ("missing" as const),
        missing,
      } satisfies EnvironmentCheck;
    }),
  ).pipe(
    Effect.provide(
      ConfigProvider.layer(
        yield* loadConfigProvider(Option.fromNullishOr(input.envFile)),
      ),
    ),
  );
  return {
    checks,
    satisfied: checks.every((check) => check.status !== "missing"),
  } satisfies EnvironmentCheckResult;
});
