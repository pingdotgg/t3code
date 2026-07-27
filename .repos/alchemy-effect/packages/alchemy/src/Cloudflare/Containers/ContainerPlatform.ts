import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServer, type HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { Platform } from "../../Platform.ts";
import { serveRpc, type Rpc } from "../../Rpc.ts";
import {
  packEnvValueKeepRedacted,
  unpackEnvValue,
} from "../../RuntimeContext.ts";
import * as Server from "../../Server/index.ts";
import type { Fetcher } from "../Fetcher.ts";
import { fromCloudflareFetcher, toCloudflareFetcher } from "../Fetcher.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { Worker } from "../Workers/Worker.ts";
import { ContainerTypeId } from "./Container.ts";
import type {
  ContainerApplication,
  ContainerServices,
  ContainerShape,
} from "./ContainerApplication.ts";

export const ContainerPlatform: Platform<
  ContainerApplication,
  ContainerServices,
  ContainerShape,
  Server.ProcessContext,
  Container
> = Platform(
  "Cloudflare.Container",
  {
    createRuntimeContext: (id: string): Server.ProcessContext => {
      const runners: Effect.Effect<void, never, any>[] = [];
      const env: Record<string, any> = {};

      const serve = <Req = never>(
        handler: HttpEffect<Req>,
        options?: { shape?: Record<string, unknown> },
      ) =>
        Effect.sync(() => {
          // Containers have no native RPC transport (unlike a Cloudflare
          // Worker's JSRPC), so expose the impl's non-`fetch` shape methods
          // over the plain-`fetch` RPC protocol: requests to `/__rpc__/*` are
          // dispatched to the matching shape method, everything else falls
          // through to the user's `fetch` handler. The DO side talks to this
          // via `makeFetchRpcStub` over the container's TCP port.
          const finalHandler = options?.shape
            ? serveRpc(options.shape, handler)
            : handler;
          runners.push(
            Effect.gen(function* () {
              const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
                Effect.map(Option.getOrUndefined),
              );
              if (httpServer) {
                yield* httpServer.serve(finalHandler);
                return yield* Effect.never;
              } else {
                // this should only happen at plantime, validate?
              }
            }).pipe(Effect.orDie),
          );
        });

      return {
        Type: ContainerTypeId,
        LogicalId: id,
        id,
        env,
        set: (bindingId: string, output: Output.Output) =>
          Effect.sync(() => {
            const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_");
            // `packEnvValueKeepRedacted` keeps the Redacted wrapper on the
            // outside so the provider can deploy secrets through the
            // Secrets Store (referenced via `secrets`) instead of leaking
            // them as plain `environmentVariables`, while the inner marker
            // lets the runtime `get` accessor rebuild the wrapper after
            // Cloudflare hands the value back as a plain env-var string.
            // Mirrors `makeWorkerRuntimeContext`.
            env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
            return key;
          }),
        get: <T>(key: string) =>
          // Read straight from `process.env` — see `unpackEnvValue` for why
          // this must never resolve through `Config.string`.
          Effect.sync(() => unpackEnvValue<T>(process.env[key]) as T),
        run: ((effect: Effect.Effect<void, never, any>) =>
          Effect.sync(() => {
            runners.push(effect);
          })) as unknown as Server.ProcessContext["run"],
        serve,
        exports: Effect.sync(() => ({
          default: Effect.all(
            runners.map((eff) =>
              Effect.forever(
                eff.pipe(
                  // Log and ignore errors (daemon mode, it should just re-run)
                  Effect.tapError((err) => Effect.logError(err)),
                  Effect.ignore,
                  // TODO(sam): ignore cause? for now, let that actually kill the server
                  // Effect.ignoreCause
                ),
              ),
            ),
            {
              concurrency: "unbounded",
            },
          ),
        })),
      } as Server.ProcessContext;
    },
  },
  {
    bind: Effect.fn(function* <Shape, Req = never>(
      containerEff:
        | (ContainerApplication & Rpc<Shape>)
        | Effect.Effect<ContainerApplication & Rpc<Shape>, never, Req>,
    ) {
      const namespace = yield* DurableObject;

      const container = Effect.isEffect(containerEff)
        ? yield* containerEff as unknown as Effect.Effect<
            ContainerApplication & Rpc<Shape>
          >
        : containerEff;

      yield* container.bind`${namespace}`({
        durableObjects: {
          namespaceId: namespace.namespaceId,
        },
      });

      const worker = yield* Worker;
      const className = namespace.name;

      yield* worker.bind`${container.LogicalId}`({
        containers: [{ className, dev: container.dev }],
      });

      // TODO(sam): register this in the Container Execution Context
      // const _httpEffect = yield* init;
      return Effect.gen(function* () {
        const state = yield* DurableObjectState;
        return {
          id: container.LogicalId,
          running: Effect.sync(() => state.container!.running ?? false),
          destroy: (error?: any) =>
            Effect.promise(() => state.container!.destroy(error)),
          signal: (signo: number) =>
            Effect.sync(() => state.container!.signal(signo)),
          getTcpPort: (port: number) =>
            Effect.sync(() =>
              fromCloudflareFetcher(state.container!.getTcpPort(port)),
            ),
          setInactivityTimeout: (durationMs: number | bigint) =>
            Effect.promise(() =>
              state.container!.setInactivityTimeout(durationMs),
            ),
          interceptOutboundHttp: (addr: string, binding: Fetcher) =>
            toCloudflareFetcher(binding).pipe(
              Effect.map((binding) =>
                state.container!.interceptOutboundHttp(addr, binding),
              ),
            ),
          interceptAllOutboundHttp: (binding: Fetcher) =>
            toCloudflareFetcher(binding).pipe(
              Effect.map((binding) =>
                state.container!.interceptAllOutboundHttp(binding),
              ),
            ),
          monitor: () =>
            Effect.promise(
              () => state.container?.monitor() ?? Promise.resolve(),
            ),
          start: (options?: ContainerStartupOptions) =>
            Effect.sync(() => state.container!.start(options)),
        } as unknown;
      });
    }),
  },
);
