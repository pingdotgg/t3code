import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../PhysicalName.ts";
import type { ResourceBinding } from "../Resource.ts";
import type { FunctionBinding, FunctionProps } from "./Function.ts";

export class FunctionConfigurationError extends Data.TaggedError(
  "FunctionConfigurationError",
)<{ message: string; cause?: unknown }> {}

const injected = new Set([
  "NEON_API_KEY",
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "PGHOST",
  "PGHOST_UNPOOLED",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "NEON_AUTH_BASE_URL",
  "NEON_AUTH_URL",
  "NEON_AUTH_JWKS_URL",
  "NEON_DATA_API_URL",
  "NEON_AI_GATEWAY_TOKEN",
  "NEON_AI_GATEWAY_BASE_URL",
  "NEON_BRANCH",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "NEON_PROJECT_ID",
  "NEON_BRANCH_ID",
]);

const checkedSlug = Effect.fn(function* (id: string, slug?: string) {
  const value =
    slug ??
    (yield* createPhysicalName({
      id,
      maxLength: 20,
      delimiter: "",
      lowercase: true,
    })).replaceAll(/[^a-z0-9]/g, "");
  if (!/^[a-z0-9]{1,20}$/.test(value))
    return yield* new FunctionConfigurationError({
      message: "Function slug must match ^[a-z0-9]{1,20}$",
    });
  return value;
});

export function functionSlug(
  id: string,
  slug: string,
): Effect.Effect<string, FunctionConfigurationError>;
export function functionSlug(
  id: string,
  slug?: string,
): ReturnType<typeof checkedSlug>;
export function functionSlug(id: string, slug?: string) {
  return checkedSlug(id, slug);
}

export const functionEnvironment = Effect.fn(function* (
  props: FunctionProps,
  bindings: ResourceBinding<FunctionBinding>[],
) {
  const env: Record<string, string> = {};
  for (const source of [
    props.env ?? {},
    ...bindings.map((binding) => binding.data.env ?? {}),
  ]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      if (injected.has(key) || key.startsWith("ALCHEMY_"))
        return yield* new FunctionConfigurationError({
          message: `Cannot override injected Function environment key ${key}`,
        });
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        return yield* new FunctionConfigurationError({
          message: `Invalid Function environment key ${key}`,
        });
      const plain = Redacted.isRedacted(value) ? Redacted.value(value) : value;
      if (key in env && env[key] !== plain)
        return yield* new FunctionConfigurationError({
          message: `Conflicting Function environment key ${key}`,
        });
      env[key] = plain;
    }
  }
  return env;
});
