import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { resources } from "../resources.ts";

export class LayerApi extends Neon.Function<LayerApi>()("LayerApi") {}

export default LayerApi.make(
  Effect.gen(function* () {
    const { branch } = yield* resources;
    return { branch, main: import.meta.url };
  }),
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("Layer implementation")),
  }),
);
