import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { HttpServerResponse } from "effect/unstable/http";
import type {
  DurableObjectExport,
  DurableObjectShape,
} from "./DurableObject.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { isScopeEjected, makeRequestEffect } from "./HttpServer.ts";
import { fromWebSocket } from "./WebSocket.ts";
import { getWorkerExport, handleRpcExit } from "./WorkerBridge.ts";

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 *
 * Accepts the `DurableObject` base class and a `getExport` resolver so the
 * implementation lives in real TypeScript instead of a generated string template.
 */
export const makeDurableObjectBridge =
  (
    DurableObject: typeof DurableObjectClass,
    {
      entrypoint,
      stack,
    }: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: {
        name: string;
        stage: string;
      };
    },
  ) =>
  (className: string) => {
    // One isolate-lifetime layer build shared by every activation of this DO
    // class: `build` memoizes the built context, so re-activations (including
    // hibernatable WebSocket wakes, which re-run the constructor) reuse it
    // instead of rebuilding the layer stack.
    const { build } = getWorkerExport<DurableObjectExport>({
      entrypoint,
      stack,
      exportName: className,
    });

    return class DurableObjectBridge extends DurableObject {
      #state;
      #instance;
      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;

        this.#instance = state.blockConcurrencyWhile(() =>
          build((promise) => void (state as any).waitUntil?.(promise)).then(
            ({ context, export: exported }) => {
              const { constructor, services } = exported;
              const doContext = Layer.succeed(
                DurableObjectState,
                fromDurableObjectState(this.#state),
              ).pipe(
                Layer.provideMerge(Layer.succeedContext(services)),
                Layer.provideMerge(Layer.succeedContext(context)),
              );
              return constructor.pipe(
                Effect.provide(doContext),
                Effect.flatMap((instance) =>
                  instance.pipe(Effect.provide(doContext)),
                ),
                Effect.map((instance) => ({ instance, services, context })),
                Effect.runPromise,
              );
            },
          ),
        );

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (f: any) =>
              typeof f === "function" ? f.bind(target) : f;
            if (typeof prop !== "string") return bind((target as any)[prop]);
            if (prop in target) return bind((target as any)[prop]);
            return async (...args: any[]) =>
              this.#execute((instance) => {
                const method = instance[prop as keyof DurableObjectShape];
                if (typeof method === "function") {
                  const result = (method as any)(...args);
                  // Effects (including nested-RPC values built by
                  // `asEffectOrStream`, which are Effects *branded* as Streams)
                  // must be run as effects — their resolved value may itself be
                  // a `Stream`, which `handleRpcExit` then encodes. Only a
                  // *genuine* `Stream` (not an Effect) is lifted into the
                  // success channel so `handleRpcExit` encodes it directly.
                  return Effect.isEffect(result)
                    ? result
                    : Stream.isStream(result)
                      ? Effect.succeed(result)
                      : result;
                } else if (Effect.isEffect(method)) {
                  return method;
                } else {
                  return Effect.succeed(method);
                }
              }, handleRpcExit);
          },
        });
      }

      async #execute(
        fn: (instance: DurableObjectShape) => Effect.Effect<any, any, any>,
        onExit?: (
          exit: Exit.Exit<any, any>,
          scope: Scope.Closeable,
        ) => Promise<any>,
      ) {
        const scope = Scope.makeUnsafe();

        const { instance, services, context } = await this.#instance;

        return fn(instance)
          .pipe(
            Effect.provide(
              Layer.succeed(
                DurableObjectState,
                fromDurableObjectState(this.#state),
              ).pipe(
                Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
                Layer.provideMerge(Layer.succeedContext(services)),
                Layer.provideMerge(Layer.succeedContext(context)),
              ),
            ),
            Effect.runPromiseExit,
          )
          .then((exit) =>
            onExit
              ? onExit(exit, scope)
              : exit._tag === "Success"
                ? Promise.resolve(exit.value)
                : Promise.reject(Cause.squash(exit.cause)),
          )
          .finally(() =>
            isScopeEjected(scope)
              ? undefined
              : Scope.close(scope, Exit.void).pipe(
                  Effect.runPromise,
                  (promise) => this.ctx.waitUntil(promise),
                ),
          );
      }

      async fetch(request: Request): Promise<any> {
        return this.#execute((instance) =>
          instance.fetch
            ? makeRequestEffect(request as any, instance.fetch)
            : Effect.succeed(
                HttpServerResponse.text("Not implemented", {
                  status: 404,
                }),
              ),
        );
      }

      async alarm(alarmInfo?: cf.AlarmInvocationInfo) {
        return this.#execute((instance) => instance.alarm!(alarmInfo));
      }

      async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        return this.#execute(
          (instance) =>
            instance.webSocketMessage?.(fromWebSocket(ws as any), message) ??
            Effect.void,
        );
      }

      async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ) {
        return this.#execute(
          (instance) =>
            instance.webSocketClose?.(
              fromWebSocket(ws as any),
              code,
              reason,
              wasClean,
            ) ?? Effect.void,
        );
      }
    } as any;
  };
