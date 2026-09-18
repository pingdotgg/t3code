import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "creates a logical restricted key with default props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Stripe.RestrictedApiKey("HostToken");
          yield* token.bind("RetrieveProduct", {
            permissions: ["products_read"],
          });
          return token;
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.name).toEqual(expect.any(String));
      expect(Redacted.isRedacted(created.value)).toEqual(true);
      expect(created.permissions).toEqual(["products_read"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "creates a logical restricted key and merges bound permissions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Stripe.RestrictedApiKey("HostToken", {
            permissions: ["customers_read"],
          });
          yield* token.bind("RetrieveProduct", {
            permissions: ["products_read"],
          });
          return token;
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.name).toEqual(expect.any(String));
      expect(Redacted.isRedacted(created.value)).toEqual(true);
      expect(created.permissions).toEqual(["customers_read", "products_read"]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const token = yield* Stripe.RestrictedApiKey("HostToken", {
            permissions: ["customers_read", "customers_write"],
          });
          yield* token.bind("RetrieveProduct", {
            permissions: ["products_read"],
          });
          return token;
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.permissions).toEqual([
        "customers_read",
        "customers_write",
        "products_read",
      ]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
