import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  decodeManagedEndpointCleanupModeEnv,
  managedEndpointCleanupModeConfig,
  managedEndpointCleanupModeEnv,
} from "./Config.ts";

it.effect.each([
  { name: "missing", env: {}, expected: "off" },
  { name: "empty", env: { RELAY_TUNNEL_CLEANUP_MODE: "" }, expected: "off" },
  { name: "whitespace", env: { RELAY_TUNNEL_CLEANUP_MODE: "  \t" }, expected: "off" },
  { name: "off", env: { RELAY_TUNNEL_CLEANUP_MODE: "off" }, expected: "off" },
  {
    name: "dry-run",
    env: { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" },
    expected: "dry-run",
  },
  { name: "enabled", env: { RELAY_TUNNEL_CLEANUP_MODE: "enabled" }, expected: "enabled" },
] as const)("loads $name cleanup mode as $expected", ({ env, expected }) =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({ env });
    expect(yield* managedEndpointCleanupModeConfig.parse(provider)).toBe(expected);
  }),
);

it.effect("rejects an invalid cleanup mode", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: { RELAY_TUNNEL_CLEANUP_MODE: "delete-everything" },
    });
    const error = yield* Effect.flip(managedEndpointCleanupModeConfig.parse(provider));

    expect(error._tag).toBe("ConfigError");
    expect(error.message).toContain('Expected "off" | "dry-run" | "enabled"');
  }),
);

it.effect.each([
  { name: "missing", value: undefined, expected: "off" },
  { name: "blank", value: "  ", expected: "off" },
  { name: "dry-run", value: "dry-run", expected: "dry-run" },
  { name: "padded enabled", value: " enabled ", expected: "enabled" },
] as const)("decodes a $name cleanup mode binding as $expected", ({ value, expected }) =>
  Effect.gen(function* () {
    expect(yield* decodeManagedEndpointCleanupModeEnv(value)).toBe(expected);
  }),
);

it.effect("rejects an invalid cleanup mode binding", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(decodeManagedEndpointCleanupModeEnv("delete-everything"));
    expect(error._tag).toBe("SchemaError");
  }),
);

it.effect("declares the cleanup mode as a plain env binding", () =>
  Effect.gen(function* () {
    const env = yield* managedEndpointCleanupModeEnv.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { RELAY_TUNNEL_CLEANUP_MODE: "dry-run" } }),
      ),
    );
    // A plain string is what Alchemy lowers into a `plain_text` binding that
    // its Worker diff compares; a Redacted or Config value would not change it.
    expect(env).toEqual({ RELAY_TUNNEL_CLEANUP_MODE: "dry-run" });
  }),
);
