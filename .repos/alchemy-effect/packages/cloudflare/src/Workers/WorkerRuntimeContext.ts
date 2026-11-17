import type * as cf from "@cloudflare/workers-types";
import type { HttpEffect } from "alchemy/Http";
import * as Output from "alchemy/Output";
import type { FunctionContext, FunctionListener } from "alchemy/Runtime/Function";
import { packEnvValueKeepRedacted, unpackEnvValue } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { WorkflowExport } from "../Workflows/Workflow.ts";
import type { DurableObjectExport } from "./DurableObject.ts";
import { makeRequestHandler } from "./HttpServer.ts";
import type { SqlMigrationsExport } from "./SqlMigrationsRuntime.ts";
import { WebhookHostLive } from "./WebhookHost.ts";
import {
  ExportedHandlerMethods,
  WorkerEnvironment,
  WorkerTypeId,
  type WorkerEvent,
} from "./WorkerRuntime.ts";

export type WorkerExport = DurableObjectExport | WorkflowExport | SqlMigrationsExport;

export interface WorkerRuntimeContext extends FunctionContext {
  export(name: string, value: any): Effect.Effect<void>;
  shape: () => Record<string, any>;
}

export const makeWorkerRuntimeContext = (id: string): WorkerRuntimeContext => {
  const listeners: Effect.Effect<FunctionListener>[] = [];
  const exports: Record<string, WorkerExport> = {};
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
        // Key is already canonical (see RuntimeContext.sanitizeKey). Read
        // straight from `WorkerEnvironment` — see `unpackEnvValue` for why
        // this must never resolve through `Config.String`.
        Effect.map((env) => unpackEnvValue(env?.[key])),
      ) as any,
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        // `packEnvValueKeepRedacted` keeps the Redacted wrapper on the
        // outside so the put-worker loop can deploy secrets via
        // `secret_text` instead of leaking them as `plain_text`, while the
        // inner marker lets the runtime `get` accessor rebuild the wrapper
        // after Cloudflare hands the binding back as a plain string.
        env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
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
    listen: ((handler: FunctionListener | Effect.Effect<FunctionListener>) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as FunctionContext["listen"],
    export: (name: string, value: any) =>
      Effect.sync(() => {
        exports[name] = value;
      }),
    // Every Worker can receive webhooks, so event sources need no host wiring.
    hostServices: WebhookHostLive,
    planServices: Layer.mergeAll(Layer.succeed(WorkerEnvironment, {})),
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
          const effects: Effect.Effect<unknown>[] = [];
          for (const handler of handlers) {
            const eff = handler(event);
            if (Effect.isEffect(eff)) {
              effects.push(eff);
            }
          }
          if (effects.length === 1) {
            return [effects[0], services];
          }
          if (effects.length > 1) {
            return [
              Effect.all(effects, { concurrency: "unbounded" }).pipe(
                Effect.map((results) => {
                  for (const result of results) {
                    if (result instanceof Response) return result;
                  }
                  return results[results.length - 1];
                }),
              ),
              services,
            ];
          }
          return [
            Effect.die(new Error(`No event handler found for event type '${type}'`)),
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
      // `toRpcAsync`/`bindWorker` to decode).

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
