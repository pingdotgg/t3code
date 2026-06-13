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
import { describe, expect, it } from "@effect/vitest";
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
      // We can't safely mutate `process.env[RPC_SERVER_ENVIRONMENT_KEY]`
      // from inside a concurrent test, so we install a private layer in
      // front of `fromEnv()` instead and verify it produces the same
      // Stack service that `layer()` does.
      process.env[RPC_SERVER_ENVIRONMENT_KEY] = JSON.stringify(sampleEnv);
      try {
        const stack = yield* Stack.pipe(
          Effect.provide(Layer.provide(fromEnv(), PlatformServices)),
        );
        expect(stack.name).toBe(sampleEnv.stack.name);
        expect(stack.stage).toBe(sampleEnv.stack.stage);
      } finally {
        delete process.env[RPC_SERVER_ENVIRONMENT_KEY];
      }
    }),
  );

  it("exports the canonical environment variable key", () => {
    expect(RPC_SERVER_ENVIRONMENT_KEY).toBe("ALCHEMY_RPC_SERVER_ENVIRONMENT");
  });
});
