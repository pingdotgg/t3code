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
} from "./DurableObjectNamespace.ts";
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
  (className: string) =>
    class DurableObjectBridge extends DurableObject {
      #state;
      #globalContext;
      #exported;
      #instance;
      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;

        const { globalContext, exported } =
          getWorkerExport<DurableObjectExport>({
            entrypoint,
            stack,
            exportName: className,
          });

        this.#globalContext = globalContext;
        this.#exported = exported;

        this.#instance = state.blockConcurrencyWhile(() =>
          this.#exported.pipe(
            Effect.flatMap(({ constructor, services }) =>
              constructor.pipe(
                Effect.provide(
                  Layer.succeed(
                    DurableObjectState,
                    fromDurableObjectState(this.#state),
                  ).pipe(Layer.provideMerge(Layer.succeedContext(services))),
                ),
                Effect.map((instance) => ({ instance, services })),
              ),
            ),
            Effect.provide(this.#globalContext),
            Effect.runPromise,
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
                  // A streaming RPC method returns a `Stream` directly rather
                  // than an `Effect`. Lift it into the success channel so the
                  // resulting `Exit.value` is the `Stream` and `handleRpcExit`
                  // can encode it as a stream envelope instead of trying to run
                  // it as an effect.
                  return Stream.isStream(result)
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
        onExit?: (exit: Exit.Exit<any, any>) => Promise<any>,
      ) {
        const scope = Scope.makeUnsafe();

        const { instance, services } = await this.#instance;

        return fn(instance)
          .pipe(
            Effect.provide(
              Layer.succeed(
                DurableObjectState,
                fromDurableObjectState(this.#state),
              ).pipe(
                Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
                Layer.provideMerge(Layer.succeedContext(services)),
                Layer.provideMerge(this.#globalContext),
              ),
            ),
            Effect.runPromiseExit,
          )
          .then(
            onExit ??
              ((exit) =>
                exit._tag === "Success"
                  ? Promise.resolve(exit.value)
                  : Promise.reject(Cause.squash(exit.cause))),
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
