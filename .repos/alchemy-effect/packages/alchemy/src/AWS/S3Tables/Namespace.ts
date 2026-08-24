import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { TableBucketArn } from "./TableBucket.ts";

export interface NamespaceProps {
  /**
   * ARN of the table bucket that owns the namespace. Changing it replaces
   * the namespace.
   */
  tableBucket: TableBucketArn | string;
  /**
   * Name of the namespace. Must be 1-255 characters of lowercase letters,
   * numbers, and underscores, beginning with a letter or number. Changing
   * the name replaces the namespace.
   * @default a deterministic name derived from the app, stage, and logical ID
   */
  namespace?: string;
}

export interface Namespace extends Resource<
  "AWS.S3Tables.Namespace",
  NamespaceProps,
  {
    tableBucketArn: string;
    namespace: string;
    namespaceId: string | undefined;
    createdAt: Date;
    createdBy: string;
    ownerAccountId: string;
  },
  never,
  Providers
> {}

/**
 * A namespace within an Amazon S3 Tables {@link TableBucket} — a logical
 * grouping of {@link Table}s, equivalent to a database in an Iceberg catalog.
 * @resource
 * @section Creating Namespaces
 * @example Basic Namespace
 * ```typescript
 * import * as S3Tables from "alchemy/AWS/S3Tables";
 *
 * const bucket = yield* S3Tables.TableBucket("Analytics");
 * const ns = yield* S3Tables.Namespace("Events", {
 *   tableBucket: bucket.tableBucketArn,
 * });
 * ```
 *
 * @example Named Namespace
 * ```typescript
 * const ns = yield* S3Tables.Namespace("Events", {
 *   tableBucket: bucket.tableBucketArn,
 *   namespace: "raw_events",
 * });
 * ```
 */
export const Namespace = Resource<Namespace>("AWS.S3Tables.Namespace");

const createNamespaceName = (
  id: string,
  props: { namespace?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.namespace) {
      return props.namespace;
    }
    // Namespace names allow lowercase letters, numbers, and underscores only —
    // no hyphens — so translate the DNS-style physical name.
    const base = yield* createPhysicalName({
      id,
      maxLength: 60,
      lowercase: true,
    });
    return base.replaceAll("-", "_");
  });

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["tableBucketArn", "namespace"],
    // Namespaces are scoped to a parent table bucket; there is no ambient
    // enumeration without a bucket ARN, so the engine drives lifecycle from
    // state alone.
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ id, olds, output }) {
      const tableBucketArn = output?.tableBucketArn ?? olds?.tableBucket;
      if (typeof tableBucketArn !== "string") return undefined;
      const namespace =
        output?.namespace ?? (yield* createNamespaceName(id, olds ?? {}));
      return yield* s3tables
        .getNamespace({ tableBucketARN: tableBucketArn, namespace })
        .pipe(
          Effect.map((n): Namespace["Attributes"] => ({
            tableBucketArn,
            namespace: n.namespace[0] ?? namespace,
            namespaceId: n.namespaceId,
            createdAt: n.createdAt,
            createdBy: n.createdBy,
            ownerAccountId: n.ownerAccountId,
          })),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
    }),
    diff: Effect.fn(function* ({ id, news, olds }) {
      if (!isResolved(news)) return;
      if (news.tableBucket !== olds?.tableBucket) {
        return { action: "replace" } as const;
      }
      const oldName = yield* createNamespaceName(id, olds ?? {});
      const newName = yield* createNamespaceName(id, news);
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const tableBucketArn = news.tableBucket as string;
      const namespace =
        output?.namespace ?? (yield* createNamespaceName(id, news));

      // Observe — read live state; the namespace may have been removed
      // out-of-band even if `output` cached it.
      let ns = yield* s3tables
        .getNamespace({ tableBucketARN: tableBucketArn, namespace })
        .pipe(
          Effect.map((n) => n),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      // Ensure — create if missing, tolerating a concurrent create.
      if (ns === undefined) {
        yield* s3tables
          .createNamespace({
            tableBucketARN: tableBucketArn,
            namespace: [namespace],
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTag("ConflictException", () => Effect.void),
          );
        // Eventual consistency: getNamespace can briefly 404 a namespace that
        // createNamespace just returned.
        ns = yield* s3tables
          .getNamespace({ tableBucketARN: tableBucketArn, namespace })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "NotFoundException",
              schedule: Schedule.max([
                Schedule.exponential(500),
                Schedule.recurs(8),
              ]),
            }),
          );
      }

      yield* session.note(namespace);
      return {
        tableBucketArn,
        namespace: ns.namespace[0] ?? namespace,
        namespaceId: ns.namespaceId,
        createdAt: ns.createdAt,
        createdBy: ns.createdBy,
        ownerAccountId: ns.ownerAccountId,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* s3tables
        .deleteNamespace({
          tableBucketARN: output.tableBucketArn,
          namespace: output.namespace,
        })
        .pipe(
          // Table deletes are eventually consistent; a namespace delete that
          // races them reports ConflictException — ride out the window.
          Effect.retry({
            while: (e) => e._tag === "ConflictException",
            schedule: Schedule.max([
              Schedule.exponential(500),
              Schedule.recurs(8),
            ]),
          }),
          Effect.catchTag("NotFoundException", () => Effect.void),
        );
    }),
  });
