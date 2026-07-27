import { AlchemyContext } from "@/AlchemyContext.ts";
import {
  fromEnv,
  layer,
  RPC_SERVER_ENVIRONMENT_KEY,
  type RpcServerEnvironment,
} from "@/Local/RpcServerEnvironment.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const sampleEnv: RpcServerEnvironment = {
  profile: undefined,
  envFile: undefined,
  alchemyContext: {
    dotAlchemy: "/tmp/.alchemy",
    dev: true,
    adopt: false,
  },
  stack: {
    name: "my-stack",
    stage: "dev",
  },
};

describe("Local.RpcServerEnvironment", () => {
  it.effect("layer() provides Stack, Stage, and AlchemyContext", () =>
    Effect.gen(function* () {
      const observed = yield* Effect.gen(function* () {
        const stack = yield* Stack;
        const stage = yield* Stage;
        const ctx = yield* AlchemyContext;
        return { stack, stage, ctx };
      }).pipe(
        Effect.provide(Layer.provide(layer(sampleEnv), PlatformServices)),
      );

      expect(observed.stack.name).toBe("my-stack");
      expect(observed.stack.stage).toBe("dev");
      expect(observed.stage).toBe("dev");
      expect(observed.ctx.dotAlchemy).toBe("/tmp/.alchemy");
      expect(observed.ctx.dev).toBe(true);
    }),
  );

  it.effect("fromEnv() roundtrips a serialized RpcServerEnvironment", () =>
    Effect.gen(function* () {
      const environment = ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            [RPC_SERVER_ENVIRONMENT_KEY]: JSON.stringify(sampleEnv),
          },
        }),
      );
      const stack = yield* Stack.pipe(
        Effect.provide(
          Layer.provide(
            fromEnv(),
            Layer.mergeAll(PlatformServices, environment),
          ),
        ),
      );
      expect(stack.name).toBe(sampleEnv.stack.name);
      expect(stack.stage).toBe(sampleEnv.stack.stage);
    }),
  );

  it("exports the canonical environment variable key", () => {
    expect(RPC_SERVER_ENVIRONMENT_KEY).toBe("ALCHEMY_RPC_SERVER_ENVIRONMENT");
  });
});
