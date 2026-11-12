import type * as cf from "@cloudflare/workers-types";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { buildEventTelemetry } from "alchemy/TelemetryRuntime";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
  makeDurableObjectCallbackFactory,
} from "./AlarmCallback.ts";
import type { DurableObjectExport, DurableObjectShape } from "./DurableObject.ts";
import {
  BackgroundWork,
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { isScopeEjected, makeRequestEffect } from "./HttpServer.ts";
import { takeRpcTraceContext } from "./internal/RpcTraceContext.ts";
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
            ({ context, runtimeContext, export: exported, telemetry }) => {
              const { constructor, services } = exported;
              const instanceRuntimeContext = {
                ...runtimeContext,
                makeCallback: makeDurableObjectCallbackFactory(this.#state),
              };
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
                  Effect.suspend(() => {
                    const seal = initializeAlarmCallbacks(this.#state);
                    const instanceContext = Layer.succeed(
                      RuntimeContext,
                      instanceRuntimeContext,
                    ).pipe(Layer.provideMerge(doContext));
                    return instance.pipe(
                      Effect.provide(instanceContext),
                      Effect.ensuring(Effect.sync(seal)),
                    );
                  }),
                ),
                Effect.map((instance) => ({
                  instance,
                  services: Context.add(services, RuntimeContext, instanceRuntimeContext),
                  context,
                  telemetry,
                })),
                Effect.runPromise,
              );
            },
          ),
        );

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (f: any) => (typeof f === "function" ? f.bind(target) : f);
            if (typeof prop !== "string") return bind((target as any)[prop]);
            if (prop in target) return bind((target as any)[prop]);
            return (...callArgs: unknown[]) => {
              // A stub appends the caller's trace context; one from an older
              // deploy doesn't, and its call starts a trace of its own.
              const [args, parent] = takeRpcTraceContext(callArgs);
              return this.#execute(
                (instance) =>
                  Effect.suspend(() => {
                    if (!Object.hasOwn(instance, prop)) {
                      return Effect.die(new Error(`Method "${prop}" not found on Durable Object`));
                    }
                    const member = instance[prop as keyof DurableObjectShape];
                    const result =
                      typeof member === "function"
                        ? (member as (...args: unknown[]) => unknown)(...args)
                        : member;
                    // Effects (including nested-RPC values built by
                    // `asEffectOrStream`, which are Effects branded as Streams)
                    // run as effects; a genuine Stream is lifted into the
                    // success channel for `handleRpcExit` to encode. The RPC
                    // Shape constraint rejects any other member at
                    // declaration, so anything else got past it with a cast.
                    if (Effect.isEffect(result)) return result;
                    if (Stream.isStream(result)) return Effect.succeed(result);
                    return Effect.die(
                      new Error(
                        `Durable Object RPC member "${prop}" must return an Effect or a Stream`,
                      ),
                    );
                  }).pipe((effect) =>
                    Option.isSome(parent) ? Effect.withParentSpan(effect, parent.value) : effect,
                  ),
                handleRpcExit,
              );
            };
          },
        });
      }

      async #execute(
        fn: (instance: DurableObjectShape) => Effect.Effect<any, any, any>,
        onExit?: (exit: Exit.Exit<any, any>, scope: Scope.Closeable) => Promise<any>,
      ) {
        const scope = Scope.makeUnsafe();
        // Work this call hands to `waitUntil` runs after it returns, in its
        // context, so it records into this call's telemetry. The exporters get
        // a scope of their own, flushed once that work (and any it starts)
        // settles; the call's scope closes as soon as the call does.
        const telemetryScope = Scope.makeUnsafe();
        const background: Array<Promise<unknown>> = [];
        const settled = async () => {
          for (let seen = 0; seen < background.length;) {
            const batch = background.slice(seen);
            seen = background.length;
            await Promise.allSettled(batch);
          }
        };
        // However the call's scope closes (here, or later by whoever ejected
        // it), flush telemetry once the background work has settled, without
        // holding up the close.
        Effect.runSync(
          Scope.addFinalizer(
            scope,
            Effect.sync(() =>
              this.ctx.waitUntil(
                settled().then(() => Effect.runPromise(Scope.close(telemetryScope, Exit.void))),
              ),
            ),
          ),
        );

        const { instance, services, context, telemetry } = await this.#instance;

        return fn(instance)
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(DurableObjectState, fromDurableObjectState(this.#state)),
                Layer.succeed(BackgroundWork, (promise) => void background.push(promise)),
                Layer.succeed(Scope.Scope, scope),
                // The configured telemetry exporters, on their own scope:
                // flushed into `waitUntil` once the call's scope has closed and
                // its background work has settled (the isolate scope never
                // finalizes on workerd).
                Layer.effectContext(buildEventTelemetry(context, telemetryScope, telemetry())),
              ).pipe(
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
              : this.ctx.waitUntil(
                  // Match WorkerBridge: yield one macrotask so the
                  // HttpMiddleware tracer's late span-end reaches the
                  // telemetry exporter before the scope's flush finalizer.
                  new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
                    Effect.runPromise(Scope.close(scope, Exit.void)),
                  ),
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
        return this.#execute((instance) =>
          dispatchAlarmCallbacks(this.#state, instance.alarm !== undefined).pipe(
            Effect.andThen(() => instance.alarm?.(alarmInfo) ?? Effect.void),
          ),
        );
      }

      async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        return this.#execute(
          (instance) =>
            instance.webSocketMessage?.(fromWebSocket(ws as any), message) ?? Effect.void,
        );
      }

      async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
        return this.#execute(
          (instance) =>
            instance.webSocketClose?.(fromWebSocket(ws as any), code, reason, wasClean) ??
            Effect.void,
        );
      }

      async webSocketError(ws: WebSocket, error: unknown) {
        return this.#execute(
          (instance) => instance.webSocketError?.(fromWebSocket(ws as any), error) ?? Effect.void,
        );
      }
    } as any;
  };
