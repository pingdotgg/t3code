import { HttpServer, type HttpEffect } from "alchemy/Http";
import * as Output from "alchemy/Output";
import { serveRpc } from "alchemy/Rpc";
import type { ProcessContext } from "alchemy/Runtime/Process";
import { packEnvValueKeepRedacted, unpackEnvValue } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export const MicrovmImageTypeId = "AWS.Lambda.MicrovmImage" as const;

/**
 * Runtime context for the in-VM process: an HTTP server (the MicroVM endpoint)
 * that exposes the impl's `fetch` handler plus any RPC shape methods. Mirrors
 * the Cloudflare `ContainerPlatform` process context.
 */
export const makeMicrovmRuntimeContext = (id: string): ProcessContext => {
  const runners: Effect.Effect<void, never, any>[] = [];
  const env: Record<string, any> = {};

  const serve = <Req = never>(
    handler: HttpEffect<Req>,
    options?: { shape?: Record<string, unknown> },
  ) =>
    Effect.sync(() => {
      const finalHandler = options?.shape ? serveRpc(options.shape, handler) : handler;
      runners.push(
        Effect.gen(function* () {
          const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
            Effect.map(Option.getOrUndefined),
          );
          if (httpServer) {
            yield* httpServer.serve(finalHandler);
            return yield* Effect.never;
          }
        }).pipe(Effect.orDie),
      );
    });

  return {
    Type: MicrovmImageTypeId,
    LogicalId: id,
    id,
    env,
    set: (bindingId: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
        // `packEnvValueKeepRedacted` keeps the Redacted wrapper on the
        // outside so deploy-time code can route secrets while the inner
        // marker lets the runtime `get` accessor rebuild the wrapper.
        env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    get: <T>(key: string) =>
      // Read straight from `process.env` — see `unpackEnvValue` for why
      // this must never resolve through `Config.String`.
      Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
    run: ((effect: Effect.Effect<void, never, any>) =>
      Effect.sync(() => {
        runners.push(effect);
      })) as unknown as ProcessContext["run"],
    serve,
    exports: Effect.sync(() => ({
      default: Effect.forEach(
        runners,
        (eff) =>
          Effect.forever(
            eff.pipe(
              Effect.tapError((err) => Effect.logError(err)),
              Effect.ignore,
            ),
          ),
        { concurrency: "unbounded" },
      ),
    })),
  } as ProcessContext;
};
