import type { HttpEffect } from "alchemy/Http";
import * as Output from "alchemy/Output";
import {
  packEnvValueKeepRedacted,
  unpackEnvValue,
  type BaseRuntimeContext,
} from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { FunctionEnvironment, type FunctionRequest } from "./FunctionEnvironment.ts";

export interface FunctionRuntimeContext extends BaseRuntimeContext {
  /** Register a request route during init. More specific routes precede the default handler. */
  route(path: string, handler: HttpEffect<FunctionRequest>): Effect.Effect<void>;
  /** Request dispatcher and the services captured at init. */
  handler: Effect.Effect<{
    dispatch: (path: string) => HttpEffect<FunctionRequest>;
    context: Context.Context<never>;
  }>;
}

export const makeFunctionRuntimeContext = (id: string): FunctionRuntimeContext => {
  const env: Record<string, Output.Output> = {};
  const routes = new Map<string, HttpEffect<FunctionRequest>>();
  let handler: HttpEffect = Effect.succeed(HttpServerResponse.empty({ status: 404 }));
  let context = Context.empty();
  return {
    Type: "Neon.Function",
    id,
    env,
    get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(process.env[key])),
    set: (key, value) =>
      Effect.sync(() => {
        env[key] = value.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    serve: (next) =>
      Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the dispatcher provides the request service at call time
        handler = next as HttpEffect;
        context = Context.omit(Layer.CurrentMemoMap)(yield* Effect.context<never>());
      }),
    route: (path, next) =>
      Effect.gen(function* () {
        if (routes.has(path))
          return yield* Effect.die(new Error(`Duplicate Neon Function route: ${path}`));
        routes.set(path, next);
        context = Context.omit(Layer.CurrentMemoMap)(yield* Effect.context<never>());
      }),
    handler: Effect.sync(() => ({
      dispatch: (path) => routes.get(path) ?? handler,
      context,
    })),
    planServices: Layer.succeed(FunctionEnvironment, {}),
  };
};
