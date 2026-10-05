import * as Neon from "alchemy/Neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { resources } from "../resources.ts";
import EffectApi from "./EffectApi.ts";
import { gateway } from "./resources.ts";

export const ai = Effect.gen(function* () {
  const { branch } = yield* resources;
  const backend = yield* gateway;
  const native = yield* Neon.Function("NativeAI", {
    branch,
    main: "./src/ai/native.ts",
    env: {
      EXAMPLE_API_KEY: yield* Config.Redacted("NEON_EXAMPLE_API_KEY"),
      AI_MODEL: yield* Config.String("NEON_AI_MODEL"),
      AI_ALLOW_PAID: yield* Config.String("NEON_AI_ALLOW_PAID").pipe(
        Config.withDefault("false"),
      ),
    },
  });
  const effect = yield* EffectApi;
  return {
    nativeUrl: native.url,
    effectUrl: effect.url,
    gatewayUrl: backend.baseUrl,
  };
});
