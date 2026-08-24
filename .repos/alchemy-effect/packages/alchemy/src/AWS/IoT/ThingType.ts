import * as iot from "@distilled.cloud/aws/iot";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readIotTags, syncIotTags } from "./internal.ts";

export interface ThingTypeProps {
  /**
   * Name of the thing type. If omitted, a unique name is generated.
   * Changing it replaces the thing type.
   */
  thingTypeName?: string;

  /**
   * A description of the thing type.
   */
  description?: string;

  /**
   * A list of searchable thing attribute names.
   */
  searchableAttributes?: string[];

  /**
   * User tags to attach to the thing type.
   */
  tags?: Record<string, string>;
}

export interface ThingType extends Resource<
  "AWS.IoT.ThingType",
  ThingTypeProps,
  {
    /** The name of the thing type. */
    thingTypeName: string;
    /** The ARN of the thing type. */
    thingTypeArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Thing Type — a reusable template describing a class of things.
 *
 * @resource
 * @section Creating a Thing Type
 * @example Basic Thing Type
 * ```typescript
 * const thingType = yield* ThingType("sensor-type", {
 *   description: "Temperature sensors",
 *   searchableAttributes: ["location", "model"],
 * });
 * ```
 *
 * @example Create a Thing of this Type
 * ```typescript
 * const thingType = yield* ThingType("sensor-type", {
 *   searchableAttributes: ["location"],
 * });
 *
 * const thing = yield* Thing("sensor", {
 *   thingTypeName: thingType.thingTypeName,
 *   attributes: { location: "warehouse-a" },
 * });
 * ```
 */
export const ThingType = Resource<ThingType>("AWS.IoT.ThingType");

export class ThingTypeDeletionTimedOut extends Data.TaggedError(
  "ThingTypeDeletionTimedOut",
)<{
  readonly thingTypeName: string;
  readonly waitedSeconds: number;
}> {}

export const ThingTypeProvider = () =>
  Provider.effect(
    ThingType,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: ThingTypeProps,
      ) {
        return props.thingTypeName ?? (yield* createPhysicalName({ id }));
      });

      return ThingType.Provider.of({
        stables: ["thingTypeName", "thingTypeArn"],
        list: () =>
          iot.listThingTypes.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.thingTypes ?? [])
                  .filter(
                    (t) => t.thingTypeName != null && t.thingTypeArn != null,
                  )
                  .map((t) => ({
                    thingTypeName: t.thingTypeName!,
                    thingTypeArn: t.thingTypeArn!,
                  })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const thingTypeName =
            output?.thingTypeName ?? (yield* createName(id, olds ?? {}));
          const found = yield* iot
            .describeThingType({ thingTypeName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found) return undefined;
          const attrs = {
            thingTypeName,
            thingTypeArn: found.thingTypeArn!,
          };
          const tags = yield* readIotTags(found.thingTypeArn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // searchableAttributes are immutable after creation; a change
          // requires replacement.
          const oldAttrs = JSON.stringify(olds.searchableAttributes ?? []);
          const newAttrs = JSON.stringify(news.searchableAttributes ?? []);
          if (oldAttrs !== newAttrs) return { action: "replace" } as const;
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const thingTypeName =
            output?.thingTypeName ?? (yield* createName(id, news));

          // OBSERVE
          let live = yield* iot
            .describeThingType({ thingTypeName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // ENSURE
          if (live === undefined) {
            yield* iot
              .createThingType({
                thingTypeName,
                thingTypeProperties: {
                  thingTypeDescription: news.description,
                  searchableAttributes: news.searchableAttributes,
                },
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            live = yield* iot.describeThingType({ thingTypeName });
          }

          // SYNC deprecation — a destroy deprecates the type but AWS blocks
          // deletion for 5 minutes, so a re-create with the same name can
          // observe a deprecated type. Converge it back to active.
          if (live.thingTypeMetadata?.deprecated) {
            yield* iot.deprecateThingType({
              thingTypeName,
              undoDeprecate: true,
            });
            live = yield* iot.describeThingType({ thingTypeName });
          }

          // SYNC tags
          yield* syncIotTags(live.thingTypeArn!, id, news.tags);

          yield* session.note(thingTypeName);
          return {
            thingTypeName,
            thingTypeArn: live.thingTypeArn!,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const thingTypeName = output.thingTypeName;

          // Things reference their type, so the engine dependency graph (and
          // nuke's independent Thing provider) must remove owned Things first.
          // Do not silently delete arbitrary foreign Things merely because
          // they share this account-global type.
          const initial = yield* iot
            .describeThingType({ thingTypeName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (initial === undefined) return;

          if (!initial.thingTypeMetadata?.deprecated) {
            yield* iot
              .deprecateThingType({ thingTypeName })
              .pipe(
                Effect.catchTag(
                  ["ResourceNotFoundException", "InvalidRequestException"],
                  () => Effect.void,
                ),
              );
          }

          // AWS enforces a mandatory five-minute deprecation window. A single
          // provider operation must not block that long: retry only its typed
          // InvalidRequestException for ~45s, then fail explicitly so state is
          // preserved. A later destroy/nuke re-enters with the same stable name
          // after AWS's clock has elapsed and completes the deletion. Success
          // still requires DescribeThingType to report actual NotFound.
          const attempts = 12;
          const intervalSeconds = 4;
          for (let attempt = 0; attempt < attempts; attempt++) {
            const absent = yield* iot.describeThingType({ thingTypeName }).pipe(
              Effect.as(false),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(true),
              ),
            );
            if (absent) return;

            const deleteAccepted = yield* iot
              .deleteThingType({ thingTypeName })
              .pipe(
                Effect.as(true),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(true),
                ),
                Effect.catchTag("InvalidRequestException", () =>
                  Effect.succeed(false),
                ),
              );
            if (deleteAccepted) {
              const gone = yield* iot.describeThingType({ thingTypeName }).pipe(
                Effect.as(false),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(true),
                ),
              );
              if (gone) return;
            }
            if (attempt + 1 < attempts) {
              yield* Effect.sleep(`${intervalSeconds} seconds`);
            }
          }

          return yield* Effect.fail(
            new ThingTypeDeletionTimedOut({
              thingTypeName,
              waitedSeconds: (attempts - 1) * intervalSeconds,
            }),
          );
        }),
      });
    }),
  );
