import * as iot from "@distilled.cloud/aws/iot";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface ThingProps {
  /**
   * Name of the thing. Must be unique in your account and region and may only
   * contain letters, numbers, colons, underscores, and hyphens.
   * If omitted, a unique name is generated. Changing it replaces the thing.
   */
  thingName?: string;

  /**
   * Name of the {@link ThingType} to associate with this thing.
   */
  thingTypeName?: string;

  /**
   * A set of string attributes (key/value pairs) to store on the thing.
   */
  attributes?: Record<string, string>;
}

export interface Thing extends Resource<
  "AWS.IoT.Thing",
  ThingProps,
  {
    /** The name of the thing. */
    thingName: string;
    /** The ARN of the thing. */
    thingArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT Thing — the cloud representation of a physical device.
 *
 * @resource
 * @section Creating a Thing
 * @example Basic Thing
 * ```typescript
 * const thing = yield* Thing("sensor", {});
 * ```
 *
 * @example Thing with Attributes
 * ```typescript
 * const thing = yield* Thing("sensor", {
 *   thingName: "temperature-sensor-01",
 *   attributes: { location: "warehouse-a", model: "acme-t1000" },
 * });
 * ```
 */
export const Thing = Resource<Thing>("AWS.IoT.Thing");

export const ThingProvider = () =>
  Provider.effect(
    Thing,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: ThingProps) {
        return props.thingName ?? (yield* createPhysicalName({ id }));
      });

      return Thing.Provider.of({
        stables: ["thingName", "thingArn"],
        list: () =>
          iot.listThings.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.things ?? [])
                  .filter((t) => t.thingName != null && t.thingArn != null)
                  .map((t) => ({
                    thingName: t.thingName!,
                    thingArn: t.thingArn!,
                  })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const thingName =
            output?.thingName ?? (yield* createName(id, olds ?? {}));
          const found = yield* iot
            .describeThing({ thingName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found) return undefined;
          return {
            thingName,
            thingArn: found.thingArn!,
          };
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const thingName = output?.thingName ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud is authoritative; output is only an id cache.
          let live = yield* iot
            .describeThing({ thingName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          // 2. ENSURE — create if missing; tolerate an AlreadyExists race.
          if (live === undefined) {
            yield* iot
              .createThing({
                thingName,
                thingTypeName: news.thingTypeName,
                attributePayload: news.attributes
                  ? { attributes: news.attributes }
                  : undefined,
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            live = yield* iot.describeThing({ thingName });
          } else {
            // 3. SYNC — converge attributes + thing type to desired.
            const desiredAttrs = news.attributes ?? {};
            const observedAttrs = live.attributes ?? {};
            const attrsChanged =
              JSON.stringify(desiredAttrs) !== JSON.stringify(observedAttrs);
            const typeChanged =
              (news.thingTypeName ?? undefined) !==
              (live.thingTypeName ?? undefined);
            if (attrsChanged || typeChanged) {
              yield* iot.updateThing({
                thingName,
                thingTypeName: news.thingTypeName,
                removeThingType:
                  news.thingTypeName === undefined &&
                  live.thingTypeName !== undefined
                    ? true
                    : undefined,
                attributePayload: attrsChanged
                  ? { attributes: desiredAttrs, merge: false }
                  : undefined,
              });
              live = yield* iot.describeThing({ thingName });
            }
          }

          yield* session.note(thingName);
          return {
            thingName,
            thingArn: live.thingArn!,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iot
            .deleteThing({ thingName: output.thingName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
