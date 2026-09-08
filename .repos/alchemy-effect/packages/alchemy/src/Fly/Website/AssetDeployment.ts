import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { createHash } from "node:crypto";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { initialCwd } from "../../Util/Node.ts";
import { cacheControlOf, contentTypeOf } from "../../Website/assets.ts";
import type { Bucket } from "../Bucket.ts";
import { TigrisCredentialsMissing } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

const s3Concurrency = 16;

/**
 * Unwrap Tigris {@link Bucket} attrs for the S3 client. Credentials and
 * the endpoint are `Redacted<string>`; names are plain strings. This is
 * Fly Bucket plumbing, not website MIME — it stays here because this
 * resource is the only Website helper that speaks Tigris.
 */
const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) {
    const inner = Redacted.value(value);
    return typeof inner === "string" && inner.length > 0 ? inner : undefined;
  }
  return undefined;
};

export interface AssetDeploymentProps {
  /**
   * Destination Tigris bucket (a {@link Bucket} resource).
   */
  bucket: Bucket;
  /**
   * Local directory to upload (framework `clientDirectory`).
   */
  sourcePath: string;
  /**
   * Optional key prefix within the bucket.
   */
  prefix?: string;
  /**
   * Delete observed keys under the prefix that are not in this deploy.
   * @default true
   */
  purge?: boolean;
}

export interface AssetDeployment extends Resource<
  "Fly.Website.AssetDeployment",
  AssetDeploymentProps,
  {
    bucketName: string;
    prefix: string;
    version: string;
    fileCount: number;
    files: string[];
  },
  never,
  Providers
> {}

/**
 * Upload a local directory into a public Tigris bucket for Fly Website
 * statics. HTML is never cached; everything else is immutable.
 *
 * @resource
 */
export const AssetDeployment = Resource<AssetDeployment>(
  "Fly.Website.AssetDeployment",
);

const normalizePrefix = (prefix: string | undefined) =>
  prefix ? prefix.replace(/^\/+|\/+$/g, "") : "";

const scopeOf = (bucket: Bucket) =>
  Effect.gen(function* () {
    const bucketName = asPlain(bucket.bucketName) ?? asPlain(bucket.name);
    const accessKeyId = asPlain(bucket.accessKeyId);
    const secretAccessKey = asPlain(bucket.secretAccessKey);
    const endpoint = asPlain(bucket.endpoint);
    const region = (asPlain(bucket.region) ?? "auto") as RegionName;
    if (
      bucketName === undefined ||
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      endpoint === undefined
    ) {
      return yield* new TigrisCredentialsMissing({
        name: bucketName ?? bucket.LogicalId,
      });
    }
    return { bucketName, accessKeyId, secretAccessKey, endpoint, region };
  });

const withTigris = <A, E>(
  scope: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: RegionName;
  },
  operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  operation.pipe(
    Effect.provide(
      Layer.mergeAll(
        fromCredentials(
          {
            accessKeyId: scope.accessKeyId,
            secretAccessKey: scope.secretAccessKey,
          },
          scope.region,
        ),
        AwsEndpoint.of(scope.endpoint),
        FetchHttpClient.layer,
      ),
    ),
  );

const walkFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(root))) return [] as string[];
  const names = yield* fs.readDirectory(root, { recursive: true });
  const files = yield* Effect.all(
    names.map((name) =>
      Effect.gen(function* () {
        const full = path.join(root, name);
        const stat = yield* fs.stat(full);
        return stat.type === "File" ? name.replaceAll("\\", "/") : undefined;
      }),
    ),
    { concurrency: "unbounded" },
  );
  return files
    .filter((name): name is string => name !== undefined)
    .sort((a, b) => a.localeCompare(b));
});

const listObserved = (
  scope: {
    bucketName: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: RegionName;
  },
  prefix: string,
) =>
  withTigris(
    scope,
    s3.listObjectsV2
      .pages({
        Bucket: scope.bucketName,
        Prefix: prefix.length > 0 ? `${prefix}/` : undefined,
      })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
        Stream.runFold(
          () => new Map<string, string | undefined>(),
          (observed, object) => {
            if (object.Key !== undefined) {
              observed.set(object.Key, object.ETag);
            }
            return observed;
          },
        ),
      ),
  );

const deleteObject = (
  scope: {
    bucketName: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: RegionName;
  },
  key: string,
) =>
  withTigris(
    scope,
    s3.deleteObject({
      Bucket: scope.bucketName,
      Key: key,
    }),
  ).pipe(Effect.catchTag("NoSuchKey", () => Effect.void));

export const AssetDeploymentProvider = () =>
  Provider.effect(
    AssetDeployment,
    Effect.succeed({
      list: () => Effect.succeed([]),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      reconcile: Effect.fn(function* ({ news, session }) {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const scope = yield* scopeOf(news.bucket);
        const prefix = normalizePrefix(news.prefix);
        const root = path.isAbsolute(news.sourcePath)
          ? news.sourcePath
          : path.resolve(initialCwd, news.sourcePath);
        const files = yield* walkFiles(root);
        const observed = yield* listObserved(scope, prefix);
        const prepared = yield* Effect.all(
          files.map((relative) =>
            Effect.gen(function* () {
              const body = yield* fs.readFile(path.join(root, relative));
              const key =
                prefix.length > 0 ? `${prefix}/${relative}` : relative;
              const contentType = contentTypeOf(relative);
              const cacheControl = cacheControlOf(relative);
              return { relative, key, body, contentType, cacheControl };
            }),
          ),
          { concurrency: "unbounded" },
        );
        const version = yield* Effect.sync(() => {
          const hash = createHash("sha256");
          for (const file of prepared) {
            hash.update(file.relative);
            hash.update(file.body);
            hash.update(file.contentType);
            hash.update(file.cacheControl);
          }
          return hash.digest("hex");
        });
        const desired = new Set(prepared.map((file) => file.key));
        yield* Effect.all(
          prepared.flatMap((file) => {
            const expected = createHash("md5").update(file.body).digest("hex");
            const etag = observed.get(file.key)?.replace(/^"|"$/g, "");
            if (etag === expected) return [];
            return [
              withTigris(
                scope,
                s3.putObject({
                  Bucket: scope.bucketName,
                  Key: file.key,
                  Body: file.body,
                  ContentType: file.contentType,
                  CacheControl: file.cacheControl,
                }),
              ),
            ];
          }),
          { concurrency: s3Concurrency },
        );

        if (news.purge ?? true) {
          yield* Effect.all(
            [...observed.keys()]
              .filter((key) => !desired.has(key))
              .map((key) => deleteObject(scope, key)),
            { concurrency: s3Concurrency },
          );
        }

        const output = {
          bucketName: scope.bucketName,
          prefix,
          version,
          fileCount: files.length,
          files: prepared.map((file) => file.relative),
        };
        yield* session.note(
          `Uploaded ${output.fileCount} file(s) to tigris://${output.bucketName}/${output.prefix}`,
        );
        return output;
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        if (!(olds.purge ?? true)) return;
        const scope = yield* scopeOf(olds.bucket);
        const observed = yield* listObserved(scope, output.prefix);
        yield* Effect.all(
          [...observed.keys()].map((key) => deleteObject(scope, key)),
          { concurrency: s3Concurrency },
        );
      }),
    }),
  );
