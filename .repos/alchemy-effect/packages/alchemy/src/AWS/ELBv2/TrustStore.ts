import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type TrustStoreArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:truststore/${string}`;

export interface TrustStoreProps {
  /** The trust store name. If omitted, a unique name is generated. Changing it replaces the trust store. */
  name?: string;
  /** The S3 bucket holding the CA certificate bundle (PEM). */
  caCertificatesBundleS3Bucket: string;
  /** The S3 key of the CA certificate bundle. */
  caCertificatesBundleS3Key: string;
  /** The S3 object version of the CA certificate bundle. */
  caCertificatesBundleS3ObjectVersion?: string;
  /** Tags to apply to the trust store. */
  tags?: Record<string, string>;
}

export interface TrustStore extends Resource<
  "AWS.ELBv2.TrustStore",
  TrustStoreProps,
  {
    /** The ARN of the trust store. */
    trustStoreArn: TrustStoreArn;
    /** The name of the trust store. */
    name: string;
    /** The status of the trust store (`ACTIVE` or `CREATING`). */
    status: string;
    /** The number of CA certificates in the trust store's bundle. */
    numberOfCaCertificates: number;
    /** The tags applied to the trust store. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An ELBv2 trust store. A trust store holds the CA certificate bundle used by
 * an HTTPS listener configured for mutual TLS (mTLS) `verify` mode to validate
 * client certificates.
 * @resource
 * @section Creating a Trust Store
 * @example Basic trust store from an S3 CA bundle
 * ```typescript
 * const trustStore = yield* TrustStore("mtls", {
 *   caCertificatesBundleS3Bucket: "my-ca-bundles",
 *   caCertificatesBundleS3Key: "ca-bundle.pem",
 * });
 * ```
 *
 * @example Using a trust store on an mTLS listener
 * ```typescript
 * const listener = yield* Listener("https", {
 *   loadBalancerArn: lb.loadBalancerArn,
 *   port: 443,
 *   protocol: "HTTPS",
 *   certificates: [certArn],
 *   mutualAuthentication: {
 *     mode: "verify",
 *     trustStoreArn: trustStore.trustStoreArn,
 *   },
 *   defaultActions: [
 *     { type: "forward", targetGroups: [{ targetGroupArn: tg.targetGroupArn }] },
 *   ],
 * });
 * ```
 */
export const TrustStore = Resource<TrustStore>("AWS.ELBv2.TrustStore");

export const TrustStoreProvider = () =>
  Provider.effect(
    TrustStore,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 32, lowercase: true });

      const observedTags = (arn: string) =>
        Effect.gen(function* () {
          const tagDescriptions = yield* elbv2.describeTags({
            ResourceArns: [arn],
          });
          return Object.fromEntries(
            (tagDescriptions.TagDescriptions?.[0]?.Tags ?? [])
              .filter(
                (t): t is { Key: string; Value: string } =>
                  typeof t.Key === "string" && typeof t.Value === "string",
              )
              .map((t) => [t.Key, t.Value]),
          );
        });

      return {
        stables: ["trustStoreArn", "name"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output) {
            return undefined;
          }
          const described = yield* elbv2
            .describeTrustStores({
              TrustStoreArns: [output.trustStoreArn],
            })
            .pipe(
              Effect.catchTag("TrustStoreNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          const trustStore = described?.TrustStores?.[0];
          if (!trustStore?.TrustStoreArn) {
            return undefined;
          }
          return {
            ...output,
            name: trustStore.Name!,
            status: trustStore.Status!,
            numberOfCaCertificates: trustStore.NumberOfCaCertificates ?? 0,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const trustStores = yield* elbv2.describeTrustStores.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.TrustStores ?? []).filter(
                    (ts): ts is elbv2.TrustStore & { TrustStoreArn: string } =>
                      ts.TrustStoreArn != null,
                  ),
                ),
              ),
            );
            return yield* Effect.forEach(
              trustStores,
              (ts) =>
                Effect.gen(function* () {
                  const tags = yield* observedTags(ts.TrustStoreArn).pipe(
                    Effect.catchTag("TrustStoreNotFoundException", () =>
                      Effect.succeed({} as Record<string, string>),
                    ),
                  );
                  return {
                    trustStoreArn: ts.TrustStoreArn as TrustStoreArn,
                    name: ts.Name!,
                    status: ts.Status!,
                    numberOfCaCertificates: ts.NumberOfCaCertificates ?? 0,
                    tags,
                  };
                }),
              { concurrency: 10 },
            );
          }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const name = yield* toName(id, news);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Observe — look up by deterministic name.
          const described = yield* elbv2
            .describeTrustStores({ Names: [name] })
            .pipe(
              Effect.catchTag("TrustStoreNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          let trustStore = described?.TrustStores?.[0];

          // Ensure — create if missing.
          if (!trustStore?.TrustStoreArn) {
            const created = yield* elbv2.createTrustStore({
              Name: name,
              CaCertificatesBundleS3Bucket: news.caCertificatesBundleS3Bucket,
              CaCertificatesBundleS3Key: news.caCertificatesBundleS3Key,
              CaCertificatesBundleS3ObjectVersion:
                news.caCertificatesBundleS3ObjectVersion,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            trustStore = created.TrustStores?.[0];
            if (!trustStore?.TrustStoreArn) {
              return yield* Effect.die(
                new Error("createTrustStore returned no trust store"),
              );
            }
          } else {
            // Sync the CA bundle in place.
            const modified = yield* elbv2.modifyTrustStore({
              TrustStoreArn: trustStore.TrustStoreArn,
              CaCertificatesBundleS3Bucket: news.caCertificatesBundleS3Bucket,
              CaCertificatesBundleS3Key: news.caCertificatesBundleS3Key,
              CaCertificatesBundleS3ObjectVersion:
                news.caCertificatesBundleS3ObjectVersion,
            });
            trustStore = modified.TrustStores?.[0] ?? trustStore;
          }

          const trustStoreArn = trustStore.TrustStoreArn as TrustStoreArn;

          // Wait until the trust store is ACTIVE (bundle validation completes).
          const active = yield* elbv2
            .describeTrustStores({ TrustStoreArns: [trustStoreArn] })
            .pipe(
              Effect.map((res) => res.TrustStores?.[0]),
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (ts) => ts?.Status === "ACTIVE",
                times: 10,
              }),
            );

          // Sync tags — diff observed cloud tags against desired.
          const observed = yield* observedTags(trustStoreArn);
          const { removed, upsert } = diffTags(observed, desiredTags);
          if (upsert.length > 0) {
            yield* elbv2.addTags({
              ResourceArns: [trustStoreArn],
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* elbv2.removeTags({
              ResourceArns: [trustStoreArn],
              TagKeys: removed,
            });
          }

          yield* session.note(trustStoreArn);
          return {
            trustStoreArn,
            name: trustStore.Name!,
            status: active?.Status ?? trustStore.Status!,
            numberOfCaCertificates:
              active?.NumberOfCaCertificates ??
              trustStore.NumberOfCaCertificates ??
              0,
            tags: desiredTags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* elbv2
            .deleteTrustStore({ TrustStoreArn: output.trustStoreArn })
            .pipe(
              // In-use trust stores must wait for the listener to detach; the
              // engine deletes dependents first, but retry briefly for the
              // eventual-consistency window.
              Effect.retry({
                while: (e) => e._tag === "TrustStoreInUseException",
                schedule: Schedule.max([
                  Schedule.spaced("3 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
              Effect.catchTag("TrustStoreNotFoundException", () => Effect.void),
              Effect.catchTag("TrustStoreInUseException", () => Effect.void),
            );
        }),
      };
    }),
  );
