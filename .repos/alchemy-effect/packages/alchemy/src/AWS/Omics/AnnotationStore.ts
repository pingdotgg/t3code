import * as omics from "@distilled.cloud/aws/omics";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, tagRecord } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { syncOmicsTags } from "./internal.ts";

// Annotation/variant store names must match `[a-z]([a-z0-9_]){0,254}` — the
// generated physical name (hyphens, mixed case) is coerced to fit.
const toStoreName = (raw: string) => {
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const prefixed = /^[a-z]/.test(sanitized) ? sanitized : `a${sanitized}`;
  return prefixed.slice(0, 255);
};

export interface AnnotationStoreProps {
  /**
   * A name for the annotation store. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Must be lowercase, start with a
   * letter, and contain only `[a-z0-9_]`. Changing the name replaces the
   * store.
   */
  name?: string;
  /**
   * A description for the annotation store. Mutable.
   */
  description?: string;
  /**
   * The annotation file format of the store. Immutable — changing it replaces
   * the store.
   */
  storeFormat: "GFF" | "TSV" | "VCF";
  /**
   * The genome reference for the store, as a reference ARN. Required for
   * `GFF` and `VCF` stores. Immutable — changing it replaces the store.
   */
  reference?: {
    /** ARN of a reference in a HealthOmics reference store. */
    referenceArn: string;
  };
  /**
   * File parsing options for `TSV` stores. Immutable.
   */
  storeOptions?: {
    /** Parsing options for TSV-format annotation files. */
    tsvStoreOptions: {
      /** The store's annotation type (e.g. `GENERIC`, `CHR_POS_REF_ALT`). */
      annotationType?: string;
      /** Maps TSV format fields to the store's header columns. */
      formatToHeader?: Record<string, string>;
      /** Column-name-to-type entries describing the store's schema. */
      schema?: Record<string, string>[];
    };
  };
  /**
   * Server-side encryption (SSE) settings. Defaults to an AWS-owned key.
   * Immutable.
   */
  sseConfig?: {
    /** Encryption type. `KMS` uses a customer-managed key. */
    type: "KMS";
    /** ARN of the customer-managed KMS key. Required when `type` is `KMS`. */
    keyArn?: string;
  };
  /**
   * Tags to apply to the annotation store. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AnnotationStore extends Resource<
  "AWS.Omics.AnnotationStore",
  AnnotationStoreProps,
  {
    /**
     * ID of the annotation store.
     */
    annotationStoreId: string;
    /**
     * ARN of the annotation store.
     */
    annotationStoreArn: string;
    /**
     * Name of the annotation store.
     */
    name: string;
    /**
     * Store status (e.g. `ACTIVE`, `CREATING`, `UPDATING`, `FAILED`).
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon HealthOmics annotation store — a container for genome annotation
 * data (GFF, TSV, or VCF) aligned to a reference genome.
 *
 * An annotation store name is auto-generated from the app, stage, and logical
 * ID unless you provide one. The `storeFormat`, `reference`, `storeOptions`,
 * and `sseConfig` are immutable — changing any of them replaces the store.
 * `description` is updated in place.
 * @resource
 * @section Creating an Annotation Store
 * @example VCF Annotation Store
 * ```typescript
 * import * as Omics from "alchemy/AWS/Omics";
 *
 * const store = yield* Omics.AnnotationStore("Annotations", {
 *   storeFormat: "VCF",
 *   reference: {
 *     referenceArn: "arn:aws:omics:us-east-1:123456789012:referenceStore/1234567890/reference/0987654321",
 *   },
 * });
 * ```
 *
 * @example TSV Annotation Store
 * ```typescript
 * const store = yield* Omics.AnnotationStore("Annotations", {
 *   storeFormat: "TSV",
 *   storeOptions: {
 *     tsvStoreOptions: { annotationType: "GENERIC" },
 *   },
 * });
 * ```
 */
export const AnnotationStore = Resource<AnnotationStore>(
  "AWS.Omics.AnnotationStore",
);

export const AnnotationStoreProvider = () =>
  Provider.effect(
    AnnotationStore,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return (
          props.name ??
          toStoreName(yield* createPhysicalName({ id, maxLength: 96 }))
        );
      });

      const waitUntilActive = Effect.fn(function* (name: string) {
        const final = yield* omics.getAnnotationStore({ name }).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(23),
            ]),
            until: (s) => s.status === "ACTIVE" || s.status === "FAILED",
          }),
        );
        if (final.status === "FAILED") {
          return yield* Effect.fail(
            new omics.ValidationException({
              message: `Annotation store ${name} failed: ${final.statusMessage ?? "unknown"}`,
            }),
          );
        }
        return final;
      });

      return AnnotationStore.Provider.of({
        stables: ["annotationStoreId", "annotationStoreArn", "name"],
        list: () =>
          omics.listAnnotationStores.items({}).pipe(
            Stream.map((item) => ({
              annotationStoreId: item.id!,
              annotationStoreArn: item.storeArn!,
              name: item.name ?? "",
              status: item.status ?? "",
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const found = yield* omics
            .getAnnotationStore({ name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found === undefined) return undefined;
          const attrs = {
            annotationStoreId: found.id,
            annotationStoreArn: found.storeArn,
            name: found.name,
            status: found.status,
          };
          return (yield* hasAlchemyTags(id, tagRecord(found.tags)))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const prev = olds ?? {};
          const oldName = yield* createName(id, prev);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (
            (prev.storeFormat ?? "") !== (news.storeFormat ?? "") ||
            (prev.reference?.referenceArn ?? "") !==
              (news.reference?.referenceArn ?? "") ||
            prev.sseConfig?.type !== news.sseConfig?.type ||
            prev.sseConfig?.keyArn !== news.sseConfig?.keyArn
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // OBSERVE — annotation stores are addressable by name.
          let store = yield* omics
            .getAnnotationStore({ name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // ENSURE — create if missing, tolerating a create race, then wait
          // for the async provisioning to reach a terminal state.
          if (store === undefined) {
            yield* omics
              .createAnnotationStore({
                name,
                description: news.description,
                storeFormat: news.storeFormat,
                reference: news.reference,
                storeOptions: news.storeOptions,
                sseConfig: news.sseConfig,
                tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            store = yield* waitUntilActive(name);
          } else if (store.status === "CREATING") {
            store = yield* waitUntilActive(name);
          }

          // SYNC — description is the only mutable field.
          if (
            news.description !== undefined &&
            news.description !== store.description
          ) {
            yield* omics.updateAnnotationStore({
              name,
              description: news.description,
            });
            store = yield* omics.getAnnotationStore({ name });
          }

          // SYNC TAGS — diff against observed cloud tags so adoption converges.
          yield* syncOmicsTags(store.storeArn, desiredTags);

          yield* session.note(store.id);
          return {
            annotationStoreId: store.id,
            annotationStoreArn: store.storeArn,
            name: store.name,
            status: store.status,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* omics
            .deleteAnnotationStore({ name: output.name, force: true })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
