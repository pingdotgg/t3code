// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as NodeHttp from "node:http";
import type { Sharp } from "sharp";
const ImagesWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/images/Images.worker",
    ),
};
const ImagesStoreWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/images/ImagesStore.worker",
    ),
};
import * as Loopback from "../../globals/Loopback.ts";
import type * as LoopbackServer from "../../globals/LoopbackServer.ts";
import * as Storage from "../../globals/Storage.ts";
import { SOCKET_USER_ENTRY } from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import { PluginContext, type BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import {
  BINDING_KV_BLOBS,
  BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
  BINDING_KV_OBJECT,
  KV_OBJECT_CLASS_NAME,
} from "../kv-namespace/KvNamespaceOptions.shared.ts";
import type { ImagesProps } from "./ImagesOptions.shared.ts";
import {
  BINDING_IMAGES_LOOPBACK,
  BINDING_IMAGES_STORE,
  PATH_IMAGE_DELIVERY,
  PATH_IMAGES_PUBLIC_URL,
  SERVICE_IMAGES,
  SERVICE_IMAGES_STORAGE,
  SERVICE_IMAGES_STORE,
} from "./ImagesOptions.shared.ts";

export class Images extends Plugin.Service<
  Images,
  {
    /**
     * Record that a local `images` binding is in use (so the images services
     * are only emitted when at least one binding exists), register the
     * node-side loopback route that runs Sharp transforms, and resolve the
     * service designator the wrapped `cloudflare-internal:images-api` binding
     * should target.
     */
    readonly register: () => Effect.Effect<
      WorkerdConfig.ServiceDesignator,
      ConfigError,
      PluginContext | Loopback.Loopback
    >;
  }
>()("cloudflare-runtime/plugin/Images") {}

export const ImagesLive = Layer.effect(
  Images,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;
    const enableControlEndpoints = yield* Plugin.UnsafeEnableControlEndpoints;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Images",
          message:
            "Cannot configure Images persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "images");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Images",
              message: `Failed to create Images persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_IMAGES_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Images.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;

        let used = false;
        let loopbackService: WorkerdConfig.ServiceDesignator | undefined;
        // The workerd entry port, captured in `start` — the images worker
        // resolves it through the loopback to build absolute variant URLs
        // (Miniflare's `/core/public-url`).
        let publicPort: number | undefined;

        /**
         * Node-side handler for the images loopback route:
         *
         * - `GET {PATH_IMAGES_PUBLIC_URL}` — the runtime entry URL (or
         *   `null` before the runtime is listening).
         * - everything else — the Sharp transform/info fetcher
         *   ({@link imagesLocalFetcher}), selected by pathname (`/info` vs
         *   transform).
         */
        const handler: LoopbackServer.RawHandler = async (req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (url.pathname === PATH_IMAGES_PUBLIC_URL) {
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(
                JSON.stringify(
                  publicPort === undefined
                    ? null
                    : `http://127.0.0.1:${publicPort}`,
                ),
              );
            return;
          }
          const response = await imagesLocalFetcher(
            await readNodeRequest(req, url),
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        };

        return {
          api: {
            register: () =>
              Plugin.use(Loopback.Loopback, (loopback) =>
                Effect.map(
                  loopback.api.route(`images:${worker.name}`, handler),
                  (service) => {
                    used = true;
                    loopbackService = service;
                    return { name: SERVICE_IMAGES };
                  },
                ),
              ),
          },
          start: (ports) =>
            Effect.sync(() => {
              publicPort = ports[SOCKET_USER_ENTRY];
            }),
          defer: Effect.gen(function* () {
            if (!used || loopbackService === undefined) return {};
            const storageService = yield* makeStorageService;
            const storeService: WorkerdConfig.Service = {
              name: SERVICE_IMAGES_STORE,
              worker: {
                compatibilityDate: "2025-01-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(ImagesStoreWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: KV_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-images-${KV_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_IMAGES_STORAGE },
                bindings: [
                  {
                    name: BINDING_KV_OBJECT,
                    durableObjectNamespace: { className: KV_OBJECT_CLASS_NAME },
                  },
                  {
                    name: BINDING_KV_BLOBS,
                    service: { name: SERVICE_IMAGES_STORAGE },
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_KV_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            const imagesService: WorkerdConfig.Service = {
              name: SERVICE_IMAGES,
              worker: {
                compatibilityDate: "2025-04-01",
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(ImagesWorker.worker),
                ),
                bindings: [
                  {
                    name: BINDING_IMAGES_STORE,
                    kvNamespace: { name: SERVICE_IMAGES_STORE },
                  },
                  {
                    name: BINDING_IMAGES_LOOPBACK,
                    service: loopbackService,
                  },
                ],
              },
            };
            // Serve hosted variant URLs (`/cdn-cgi/mf/imagedelivery/...`)
            // from the entry chain, mirroring Miniflare's core entry routing
            // (`SERVICE_IMAGES_DELIVERY`). Sits inside the `plugin:entry`
            // middleware (order 0) and before the user worker.
            const deliveryMiddleware: Plugin.Middleware = {
              name: "images:delivery",
              worker: {
                compatibilityDate: "2025-01-01",
                modules: [
                  {
                    name: "images/delivery.worker.js",
                    esModule: `
                      export default {
                        fetch(request, env) {
                          const url = new URL(request.url);
                          if (url.pathname.startsWith("${PATH_IMAGE_DELIVERY}/")) {
                            return env.IMAGES.fetch(request);
                          }
                          return env.UPSTREAM.fetch(request);
                        }
                      }
                    `,
                  },
                ],
                bindings: [
                  { name: "IMAGES", service: { name: SERVICE_IMAGES } },
                ],
              },
              upstreamBindingName: "UPSTREAM",
              order: 1,
            };
            return {
              services: [storageService, storeService, imagesService],
              middlewares: [deliveryMiddleware],
            };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local Images simulator (`env.<binding>.input(...)/.info(...)` and the
 * hosted CRUD surface) for `alchemy dev`.
 *
 * The binding is workerd's real `cloudflare-internal:images-api` module
 * pointed at a local service: hosted images are stored in a KV-backed store
 * persisted under `{storage}/images` (variant URLs are served at
 * `/cdn-cgi/mf/imagedelivery/...` on the worker's own URL), and pixel work
 * (resize / rotate / transcode) runs in Node.js via Sharp over the loopback.
 *
 * Low fidelity, matching Miniflare's local mode: draws/overlays are ignored,
 * GIF and RGB/RGBA outputs fail with a 415 error (code 9520), and SVG inputs
 * are not transformed.
 */
export const local = (
  props: ImagesProps,
): BindingHook<Images | Loopback.Loopback> =>
  Plugin.use(Images, (images) =>
    Effect.map(
      images.api.register(),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        wrapped: {
          moduleName: "cloudflare-internal:images-api",
          innerBindings: [
            {
              name: "fetcher",
              service,
            },
          ],
        },
      }),
    ),
  );

/** Bind to the deployed Images service via the remote bindings proxy. */
export const remote = (binding: string) =>
  makeRemoteBinding(
    { name: binding, type: "images", raw: true },
    (service) => ({
      name: binding,
      wrapped: {
        moduleName: "cloudflare-internal:images-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
        ],
      },
    }),
  );

// -----------------------------------------------------------------------------
// Node-side Sharp fetcher, adapted from Miniflare's images plugin
// (`workers-sdk/packages/miniflare/src/plugins/images/fetcher.ts`,
// `imagesLocalFetcher`). Local Sharp mock for the Images binding
// (`env.IMAGES`). Low fidelity (resize/rotate/transcode only); unsupported
// options are ignored. Deltas from upstream:
// - Output bytes are buffered (`toBuffer`) instead of streamed, so a Sharp
//   failure surfaces as a loopback 500 rather than a broken stream.
// - The `cf.image` outbound fetcher (`cfImageLocalFetcher`) is not ported:
//   this runtime has no outbound `fetch(url, { cf: { image } })` rewriting.
// -----------------------------------------------------------------------------

/** Read a Node.js request into a fetch `Request` (bodies are buffered). */
async function readNodeRequest(
  req: NodeHttp.IncomingMessage,
  url: URL,
): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Array<Buffer> = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url.toString(), { method, headers, body });
}

interface Transform {
  imageIndex?: number;
  rotate?: number;
  width?: number;
  height?: number;
}

function validateTransforms(inputTransforms: unknown): Array<Transform> | null {
  if (!Array.isArray(inputTransforms)) {
    return null;
  }

  for (const transform of inputTransforms) {
    for (const key of ["imageIndex", "rotate", "width", "height"]) {
      if (transform[key] !== undefined && typeof transform[key] !== "number") {
        return null;
      }
    }
  }

  return inputTransforms as Array<Transform>;
}

export async function imagesLocalFetcher(request: Request): Promise<Response> {
  let sharp;
  try {
    const { default: importedSharp } = await import("sharp");
    sharp = importedSharp;
  } catch {
    return errorResponse(
      503,
      9523,
      "The Sharp library is not available, check your version of Node is compatible",
    );
  }

  const data = await request.formData();

  // Cloudflare's FormData typing omits file values in the Node build even
  // though the runtime returns a Blob for multipart file fields.
  const body: unknown = data.get("image");
  if (!(body instanceof Blob)) {
    return errorResponse(
      400,
      9523,
      `ERROR: Internal Images binding error: expected image in request, got ${body}`,
    );
  }

  const transformer = sharp(await body.arrayBuffer(), {});

  const url = new URL(request.url);

  if (url.pathname === "/info") {
    return runInfo(transformer);
  } else {
    const badTransformsResponse = errorResponse(
      400,
      9523,
      "ERROR: Internal Images binding error: Expected JSON array of valid transforms in transforms field",
    );
    try {
      const transformsJson = data.get("transforms");

      if (typeof transformsJson !== "string") {
        return badTransformsResponse;
      }

      const transforms = validateTransforms(JSON.parse(transformsJson));

      if (transforms === null) {
        return badTransformsResponse;
      }

      const outputFormat = data.get("output_format");

      if (outputFormat != null && typeof outputFormat !== "string") {
        return errorResponse(
          400,
          9523,
          "ERROR: Internal Images binding error: Expected output format to be a string if provided",
        );
      }

      return await runTransform(transformer, transforms, outputFormat);
    } catch {
      return badTransformsResponse;
    }
  }
}

async function runInfo(transformer: Sharp): Promise<Response> {
  const metadata = await transformer.metadata();

  let mime: string | null = null;
  switch (metadata.format) {
    case "jpeg":
      mime = "image/jpeg";
      break;
    case "svg":
      mime = "image/svg+xml";
      break;
    case "png":
      mime = "image/png";
      break;
    case "webp":
      mime = "image/webp";
      break;
    case "gif":
      mime = "image/gif";
      break;
    // libvips reports both AVIF and HEIC as `heif`, distinguished by the
    // compression codec. AVIF (av1) is the only variant Cloudflare Images
    // accepts, and the only one the bundled libvips can decode.
    case "heif":
      if (metadata.compression !== "av1") {
        return errorResponse(
          415,
          9520,
          `ERROR: Unsupported image type ${metadata.format}, expected one of: JPEG, SVG, PNG, WebP, GIF or AVIF`,
        );
      }
      mime = "image/avif";
      break;
    default:
      return errorResponse(
        415,
        9520,
        `ERROR: Unsupported image type ${metadata.format}, expected one of: JPEG, SVG, PNG, WebP, GIF or AVIF`,
      );
  }

  if (mime === "image/svg+xml") {
    return Response.json({ format: mime });
  }

  if (!metadata.size || !metadata.width || !metadata.height) {
    return errorResponse(
      500,
      9523,
      "ERROR: Internal Images binding error: Expected size, width and height for bitmap input",
    );
  }

  return Response.json({
    format: mime,
    fileSize: metadata.size,
    width: metadata.width,
    height: metadata.height,
  });
}

async function runTransform(
  transformer: Sharp,
  transforms: Array<Transform>,
  outputFormat: string | null,
): Promise<Response> {
  for (const transform of transforms) {
    if (transform.imageIndex !== undefined && transform.imageIndex !== 0) {
      // We don't support draws, and this transform doesn't apply to the root
      // image, so skip it
      continue;
    }

    if (transform.rotate !== undefined) {
      transformer.rotate(transform.rotate);
    }

    if (transform.width !== undefined || transform.height !== undefined) {
      transformer.resize(transform.width || null, transform.height || null, {
        fit: "contain",
      });
    }
  }

  switch (outputFormat) {
    case "image/avif":
      transformer.avif();
      break;
    case "image/gif":
      return errorResponse(
        415,
        9520,
        "ERROR: GIF output is not supported in local mode",
      );
    case "image/jpeg":
      transformer.jpeg();
      break;
    case "image/png":
      transformer.png();
      break;
    case "image/webp":
      transformer.webp();
      break;
    case "rgb":
    case "rgba":
      return errorResponse(
        415,
        9520,
        "ERROR: RGB/RGBA output is not supported in local mode",
      );
    default:
      outputFormat = "image/jpeg";
      break;
  }

  const output = await transformer.toBuffer();
  return new Response(new Uint8Array(output), {
    headers: {
      "content-type": outputFormat,
    },
  });
}

function errorResponse(
  status: number,
  code: number,
  message: string,
): Response {
  return new Response(`ERROR ${code}: ${message}`, {
    status,
    headers: {
      "content-type": "text/plain",
      "cf-images-binding": `err=${code}`,
    },
  });
}
