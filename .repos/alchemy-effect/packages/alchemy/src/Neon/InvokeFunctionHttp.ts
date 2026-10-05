import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CurrentRuntimeContext, sanitizeKey } from "../RuntimeContext.ts";
import type { Function } from "./Function.ts";
import { InvokeFunction, InvokeFunctionError } from "./InvokeFunction.ts";

/**
 * URL-only HTTP client. Does not provision an invocation credential or private route.
 *
 * ### Invoke a Function
 * **Example:** Provide the HTTP implementation
 * ```typescript
 * const application = Effect.gen(function* () {
 *   const api = yield* Neon.InvokeFunction(target);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const response = yield* api.fetch("/health").pipe(Effect.orDie);
 *       return HttpServerResponse.text(String(response.status));
 *     }),
 *   };
 * }).pipe(Effect.provide(Neon.InvokeFunctionHttp));
 * ```
 *
 * @layer
 * @product Function
 * @provides Neon.InvokeFunction
 */
export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    const host = yield* CurrentRuntimeContext;
    if (!host)
      return yield* Effect.die(
        new Error("Neon.InvokeFunction requires a Platform host"),
      );
    return Effect.fn(function* (fn: Function) {
      const key = sanitizeKey(
        `NEON_FUNCTION_${Array.from(fn.FQN, (character) => character.codePointAt(0)!.toString(16)).join("_")}_URL`,
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) yield* host.set(key, fn.url);
      const url = host
        .get<string>(key)
        .pipe(
          Effect.flatMap((url) =>
            url
              ? Effect.succeed(url)
              : Effect.die(new Error("Missing Neon Function URL binding")),
          ),
        );
      return {
        url,
        fetch: (path = "/", init?: RequestInit) =>
          Effect.gen(function* () {
            const base = yield* url;
            const target = yield* Effect.try({
              try: () => new URL(path, base),
              catch: () =>
                new InvokeFunctionError({
                  message: "Invalid Function request path",
                }),
            });
            if (target.origin !== new URL(base).origin)
              return yield* new InvokeFunctionError({
                message: "Function invocation must remain on the bound origin",
              });
            return yield* Effect.tryPromise({
              try: (signal) =>
                fetch(target, {
                  ...init,
                  signal: init?.signal
                    ? AbortSignal.any([signal, init.signal])
                    : signal,
                }),
              catch: () =>
                new InvokeFunctionError({
                  message: "Neon Function HTTP request failed",
                }),
            });
          }),
      };
    });
  }),
);
