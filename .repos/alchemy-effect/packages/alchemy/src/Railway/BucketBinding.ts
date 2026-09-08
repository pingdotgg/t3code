import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import { isRailwayHost } from "./MountVolume.ts";

/**
 * Shared scaffolding for Railway S3 bindings.
 *
 * Railway buckets speak the S3 API. Each `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeRailwayS3Binding({ operation }))` that:
 * - registers the bucket on the host so Service reconcile can write
 *   `AWS_*` / `BUCKET_NAME` variables
 * - calls `@distilled.cloud/aws/s3` with those credentials and endpoint
 *
 * NOT exported from `index.ts`.
 */
export class RailwayS3CredentialsMissing extends Data.TaggedError(
  "Railway.S3CredentialsMissing",
)<{
  name: string;
}> {}

export interface RailwayS3Scope {
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: RegionName;
}

const asPlain = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (Redacted.isRedacted(value)) return asPlain(Redacted.value(value));
  return undefined;
};

const readValue = (value: unknown): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const direct = asPlain(value);
    if (direct !== undefined) return direct;
    if (Effect.isEffect(value)) {
      return asPlain(yield* value as Effect.Effect<unknown>);
    }
    return undefined;
  });

const scopeFromResource = (bucket: Bucket) =>
  Effect.gen(function* () {
    const bucketName =
      (yield* readValue(bucket.s3BucketName)) ??
      (yield* readValue(bucket.name));
    const accessKeyId = yield* readValue(bucket.accessKeyId);
    const secretAccessKey = yield* readValue(bucket.secretAccessKey);
    const endpoint = yield* readValue(bucket.endpoint);
    const region =
      (yield* readValue(bucket.s3Region)) ??
      (yield* readValue(bucket.region)) ??
      "auto";
    if (
      bucketName === undefined ||
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      endpoint === undefined
    ) {
      return yield* new RailwayS3CredentialsMissing({
        name: bucketName ?? bucket.LogicalId,
      });
    }
    return {
      bucketName,
      accessKeyId,
      secretAccessKey,
      endpoint,
      region: region as RegionName,
    } satisfies RailwayS3Scope;
  });

const scopeFromEnv = Effect.gen(function* () {
  const bucketName = yield* Config.string("BUCKET_NAME").pipe(
    Config.orElse(() => Config.string("AWS_S3_BUCKET_NAME")),
  );
  const accessKeyId = yield* Config.string("AWS_ACCESS_KEY_ID");
  const secretAccessKey = yield* Config.redacted("AWS_SECRET_ACCESS_KEY");
  const endpoint = yield* Config.string("AWS_ENDPOINT_URL_S3").pipe(
    Config.orElse(() => Config.string("AWS_ENDPOINT_URL")),
  );
  const region = yield* Config.string("AWS_REGION").pipe(
    Config.withDefault("auto"),
  );
  return {
    bucketName,
    accessKeyId,
    secretAccessKey: Redacted.value(secretAccessKey),
    endpoint,
    region: region as RegionName,
  } satisfies RailwayS3Scope;
});

const authorizeS3 = <A, E>(
  scope: RailwayS3Scope,
  operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
): Effect.Effect<A, E, RuntimeContext> =>
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
  ) as Effect.Effect<A, E, RuntimeContext>;

export const makeRailwayS3Binding = <
  I extends { Bucket?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
}) =>
  Effect.succeed(
    Effect.fn(function* (bucket: Bucket) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isRailwayHost(host)) {
          yield* host.bind`${bucket}`({
            env: {
              AWS_ACCESS_KEY_ID: bucket.accessKeyId,
              AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
              AWS_ENDPOINT_URL_S3: bucket.endpoint,
              AWS_ENDPOINT_URL: bucket.endpoint,
              AWS_REGION: bucket.s3Region,
              BUCKET_NAME: bucket.s3BucketName,
              AWS_S3_BUCKET_NAME: bucket.s3BucketName,
              AWS_S3_URL_STYLE: bucket.urlStyle,
            },
          });
        }
      }

      return Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request?: Omit<I, "Bucket">,
      ) {
        const scope = globalThis.__ALCHEMY_RUNTIME__
          ? yield* scopeFromEnv
          : yield* scopeFromResource(bucket);
        return yield* authorizeS3(
          scope,
          options.operation({
            ...request,
            Bucket: scope.bucketName,
          } as I),
        );
      });
    }),
  );
