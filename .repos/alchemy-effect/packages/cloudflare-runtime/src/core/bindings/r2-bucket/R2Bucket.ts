import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const R2BucketWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/r2-bucket/R2Bucket.worker",
    ),
};
const R2BucketS3Worker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/r2-bucket/R2BucketS3.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type {
  R2BucketProps,
  R2S3Bucket,
  R2ServiceProps,
  S3Credentials,
} from "./R2BucketOptions.shared.ts";
import {
  BINDING_R2_BLOBS,
  BINDING_R2_ENABLE_CONTROL_ENDPOINTS,
  BINDING_R2_OBJECT,
  BINDING_R2_S3_BUCKETS,
  BINDING_R2_S3_UPSTREAM,
  R2_OBJECT_CLASS_NAME,
  SERVICE_R2,
  SERVICE_R2_STORAGE,
} from "./R2BucketOptions.shared.ts";

export class R2Bucket extends Plugin.Service<
  R2Bucket,
  {
    /**
     * Record that a bucket is in use (so the R2 services are only emitted
     * when at least one binding exists) and resolve the service designator
     * the binding should target: the shared `r2` service, with the bucket
     * name carried via designator props.
     *
     * Buckets registered with `s3Credentials` are also served over the local
     * S3-compatible endpoint (`/cdn-cgi/local/r2/s3/{bucketName}`).
     */
    readonly register: (
      props: R2ServiceProps,
      options?: { readonly s3Credentials?: S3Credentials },
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/R2Bucket") {}

const r2Designator = (
  props: R2ServiceProps,
): WorkerdConfig.ServiceDesignator => ({
  name: SERVICE_R2,
  props: { json: JSON.stringify(props) },
});

export const R2BucketLive = Layer.effect(
  R2Bucket,
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
          subtag: "R2Bucket",
          message:
            "Cannot configure R2 persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "r2");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "R2Bucket",
              message: `Failed to create R2 persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_R2_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    /**
     * The S3-compatible endpoint, a fetch middleware after `plugin:entry`
     * (which restores the client-facing URL and Host that SigV4 signs).
     * Each exposed bucket is an ordinary `r2Bucket` binding onto the shared
     * `r2` service.
     */
    const makeS3Middleware = (s3Buckets: ReadonlyMap<string, S3Credentials>) =>
      Effect.gen(function* () {
        const buckets: Record<string, R2S3Bucket> = {};
        const bindings: Array<WorkerdConfig.Worker_Binding> = [];
        let index = 0;
        for (const [bucketName, credentials] of s3Buckets) {
          const binding = `BUCKET_${index++}`;
          buckets[bucketName] = { binding, credentials };
          bindings.push({
            name: binding,
            r2Bucket: r2Designator({ bucketName }),
          });
        }
        return {
          name: "r2:s3",
          worker: {
            compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
            modules: formatInternalWorkerModules(
              yield* Effect.promise(R2BucketS3Worker.worker),
            ),
            bindings: [
              { name: BINDING_R2_S3_BUCKETS, json: JSON.stringify(buckets) },
              ...bindings,
            ],
          },
          upstreamBindingName: BINDING_R2_S3_UPSTREAM,
          order: 1,
        } satisfies Plugin.Middleware;
      });

    return R2Bucket.of(
      Effect.sync(() => {
        let used = false;
        const s3Buckets = new Map<string, S3Credentials>();
        const s3Conflicts = new Set<string>();

        return {
          api: {
            register: (props, options) =>
              Effect.sync(() => {
                used = true;
                const credentials = options?.s3Credentials;
                if (credentials !== undefined) {
                  const existing = s3Buckets.get(props.bucketName);
                  if (
                    existing !== undefined &&
                    (existing.accessKeyId !== credentials.accessKeyId ||
                      existing.secretAccessKey !== credentials.secretAccessKey)
                  ) {
                    s3Conflicts.add(props.bucketName);
                  }
                  s3Buckets.set(props.bucketName, credentials);
                }
                return r2Designator(props);
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            if (s3Conflicts.size > 0) {
              return yield* new ConfigError({
                subtag: "R2Bucket",
                message: `R2 bucket(s) ${[...s3Conflicts].map((name) => `"${name}"`).join(", ")} were bound with different S3 credentials.`,
                hint: "Use the same `s3Credentials` for every binding of a bucket.",
                detail: { buckets: [...s3Conflicts] },
              });
            }
            const storageService = yield* makeStorageService;
            const r2Service: WorkerdConfig.Service = {
              name: SERVICE_R2,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                // `node:crypto` is used to synchronously compute multipart etags
                // Node.js compatibility is default-on for the 2026-08-31
                // internal compatibility date.
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(R2BucketWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: R2_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${R2_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_R2_STORAGE },
                bindings: [
                  {
                    name: BINDING_R2_OBJECT,
                    durableObjectNamespace: { className: R2_OBJECT_CLASS_NAME },
                  },
                  {
                    name: BINDING_R2_BLOBS,
                    service: { name: SERVICE_R2_STORAGE },
                  },
                  ...(enableControlEndpoints
                    ? [
                        {
                          name: BINDING_R2_ENABLE_CONTROL_ENDPOINTS,
                          json: "true",
                        },
                      ]
                    : []),
                ],
              },
            };
            return {
              services: [storageService, r2Service],
              middlewares:
                s3Buckets.size > 0 ? [yield* makeS3Middleware(s3Buckets)] : [],
            };
          }),
        };
      }),
    );
  }),
);

/**
 * Bind a local R2 bucket (`env.<binding>.get()` / `.put()` / `.list()` /
 * `.delete()` / multipart uploads).
 *
 * Data is persisted under `{storage}/r2`, keyed by the bucket id, so bindings
 * with the same `id` share data (including across workers and restarts when
 * disk-backed storage is configured).
 *
 * With `s3Credentials`, the bucket is also served over the local
 * S3-compatible endpoint at `{worker url}/cdn-cgi/local/r2/s3/{id}` —
 * SigV4-authenticated with those credentials, so S3 clients and presigned
 * URLs (e.g. browser uploads) work against the local bucket.
 */
export const local = (props: R2BucketProps): BindingHook<R2Bucket> =>
  Plugin.use(R2Bucket, (r2) =>
    Effect.map(
      r2.api.register(
        { bucketName: props.id ?? props.binding },
        { s3Credentials: props.s3Credentials },
      ),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        r2Bucket: service,
      }),
    ),
  );

export const remote = (
  binding: string,
  bucketName: string,
  jurisdiction?: string,
) =>
  makeRemoteBinding(
    { name: binding, type: "r2_bucket", bucketName, jurisdiction, raw: true },
    (service) => ({
      name: binding,
      r2Bucket: service,
    }),
  );
