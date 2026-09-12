import {
  getEnv,
  getEnvRedacted,
  getEnvRedactedRequired,
  getEnvRequired,
  mapPromptCancellation,
} from "@/Auth/Env.ts";
import { AuthError } from "@/Auth/AuthProvider.ts";
import { TerminalCancelled } from "@/Cli/CliKit/index.ts";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const provideConfig = (values: Record<string, unknown>) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(values),
  );

it.effect("reads optional environment configuration", () =>
  Effect.gen(function* () {
    expect(yield* getEnv("PRESENT")).toBe("value");
    expect(yield* getEnv("MISSING")).toBeUndefined();
  }).pipe(provideConfig({ PRESENT: "value" })),
);

it.effect("preserves the configuration error as the cause of AuthError", () =>
  getEnvRequired("MISSING").pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error).toBeInstanceOf(AuthError);
        expect(error.message).toBe("Missing required env: MISSING");
        expect(error.cause).toBeDefined();
      }),
    ),
    provideConfig({}),
  ),
);

it.effect("handles optional and required redacted configuration", () =>
  Effect.gen(function* () {
    const present = yield* getEnvRedactedRequired("SECRET");
    expect(Redacted.value(present)).toBe("secret");
    expect(yield* getEnvRedacted("MISSING")).toBeUndefined();
  }).pipe(provideConfig({ SECRET: "secret" })),
);

it.effect("maps prompt cancellation without retrying the prompt", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const error = yield* mapPromptCancellation(
      Effect.suspend(() => {
        attempts++;
        return Effect.fail(new TerminalCancelled());
      }),
    ).pipe(Effect.flip);

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(AuthError);
    expect(error.cause).toBeInstanceOf(TerminalCancelled);
  }),
);
