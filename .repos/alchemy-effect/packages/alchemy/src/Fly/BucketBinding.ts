import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import { TigrisCredentialsMissing } from "./Errors.ts";
import type { ServiceBinding } from "./MountVolume.ts";

/**
 * Shared scaffolding for Tigris S3 bindings.
 *
 * Tigris speaks the S3 API. Each `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeTigrisS3Binding({ operation }))` that:
 * - registers the bucket on the host so Service reconcile can write
 *   Tigris `AWS_*` / `BUCKET_NAME` App secrets
 * - calls `@distilled.cloud/aws/s3` with those credentials and endpoint
 *
 * NOT exported from `index.ts`.
 */
export interface TigrisS3Scope {
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: RegionName;
}

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

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
      (yield* readValue(bucket.bucketName)) ?? (yield* readValue(bucket.name));
    const accessKeyId = yield* readValue(bucket.accessKeyId);
    const secretAccessKey = yield* readValue(bucket.secretAccessKey);
    const endpoint = yield* readValue(bucket.endpoint);
    const region = (yield* readValue(bucket.region)) ?? "auto";
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
    return {
      bucketName,
      accessKeyId,
      secretAccessKey,
      endpoint,
      region: region as RegionName,
    } satisfies TigrisS3Scope;
  });

const scopeFromEnv = Effect.gen(function* () {
  const bucketName = yield* Config.string("BUCKET_NAME");
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
  } satisfies TigrisS3Scope;
}).pipe(Effect.orDie);

const authorizeS3 = <A, E>(
  scope: TigrisS3Scope,
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

export const makeTigrisS3Binding = <
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
        if (isFlyHost(host)) {
          // Pass the Bucket resource itself so waitForDeps waits for it
          // and apply evaluates to attributes (including create-only
          // Tigris credentials). PropExprs of `name` alone can resolve
          // from the deterministic physical name without waiting.
          yield* host.bind`${bucket}`({
            bucket: bucket as unknown as { name: string; id?: string },
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
