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

// Variant store names must match `[a-z]([a-z0-9_]){0,254}` — the generated
// physical name (hyphens, mixed case) is coerced to fit.
const toStoreName = (raw: string) => {
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const prefixed = /^[a-z]/.test(sanitized) ? sanitized : `a${sanitized}`;
  return prefixed.slice(0, 255);
};

export interface VariantStoreProps {
  /**
   * A name for the variant store. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Must be lowercase, start with a letter,
   * and contain only `[a-z0-9_]`. Changing the name replaces the store.
   */
  name?: string;
  /**
   * A description for the variant store. Mutable.
   */
  description?: string;
  /**
   * The genome reference for the store, as a reference ARN. Required.
   * Immutable — changing it replaces the store.
   */
  reference: {
    /** ARN of a reference in a HealthOmics reference store. */
    referenceArn: string;
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
   * Tags to apply to the variant store. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface VariantStore extends Resource<
  "AWS.Omics.VariantStore",
  VariantStoreProps,
  {
    /**
     * ID of the variant store.
     */
    variantStoreId: string;
    /**
     * ARN of the variant store.
     */
    variantStoreArn: string;
    /**
     * Name of the variant store.
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
 * An Amazon HealthOmics variant store — a container for genomic variant data
 * (VCF) aligned to a reference genome.
 *
 * A variant store name is auto-generated from the app, stage, and logical ID
 * unless you provide one. The `reference` and `sseConfig` are immutable —
 * changing either replaces the store. `description` is updated in place.
 * @resource
 * @section Creating a Variant Store
 * @example Basic Variant Store
 * ```typescript
 * import * as Omics from "alchemy/AWS/Omics";
 *
 * const store = yield* Omics.VariantStore("Variants", {
 *   reference: {
 *     referenceArn: "arn:aws:omics:us-east-1:123456789012:referenceStore/1234567890/reference/0987654321",
 *   },
 * });
 * ```
 */
export const VariantStore = Resource<VariantStore>("AWS.Omics.VariantStore");

export const VariantStoreProvider = () =>
  Provider.effect(
    VariantStore,
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
        const final = yield* omics.getVariantStore({ name }).pipe(
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
              message: `Variant store ${name} failed: ${final.statusMessage ?? "unknown"}`,
            }),
          );
        }
        return final;
      });

      return VariantStore.Provider.of({
        stables: ["variantStoreId", "variantStoreArn", "name"],
        list: () =>
          omics.listVariantStores.items({}).pipe(
            Stream.map((item) => ({
              variantStoreId: item.id!,
              variantStoreArn: item.storeArn!,
              name: item.name ?? "",
              status: item.status ?? "",
            })),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const found = yield* omics
            .getVariantStore({ name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (found === undefined) return undefined;
          const attrs = {
            variantStoreId: found.id,
            variantStoreArn: found.storeArn,
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

          let store = yield* omics
            .getVariantStore({ name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (store === undefined) {
            yield* omics
              .createVariantStore({
                name,
                description: news.description,
                reference: news.reference,
                sseConfig: news.sseConfig,
                tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            store = yield* waitUntilActive(name);
          } else if (store.status === "CREATING") {
            store = yield* waitUntilActive(name);
          }

          if (
            news.description !== undefined &&
            news.description !== store.description
          ) {
            yield* omics.updateVariantStore({
              name,
              description: news.description,
            });
            store = yield* omics.getVariantStore({ name });
          }

          yield* syncOmicsTags(store.storeArn, desiredTags);

          yield* session.note(store.id);
          return {
            variantStoreId: store.id,
            variantStoreArn: store.storeArn,
            name: store.name,
            status: store.status,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* omics
            .deleteVariantStore({ name: output.name, force: true })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
