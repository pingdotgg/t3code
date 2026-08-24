import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { fetchOmicsTags, syncOmicsTags } from "./internal.ts";

export interface SequenceStoreProps {
  /**
   * A name for the sequence store. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * store. Must match `[\w -.]+` and be 1-127 characters.
   */
  name?: string;
  /**
   * A description for the sequence store. Changing the description replaces
   * the store (HealthOmics has no update-store API).
   */
  description?: string;
  /**
   * Server-side encryption (SSE) settings. Defaults to an AWS-owned key.
   * Changing this replaces the store.
   */
  sseConfig?: {
    /** Encryption type. `KMS` uses a customer-managed key. */
    type: "KMS";
    /** ARN of the customer-managed KMS key. Required when `type` is `KMS`. */
    keyArn?: string;
  };
  /**
   * An S3 location that is used as the destination for read sets whose
   * upload failed. Changing this replaces the store.
   */
  fallbackLocation?: string;
  /**
   * The ETag algorithm family to use for ingested read sets. Changing this
   * replaces the store. Valid values are `MD5up` and `SHA256up`.
   */
  eTagAlgorithmFamily?: "MD5up" | "SHA256up";
  /**
   * The tags keys to propagate to the S3 objects associated with read sets
   * in this store. Changing this replaces the store.
   */
  propagatedSetLevelTags?: string[];
  /**
   * Tags to apply to the sequence store. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface SequenceStore extends Resource<
  "AWS.Omics.SequenceStore",
  SequenceStoreProps,
  {
    /**
     * ID of the sequence store.
     */
    sequenceStoreId: string;
    /**
     * ARN of the sequence store.
     */
    sequenceStoreArn: string;
    /**
     * Name of the sequence store.
     */
    name: string;
    /**
     * When the sequence store was created (ISO-8601).
     */
    creationTime: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon HealthOmics sequence store — a container for genomics read sets
 * (FASTQ, BAM, CRAM).
 *
 * A sequence store name is auto-generated from the app, stage, and logical ID
 * unless you provide one. HealthOmics offers no update-store API, so any
 * change to an immutable property (name, description, encryption, fallback
 * location, ETag algorithm) replaces the store. A store can only be deleted
 * once it contains no read sets.
 * @resource
 * @section Creating a Sequence Store
 * @example Basic Sequence Store
 * ```typescript
 * import * as Omics from "alchemy/AWS/Omics";
 *
 * const store = yield* Omics.SequenceStore("Reads");
 * ```
 *
 * @example Sequence Store with Fallback Location
 * ```typescript
 * const store = yield* Omics.SequenceStore("Reads", {
 *   name: "sample-reads",
 *   fallbackLocation: "s3://my-bucket/omics-fallback/",
 *   eTagAlgorithmFamily: "SHA256up",
 * });
 * ```
 *
 * @section Encryption
 * @example Customer-managed KMS key
 * ```typescript
 * const store = yield* Omics.SequenceStore("Reads", {
 *   sseConfig: {
 *     type: "KMS",
 *     keyArn: "arn:aws:kms:us-east-1:123456789012:key/abc-123",
 *   },
 * });
 * ```
 */
export const SequenceStore = Resource<SequenceStore>("AWS.Omics.SequenceStore");

export const SequenceStoreProvider = () =>
  Provider.effect(
    SequenceStore,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 96 }));
      });

      const toAttrs = (store: {
        id: string;
        arn: string;
        name?: string;
        creationTime: Date;
      }) => ({
        sequenceStoreId: store.id,
        sequenceStoreArn: store.arn,
        name: store.name ?? "",
        creationTime: store.creationTime.toISOString(),
      });

      return SequenceStore.Provider.of({
        stables: [
          "sequenceStoreId",
          "sequenceStoreArn",
          "name",
          "creationTime",
        ],
        list: () =>
          omics.listSequenceStores.items({}).pipe(
            Stream.map(toAttrs),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
        read: Effect.fn(function* ({ id, output }) {
          if (output?.sequenceStoreId === undefined) return undefined;
          const found = yield* omics
            .getSequenceStore({ id: output.sequenceStoreId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* fetchOmicsTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const prev = olds ?? {};
          const oldName = yield* createName(id, prev);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if ((prev.description ?? "") !== (news.description ?? "")) {
            return { action: "replace" } as const;
          }
          if (
            prev.sseConfig?.type !== news.sseConfig?.type ||
            prev.sseConfig?.keyArn !== news.sseConfig?.keyArn ||
            (prev.fallbackLocation ?? "") !== (news.fallbackLocation ?? "") ||
            (prev.eTagAlgorithmFamily ?? "") !==
              (news.eTagAlgorithmFamily ?? "")
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          let store =
            output?.sequenceStoreId === undefined
              ? undefined
              : yield* omics
                  .getSequenceStore({ id: output.sequenceStoreId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  );

          if (store === undefined) {
            store = yield* omics.createSequenceStore({
              name,
              description: news.description,
              sseConfig: news.sseConfig,
              fallbackLocation: news.fallbackLocation,
              eTagAlgorithmFamily: news.eTagAlgorithmFamily,
              propagatedSetLevelTags: news.propagatedSetLevelTags,
              tags: desiredTags,
            });
          }

          yield* syncOmicsTags(store.arn, desiredTags);

          yield* session.note(store.id);
          return toAttrs(store);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* omics
            .deleteSequenceStore({ id: output.sequenceStoreId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
