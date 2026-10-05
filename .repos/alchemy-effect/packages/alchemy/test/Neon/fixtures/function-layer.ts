import { Function } from "@/Neon/Function";
import { InvokeFunction } from "@/Neon/InvokeFunction";
import { InvokeFunctionHttp } from "@/Neon/InvokeFunctionHttp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Constructor from "./function-constructor.ts";
import { project } from "./function-form-resources.ts";
export class LayerFunction extends Function<LayerFunction>()("LayerFunction") {}
export default LayerFunction.make(
  Effect.gen(function* () {
    return { project: yield* project, main: import.meta.url };
  }),
  Effect.gen(function* () {
    const invoke = yield* InvokeFunction(yield* Constructor);
    return {
      fetch: Effect.gen(function* () {
        const response = yield* invoke.fetch().pipe(Effect.orDie);
        const text = yield* Effect.tryPromise(() => response.text()).pipe(
          Effect.orDie,
        );
        return HttpServerResponse.text(`layer:${text}`);
      }),
    };
  }).pipe(Effect.provide(InvokeFunctionHttp)),
);
