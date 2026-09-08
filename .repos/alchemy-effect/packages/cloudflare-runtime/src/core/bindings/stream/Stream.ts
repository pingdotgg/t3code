import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const StreamWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/stream/Stream.worker",
    ),
};
import * as Loopback from "../../globals/Loopback.ts";
import type * as LoopbackServer from "../../globals/LoopbackServer.ts";
import * as Storage from "../../globals/Storage.ts";
import { SOCKET_USER_ENTRY } from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook, PluginContext } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type { StreamProps } from "./StreamOptions.shared.ts";
import {
  BINDING_STREAM_BLOBS,
  BINDING_STREAM_ENABLE_CONTROL_ENDPOINTS,
  BINDING_STREAM_LOOPBACK,
  BINDING_STREAM_OBJECT,
  LOOPBACK_TARGET_STREAM,
  PATH_STREAM_PUBLIC_URL,
  PATH_STREAM_VIDEO,
  SERVICE_STREAM,
  SERVICE_STREAM_STORAGE,
  STREAM_BINDING_ENTRYPOINT,
  STREAM_OBJECT_CLASS_NAME,
} from "./StreamOptions.shared.ts";

export class Stream extends Plugin.Service<
  Stream,
  {
    /**
     * Record that a local `stream` binding is in use (so the stream services
     * are only emitted when at least one binding exists), register the
     * node-side loopback route that resolves the runtime's public URL, and
     * resolve the service designator the binding should target: the shared
     * `stream` service's `StreamBinding` RPC entrypoint.
     */
    readonly register: () => Effect.Effect<
      WorkerdConfig.ServiceDesignator,
      ConfigError,
      PluginContext | Loopback.Loopback
    >;
  }
>()("cloudflare-runtime/plugin/Stream") {}

/**
 * Worker script for the stream router middleware: serves stored videos at
 * `/cdn-cgi/mf/stream/<id>/watch` through the `StreamBinding` entrypoint and
 * forwards everything else upstream — the equivalent of Miniflare's
 * `CoreBindings.SERVICE_STREAM` routing in its core entry worker
 * (`workers-sdk/packages/miniflare/src/workers/core/entry.worker.ts`).
 */
const STREAM_ROUTER_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === ${JSON.stringify(PATH_STREAM_VIDEO)} ||
      url.pathname.startsWith(${JSON.stringify(`${PATH_STREAM_VIDEO}/`)})
    ) {
      return await env.STREAM.fetch(request);
    }
    return await env.USER_WORKER.fetch(request);
  },
};
`;

export const StreamLive = Layer.effect(
  Stream,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;
    const enableControlEndpoints = yield* Plugin.UnsafeEnableControlEndpoints;

    // The runtime entry URL of the latest started worker with a stream
    // binding — the equivalent of Miniflare's public URL. Kept node-side and
    // served through the loopback so the binding always sees the current
    // value, even across worker restarts (workerd sockets get new ports).
    let entryUrl: string | null = null;

    /**
     * Node-side handler for the stream loopback route: returns the runtime's
     * public URL as JSON (Miniflare's `/core/public-url` route, which its
     * stream binding worker calls via `getPublicUrl`).
     */
    const handler: LoopbackServer.RawHandler = (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === PATH_STREAM_PUBLIC_URL) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(entryUrl));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: `Unknown stream loopback route "${url.pathname}"`,
        }),
      );
    };

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Stream",
          message:
            "Cannot configure Stream persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "stream");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Stream",
              message: `Failed to create Stream persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_STREAM_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Stream.of(
      Effect.sync(() => {
        let used = false;
        let loopbackService: WorkerdConfig.ServiceDesignator | undefined;

        return {
          api: {
            register: () =>
              Plugin.use(Loopback.Loopback, (loopback) =>
                Effect.map(
                  loopback.api.route(LOOPBACK_TARGET_STREAM, handler),
                  (service) => {
                    used = true;
                    loopbackService = service;
                    return {
                      name: SERVICE_STREAM,
                      entrypoint: STREAM_BINDING_ENTRYPOINT,
                    };
                  },
                ),
              ),
          },
          start: (ports) =>
            Effect.sync(() => {
              if (!used) return;
              const port = ports[SOCKET_USER_ENTRY];
              if (port !== undefined) {
                entryUrl = `http://127.0.0.1:${port}`;
              }
            }),
          defer: Effect.gen(function* () {
            if (!used || loopbackService === undefined) return {};
            const storageService = yield* makeStorageService;
            const streamService: WorkerdConfig.Service = {
              name: SERVICE_STREAM,
              worker: {
                compatibilityDate: "2026-03-23",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(StreamWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: STREAM_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${STREAM_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_STREAM_STORAGE },
                bindings: [
                  {
                    name: BINDING_STREAM_OBJECT,
                    durableObjectNamespace: {
                      className: STREAM_OBJECT_CLASS_NAME,
                    },
                  },
                  {
                    name: BINDING_STREAM_BLOBS,
                    service: { name: SERVICE_STREAM_STORAGE },
                  },
                  {
                    name: BINDING_STREAM_LOOPBACK,
                    service: loopbackService,
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_STREAM_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            return {
              services: [storageService, streamService],
              middlewares: [
                {
                  name: "stream:router",
                  worker: {
                    compatibilityDate: "2026-03-23",
                    modules: [
                      {
                        name: "stream/router.worker.js",
                        esModule: STREAM_ROUTER_SCRIPT,
                      },
                    ],
                    bindings: [
                      {
                        name: "STREAM",
                        service: {
                          name: SERVICE_STREAM,
                          entrypoint: STREAM_BINDING_ENTRYPOINT,
                        },
                      },
                    ],
                  },
                  upstreamBindingName: "USER_WORKER",
                  // After the entry middleware (order 0), before the user worker.
                  order: 1,
                },
              ],
            };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local Cloudflare Stream simulator (`env.<binding>.upload()`,
 * `.video(id)`, `.videos`, `.watermarks`, ...).
 *
 * Video/caption/watermark metadata and bytes are persisted under
 * `{storage}/stream` (shared by every worker in the runtime, and across
 * restarts when disk-backed storage is configured). Videos are served
 * unmodified at `{entryUrl}/cdn-cgi/mf/stream/<id>/watch` (each
 * `StreamVideo.preview` URL): this is a local video store only — no
 * transcoding or HLS ladder (the `hlsPlaybackUrl`/`dashPlaybackUrl` point at
 * a placeholder host), no signed URLs, and no direct creator uploads
 * (`createDirectUpload` throws), matching Miniflare's local fidelity limits.
 */
export const local = (
  props: StreamProps,
): BindingHook<Stream | Loopback.Loopback> =>
  Plugin.use(Stream, (stream) =>
    Effect.map(
      stream.api.register(),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        service,
      }),
    ),
  );

/** Bind to the deployed Cloudflare Stream service via the remote bindings proxy. */
export const remote = (binding: string) =>
  makeRemoteBinding({ name: binding, type: "stream" }, (service) => ({
    name: binding,
    service,
  }));
