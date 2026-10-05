import * as Neon from "alchemy/Neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { resources } from "../resources.ts";
import LayerApiLive, { LayerApi } from "./LayerApi.ts";

export const forms = Effect.gen(function* () {
  const { branch } = yield* resources;
  const native = yield* Neon.Function("NativeSql", {
    branch,
    main: "./src/forms/native.ts",
    env: { APP_TOKEN: yield* Config.Redacted("APP_TOKEN") },
  });
  const bare = yield* Neon.Function("Bare", {
    branch,
    main: "./src/forms/bare.ts",
  });
  const hono = yield* Neon.Function("Hono", {
    branch,
    main: "./src/forms/hono.ts",
  });
  const layer = yield* LayerApi.pipe(Effect.provide(LayerApiLive));
  return {
    nativeUrl: native.url,
    bareUrl: bare.url,
    honoUrl: hono.url,
    layerUrl: layer.url,
  };
});
