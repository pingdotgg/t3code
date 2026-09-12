import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeCrypto from "node:crypto";
const RegistryProxyWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/registry/RegistryProxy.worker",
    ),
};
import {
  defaultDurableObjectUniqueKey,
  SERVICE_USER_WORKER,
} from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Registry from "./Registry.ts";
import type { ResolvedTargetMap, Subscriber } from "./RegistryTypes.shared.ts";

export class RegistryProxy extends Plugin.Service<
  RegistryProxy,
  {
    /**
     * Declares a service, belonging to the current worker, that will be published to the registry proxy.
     */
    readonly publish: (service: PublishedService) => Effect.Effect<void>;
    /**
     * Declares an external service that will be consumed by the current worker.
     * Returns a service designator that proxies to the external target.
     */
    readonly subscribe: <T extends Subscriber>(
      subscriber: T,
    ) => Effect.Effect<ServiceDesignatorFromSubscriber<T>>;
  }
>()("cloudflare-runtime/plugin/RegistryProxy") {}

type PublishedService =
  | Subscriber.DurableObject
  | (Subscriber.QueueConsumer & { service: string })
  | (Omit<Subscriber.Workflow, "scriptName"> & { service: string });

type ServiceDesignatorFromSubscriber<T extends Subscriber> = T extends {
  kind: "durable-object";
}
  ? WorkerdConfig.Worker_DurableObjectNamespace
  : WorkerdConfig.ServiceDesignator;

const SERVICE_REGISTRY_PROXY = "cloudflare-runtime:registry-proxy";
const SOCKET_REGISTRY_PROXY = "registry-proxy-socket";
const SOCKET_DEBUG_PORT = "debug-port";

export const RegistryProxyLive = Layer.effect(
  RegistryProxy,
  Effect.gen(function* () {
    const registry = yield* Registry.Registry;
    const http = yield* HttpClient.HttpClient;

    return RegistryProxy.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;

        const published: Array<PublishedService> =
          worker.durableObjectNamespaces?.map((namespace) => ({
            kind: "durable-object",
            scriptName: worker.name,
            className: namespace.className,
            uniqueKey:
              namespace.uniqueKey ??
              defaultDurableObjectUniqueKey(worker.name, namespace.className),
          })) ?? [];
        const subscribed: Array<Subscriber> = [];

        return {
          defer: Effect.gen(function* () {
            if (subscribed.length === 0) {
              return {};
            }
            const durableObjects = subscribed.filter(
              (subscriber) => subscriber.kind === "durable-object",
            );
            const service: WorkerdConfig.Service = {
              name: SERVICE_REGISTRY_PROXY,
              worker: {
                compatibilityDate: "2025-01-01",
                compatibilityFlags: ["service_binding_extra_handlers"],
                modules: yield* registry
                  .read(subscribed)
                  .pipe(
                    Effect.flatMap((targets) =>
                      Effect.promise(() =>
                        buildWorkerModules(targets, durableObjects),
                      ),
                    ),
                  ),
                bindings: [
                  {
                    name: "REGISTRY_DEBUG_PORT",
                    workerdDebugPort: WorkerdConfig.kVoid,
                  },
                ],
                durableObjectStorage: { inMemory: WorkerdConfig.kVoid },
                durableObjectNamespaces: durableObjects.map((subscriber) => ({
                  className: externalDurableObjectClassName(
                    subscriber.scriptName,
                    subscriber.className,
                  ),
                  uniqueKey: subscriber.uniqueKey,
                })),
              },
            };
            const socket: WorkerdConfig.Socket = {
              name: SOCKET_REGISTRY_PROXY,
              address: "127.0.0.1:0",
              service: { name: SERVICE_REGISTRY_PROXY },
            };
            return { sockets: [socket], services: [service] };
          }),
          start: (ports) =>
            // When the worker starts, publish it to the registry.
            // If we have external services, subscribe to the registry and push updates to the proxy.
            Effect.all(
              [
                Effect.gen(function* () {
                  const debugPort = ports[SOCKET_DEBUG_PORT];
                  if (!debugPort) {
                    return yield* new SystemError({
                      subtag: "RegistryProxyDebugPort",
                      message: "Debug port not found.",
                      detail: { debugPort },
                    });
                  }
                  yield* registry.write({
                    scriptName: worker.name,
                    debugPortAddress: `127.0.0.1:${debugPort}`,
                    services: [
                      {
                        kind: "worker",
                        // TODO: The fetch service should be the service name for the top of the middleware chain.
                        fetchService: SERVICE_USER_WORKER,
                        rpcService: SERVICE_USER_WORKER,
                      },
                      ...published.map((service) => ({
                        ...service,
                        service:
                          "service" in service
                            ? service.service
                            : SERVICE_USER_WORKER,
                      })),
                    ],
                  });
                }),
                Effect.gen(function* () {
                  if (subscribed.length === 0) {
                    return;
                  }
                  const proxyPort = ports[SOCKET_REGISTRY_PROXY];
                  if (!proxyPort) {
                    return yield* new SystemError({
                      subtag: "RegistryProxyPort",
                      message: "Registry proxy port not found.",
                      detail: { proxyPort },
                    });
                  }
                  yield* registry.subscribe(subscribed).pipe(
                    Stream.runForEach((targets) =>
                      http.post(`http://127.0.0.1:${proxyPort}/`, {
                        body: HttpBody.jsonUnsafe(targets),
                      }),
                    ),
                    Effect.forkScoped,
                  );
                }),
              ],
              { concurrency: "unbounded" },
            ),
          api: {
            publish: (entry) =>
              Effect.sync(() => {
                published.push(entry);
              }),
            subscribe: <T extends Subscriber>(subscriber: T) =>
              Effect.sync<ServiceDesignatorFromSubscriber<T>>(() => {
                subscribed.push(subscriber);
                switch (subscriber.kind) {
                  case "worker":
                    return {
                      name: SERVICE_REGISTRY_PROXY,
                      entrypoint: "ExternalService",
                      props: {
                        json: JSON.stringify(subscriber),
                      },
                    };
                  case "durable-object":
                    return {
                      serviceName: SERVICE_REGISTRY_PROXY,
                      className: externalDurableObjectClassName(
                        subscriber.scriptName,
                        subscriber.className,
                      ),
                    };
                  case "queue-consumer":
                    return {
                      name: SERVICE_REGISTRY_PROXY,
                      entrypoint: "ExternalQueueConsumer",
                      props: {
                        json: JSON.stringify(subscriber),
                      },
                    };
                  case "workflow":
                    return {
                      name: SERVICE_REGISTRY_PROXY,
                      entrypoint: "ExternalWorkflow",
                      props: {
                        json: JSON.stringify(subscriber),
                      },
                    };
                }
              }),
          },
        };
      }),
    );
  }),
);

/** Generates a stable, variable-safe class name for an external Durable Object. */
const externalDurableObjectClassName = (
  scriptName: string,
  className: string,
) =>
  `ExternalDurableObject_${NodeCrypto.createHash("sha256").update(scriptName).update(className).digest("hex").slice(0, 16)}`;

/** Builds the worker modules for the registry proxy, including a pre-populated registry and proxy classes for each external Durable Object. */
const buildWorkerModules = async (
  targets: ResolvedTargetMap,
  durableObjects: ReadonlyArray<Subscriber.DurableObject>,
) => {
  const worker = await RegistryProxyWorker.worker();
  const main = [
    `import { makeExternalDurableObject, Target } from "./${worker.main}";`,
    `export { ExternalService, ExternalWorkflow, ExternalQueueConsumer } from "./${worker.main}";`,
    `Target.set(${JSON.stringify(targets)});`,
    `export default {`,
    `  async fetch(request) {`,
    `    if (request.method === "POST") {`,
    `      const data = await request.json();`,
    `      Target.set(data);`,
    `      return new Response("ok");`,
    `    }`,
    `    return new Response("not found", { status: 404 });`,
    `  }`,
    `};`,
    ...durableObjects.map(
      (subscriber) =>
        `export const ${externalDurableObjectClassName(subscriber.scriptName, subscriber.className)} = makeExternalDurableObject(${JSON.stringify(subscriber)});`,
    ),
  ].join("\n");
  return formatInternalWorkerModules({
    modules: {
      "index.worker.mjs": main,
      ...worker.modules,
    },
  });
};
