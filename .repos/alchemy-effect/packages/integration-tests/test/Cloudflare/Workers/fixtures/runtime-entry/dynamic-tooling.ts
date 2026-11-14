import * as Effect from "effect/Effect";

export const localRuntime = Effect.promise(() => import("@alchemy.run/cloudflare/LocalRuntime"));
