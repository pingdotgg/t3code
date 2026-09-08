import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
const ClientWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/remote-bindings/workers/client.worker",
    ),
};
const OutboundWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/remote-bindings/workers/outbound.worker",
    ),
};
import * as Loopback from "../globals/Loopback.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import * as PluginContext from "../PluginContext.ts";
import type {
  ApiError,
  ConfigError,
  SystemError,
} from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as RemoteWorker from "./RemoteWorker.ts";
import type {
  RemoteBinding,
  RemoteWorkerConfig,
  RemoteWorkerResult,
} from "./RemoteWorkerConfig.shared.ts";

export class RemoteBindings extends Plugin.Service<
  RemoteBindings,
  {
    readonly register: (
      binding: RemoteBinding,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/RemoteBindings") {}

export type { RemoteBinding };

export const RemoteBindingsLive = Layer.effect(
  RemoteBindings,
  Effect.gen(function* () {
    const loopback = yield* Loopback.Loopback;
    const remoteWorker = yield* RemoteWorker.RemoteWorker;
    const prefetches = new Map<
      number,
      Fiber.Fiber<RemoteWorkerResult, ApiError | ConfigError | SystemError>
    >();
    if (Effect.isEffect(loopback)) {
      return yield* Effect.die("Expected loopback to be initialized");
    }
    const serviceDesignator = yield* loopback.api.route(
      "remote-bindings",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const json = (yield* request.json) as unknown as RemoteWorkerConfig;
        const hash = Hash.structure(json);
        const prefetched = prefetches.get(hash);
        if (prefetched) {
          prefetches.delete(hash);
        }
        const deploy = prefetched
          ? Fiber.join(prefetched)
          : remoteWorker.deploy(json);
        return yield* deploy.pipe(
          Effect.flatMap((result) =>
            HttpServerResponse.json({ ok: true, result }),
          ),
          Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause))),
          Effect.catch((error) =>
            HttpServerResponse.json({ ok: false, error }, { status: 500 }),
          ),
        );
      }),
    );
    const build = Effect.fn(function* (
      config: RemoteWorkerConfig,
    ): Effect.fn.Return<Plugin.PluginConfig> {
      if (config.bindings.length === 0) return {};
      const fiber = yield* Effect.forkDetach(remoteWorker.deploy(config));
      prefetches.set(Hash.structure(config), fiber);
      const [outboundWorker, clientWorker] = yield* Effect.forEach(
        [OutboundWorker, ClientWorker],
        (worker) =>
          Effect.map(
            Effect.promise(worker.worker),
            formatInternalWorkerModules,
          ),
        { concurrency: "unbounded" },
      );
      const outbound = {
        name: "remote-bindings:outbound",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: outboundWorker,
          bindings: [
            {
              name: "PROXY",
              durableObjectNamespace: { className: "RemoteBindingProxy" },
            },
            {
              name: "LOOPBACK",
              service: serviceDesignator,
            },
            {
              name: "OPTIONS",
              json: JSON.stringify(config),
            },
          ],
          durableObjectNamespaces: [
            {
              className: "RemoteBindingProxy",
              enableSql: true,
              preventEviction: true,
              ephemeralLocal: WorkerdConfig.kVoid,
            },
          ],
        },
      } satisfies WorkerdConfig.Service;
      const client = {
        name: "remote-bindings:client",
        worker: {
          compatibilityDate: "2026-03-10",
          modules: clientWorker,
          globalOutbound: { name: outbound.name },
        },
      } satisfies WorkerdConfig.Service;
      return {
        services: [client, outbound],
      };
    });
    return RemoteBindings.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext.PluginContext;
        const bindings: Array<RemoteBinding> = [];
        const config: RemoteWorkerConfig = {
          name: worker.name,
          bindings,
        };
        return {
          defer: Effect.suspend(() => build(config)),
          api: {
            register: (binding) =>
              Effect.sync(() => {
                bindings.push(binding);
                return {
                  name: "remote-bindings:client",
                  props: {
                    json: JSON.stringify({ binding: binding.name }),
                  },
                };
              }),
          },
        };
      }),
    );
  }),
);

export const makeRemoteBinding = (
  binding: RemoteBinding,
  f: (service: WorkerdConfig.ServiceDesignator) => WorkerdConfig.Worker_Binding,
): PluginContext.BindingHook<RemoteBindings> =>
  Effect.map(
    Plugin.use(RemoteBindings, (remoteBindings) =>
      remoteBindings.api.register(binding),
    ),
    f,
  );
