import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readFraudDetectorTags, syncFraudDetectorTags } from "./internal.ts";

export interface EntityTypeProps {
  /**
   * Name of the entity type. If omitted, a unique lowercase name is generated
   * from the app, stage, and logical ID. Changing the name replaces the entity
   * type.
   */
  name?: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * User-defined tags for the entity type.
   */
  tags?: Record<string, string>;
}

export interface EntityType extends Resource<
  "AWS.FraudDetector.EntityType",
  EntityTypeProps,
  {
    /** The name of the entity type. */
    name: string;
    /** The ARN of the entity type. */
    arn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector entity type — the classification of who or what an
 * event is about (e.g. `customer`, `merchant`). Event types reference entity
 * types; they are cheap metadata objects.
 *
 * @resource
 * @section Creating an Entity Type
 * @example Basic Entity Type
 * ```typescript
 * const customer = yield* FraudDetector.EntityType("customer", {
 *   description: "the buyer placing an order",
 * });
 * ```
 */
export const EntityType = Resource<EntityType>("AWS.FraudDetector.EntityType");

export const EntityTypeProvider = () =>
  Provider.effect(
    EntityType,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: EntityTypeProps,
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      /** Look an entity type up by name; typed not-found → undefined. */
      const get = Effect.fn(function* (name: string) {
        const response = yield* frauddetector
          .getEntityTypes({ name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.entityTypes?.[0];
      });

      const toAttrs = (entityType: frauddetector.EntityType) => ({
        name: entityType.name!,
        arn: entityType.arn!,
      });

      return {
        stables: ["name", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const entityType = yield* get(name);
          if (entityType === undefined) return undefined;
          const attrs = toAttrs(entityType);
          const tags = yield* readFraudDetectorTags(entityType.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // putEntityType is an idempotent upsert — call it to converge whether
          // creating or updating the description.
          yield* frauddetector.putEntityType({
            name,
            description: news.description,
          });

          const entityType = yield* get(name);
          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncFraudDetectorTags(entityType!.arn!, desiredTags);

          yield* session.note(name);
          return toAttrs(entityType!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector.deleteEntityType({ name: output.name }).pipe(
            // Deleting an already-removed entity type is a no-op for us; Fraud
            // Detector surfaces a missing entity type as a validation error.
            Effect.catchTag("ValidationException", () => Effect.void),
          );
        }),

        list: () =>
          frauddetector.getEntityTypes.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.entityTypes ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
