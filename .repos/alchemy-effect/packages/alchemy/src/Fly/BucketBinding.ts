import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
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
 * - registers the bucket on the host so Service reconcile can wait for
 *   it and attach Tigris App secrets
 * - `yield*`s credential Outputs so RuntimeContext.set runs
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

      const bucketName = yield* bucket.bucketName;
      const name = yield* bucket.name;
      const accessKeyId = yield* bucket.accessKeyId;
      const secretAccessKey = yield* bucket.secretAccessKey;
      const endpoint = yield* bucket.endpoint;
      const region = yield* bucket.region;

      return Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request?: Omit<I, "Bucket">,
      ) {
        const resolvedName = asPlain(yield* bucketName) ?? asPlain(yield* name);
        const resolvedKey = asPlain(yield* accessKeyId);
        const resolvedSecret = asPlain(yield* secretAccessKey);
        const resolvedEndpoint = asPlain(yield* endpoint);
        const resolvedRegion = asPlain(yield* region) ?? "auto";
        if (
          resolvedName === undefined ||
          resolvedKey === undefined ||
          resolvedSecret === undefined ||
          resolvedEndpoint === undefined
        ) {
          return yield* new TigrisCredentialsMissing({
            name: resolvedName ?? bucket.LogicalId,
          });
        }
        const scope = {
          bucketName: resolvedName,
          accessKeyId: resolvedKey,
          secretAccessKey: resolvedSecret,
          endpoint: resolvedEndpoint,
          region: resolvedRegion as RegionName,
        } satisfies TigrisS3Scope;
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
