import * as Stripe from "@alchemy.run/stripe";
import { Credentials } from "@alchemy.run/stripe/Credentials";
import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider";
import * as Interaction from "alchemy/Interaction";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { v4 as uuidv4 } from "uuid";

it.live(
  "resolving Stripe credentials rejects an unknown explicit profile",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Effect.sandbox(
          Effect.gen(function* () {
            return yield* yield* Credentials;
          }).pipe(Effect.provide(Stripe.providers())),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("does not exist");
        expect(String(result.failure)).toContain("alchemy profile create");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          AuthProvidersLive,
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, { dev: false, adopt: false, dotAlchemy: ".alchemy" }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: `non-existent-${uuidv4()}` }),
          ),
          NodeServices.layer,
          FetchHttpClient.layer,
        ),
      ),
      Effect.provide(Interaction.layerNonInteractive()),
    ),
  { tags: ["unit", "provider:stripe", "local"] },
);
