/**
 * vinext data-cache adapter backed by S3. Default export is the factory
 * `virtual:vinext-cache-adapters` calls as `({ env, options }) => CacheHandler`.
 *
 * Uses distilled `@distilled.cloud/aws/s3` — the same client
 * `AWS.S3.GetObject` / `PutObject` / `DeleteObject` wrap. Credentials come
 * from the Lambda environment (`Credentials.fromEnv`), matching the
 * Function bootstrap. Prerender artifacts are seeded into S3 in the
 * background so cold starts HIT.
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { layer as fetchHttpClientLayer } from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import { makeDataCacheHandler, type DataCacheStore } from "./handler.ts";
import { readEnvString } from "./shared.ts";
import { seedStoreFromPrerenderLogged } from "./seed.ts";

export interface S3AdapterOptions extends Record<string, unknown> {
  /** Env var holding the bucket name. @default "CACHE_BUCKET_NAME" */
  readonly bucketEnv?: string;
  /** Key prefix inside the bucket. @default "vinext-cache/" */
  readonly prefix?: string;
  readonly appPrefix?: string;
  readonly ttlSeconds?: number;
  readonly tagCacheTtlMs?: number;
}

const DEFAULT_BUCKET_ENV = "CACHE_BUCKET_NAME";
const DEFAULT_PREFIX = "vinext-cache/";

const awsLayer = Layer.mergeAll(Credentials.fromEnv(), fetchHttpClientLayer);

const runAws = <A, E>(
  effect: Effect.Effect<A, E, Credentials.Credentials | HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(awsLayer)));

const s3Store = (bucket: string, prefix: string): DataCacheStore => {
  const objectKey = (key: string) => `${prefix}${key}`;
  return {
    async getText(key) {
      return runAws(
        S3.getObject({
          Bucket: bucket,
          Key: objectKey(key),
        }).pipe(
          Effect.flatMap((result) =>
            result.Body === undefined
              ? Effect.succeed(undefined)
              : Stream.mkString(Stream.decodeText(result.Body)),
          ),
          Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        ),
      );
    },
    async putText(key, value) {
      await runAws(
        S3.putObject({
          Bucket: bucket,
          Key: objectKey(key),
          Body: value,
          ContentType: "application/json",
        }),
      );
    },
    async delete(key) {
      await runAws(
        S3.deleteObject({
          Bucket: bucket,
          Key: objectKey(key),
        }).pipe(Effect.catchTag("NoSuchKey", () => Effect.void)),
      );
    },
  };
};

const createS3DataCacheAdapter = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: S3AdapterOptions;
}) => {
  const bucketEnv = options?.bucketEnv ?? DEFAULT_BUCKET_ENV;
  const bucket = readEnvString(env, bucketEnv);
  if (bucket === undefined) {
    throw new Error(
      `[vinext] The S3 data cache adapter requires \`${bucketEnv}\` in the process environment.`,
    );
  }
  const store = s3Store(bucket, options?.prefix ?? DEFAULT_PREFIX);
  let handler: ReturnType<typeof makeDataCacheHandler> | undefined;
  const ready = seedStoreFromPrerenderLogged(store, "S3").then(() => {
    handler = makeDataCacheHandler(store, options);
    return handler;
  });
  return {
    async get(key: string, ctx?: Record<string, unknown>) {
      return (handler ?? (await ready)).get(key, ctx);
    },
    async set(
      key: string,
      data: Record<string, unknown> | null,
      ctx?: Record<string, unknown>,
    ) {
      return (handler ?? (await ready)).set(key, data, ctx);
    },
    async revalidateTag(tags: string | Array<string>) {
      return (handler ?? (await ready)).revalidateTag(tags);
    },
    resetRequestCache() {
      handler?.resetRequestCache();
    },
  };
};

export default createS3DataCacheAdapter;
