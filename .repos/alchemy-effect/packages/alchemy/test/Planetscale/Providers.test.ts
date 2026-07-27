import { AlchemyContext } from "@/AlchemyContext.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as Planetscale from "@/Planetscale";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { v4 as uuidv4 } from "uuid";

it.live(
  "building the Planetscale provider layers should not fail for unknown profile",
  () =>
    Effect.gen(function* () {
      yield* Layer.build(Planetscale.providers());
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, {}),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: false,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              ALCHEMY_PROFILE: `non-existent-${uuidv4()}`,
            }),
          ),
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        ),
      ),
      Effect.scoped,
    ),
);
