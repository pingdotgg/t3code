import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import type * as Serverless from "../../Serverless/index.ts";
import { makeRequestHandler } from "./HttpServer.ts";
import {
  ExportedHandlerMethods,
  WorkerEnvironment,
  WorkerTypeId,
  type WorkerEvent,
} from "./Worker.ts";

export interface WorkerRuntimeContext extends Serverless.FunctionContext {
  export(name: string, value: any): Effect.Effect<void>;
  shape: () => Record<string, any>;
}

export const makeWorkerRuntimeContext = (id: string): WorkerRuntimeContext => {
  const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
  const exports: Record<string, any> = {};
  const env: Record<string, any> = {};
  let userShape: Record<string, unknown> | undefined;

  const ctx = {
    Type: WorkerTypeId,
    id,
    env,
    shape: () => userShape!,
    get: (key: string) =>
      Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        // Key is already canonical (see RuntimeContext.sanitizeKey).
        Effect.map((env) => env?.[key]),
        Effect.map((json) => {
          if (json === undefined) {
            return undefined;
          }
          try {
            const value = JSON.parse(json);
            // The `set` path serializes Redacted values as
            // `{_tag: "Redacted", value: ...}`. After JSON.parse the
            // result is a plain object — `Redacted.isRedacted` would
            // always return `false` on it — so detect the marker shape
            // and rebuild the Redacted wrapper. Plain values pass
            // through unchanged.
            if (
              typeof value === "object" &&
              value?._tag === "Redacted" &&
              "value" in value
            ) {
              return Redacted.make((value as { value: unknown }).value);
            }
            return value;
          } catch {
            return json;
          }
        }),
      ) as any,
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        // Preserve `Redacted`-ness across the Output → env → Cloudflare
        // binding boundary so the put-worker loop can deploy secrets via
        // `secret_text` instead of leaking them as `plain_text`. The JSON
        // payload still carries the `{_tag: "Redacted", …}` marker so the
        // runtime `get` accessor can rebuild the wrapper after Cloudflare
        // hands the binding back as a plain string.
        env[key] = output.pipe(
          Output.map((value) =>
            Redacted.isRedacted(value)
              ? Redacted.make(
                  JSON.stringify({
                    _tag: "Redacted",
                    value: Redacted.value(value),
                  }),
                )
              : JSON.stringify(value),
          ),
        );
        return key;
      }),
    serve: <Req = never>(
      handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
      options?: { shape?: Record<string, unknown> },
    ) => {
      // Capture the user's full default-export shape so `exports` can
      // expose any non-handler methods on it as RPC methods on the
      // deployed `WorkerEntrypoint` subclass — see `__rpc__` below.
      if (options?.shape) userShape = options.shape;
      return ctx.listen(makeRequestHandler(handler));
    },
    listen: ((
      handler:
        | Serverless.FunctionListener
        | Effect.Effect<Serverless.FunctionListener>,
    ) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as Serverless.FunctionContext["listen"],
    export: (name: string, value: any) =>
      Effect.sync(() => {
        exports[name] = value;
      }),
    planServices: Layer.succeed(WorkerEnvironment, {}),
    exports: Effect.gen(function* () {
      const handlers = yield* Effect.all(listeners, {
        concurrency: "unbounded",
      });
      const services = yield* Effect.context();

      const dispatch =
        (type: WorkerEvent["type"]) =>
        (request: any, env: unknown, context: cf.ExecutionContext) => {
          const event: WorkerEvent = {
            kind: "Cloudflare.Workers.WorkerEvent",
            type,
            input: request,
            env,
            context,
          };
          for (const handler of handlers) {
            const eff = handler(event);
            if (Effect.isEffect(eff)) {
              return [eff, services];
            }
          }
          return [
            Effect.die(
              new Error(`No event handler found for event type '${type}'`),
            ),
            services,
          ];
        };

      // RPC method dispatchers — one per non-handler method on the user's
      // shape. Each dispatcher is invoked by the WorkerEntrypoint bridge
      // as `dispatcher(args, ctx)`: `args` are the user-facing call args,
      // `ctx` is the `this.ctx` that Cloudflare hands the bridge per RPC
      // request. The dispatcher runs the user effect with the same runtime
      // layer the fetch path uses, then envelope-encodes the result so
      // `Effect.fail` round-trips as `RpcErrorEnvelope` and `Stream` as
      // `RpcStreamEnvelope` (consumers wrap the binding with
      // `toPromiseApi`/`bindWorker` to decode).

      return {
        ...exports,
        default: Object.fromEntries(
          ExportedHandlerMethods.map((method) => [method, dispatch(method)]),
        ),
      };
    }),
  };
  return ctx;
};
