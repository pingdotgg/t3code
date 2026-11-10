import * as Neon from "@alchemy.run/neon";
import * as Effect from "effect/Effect";
import { resources } from "../resources.ts";

export const gateway = Effect.gen(function* () {
  const { branch } = yield* resources;
  return yield* Neon.AIGateway("Gateway", { branch });
});
