import * as schemas from "@distilled.cloud/aws/schemas";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { syncSchemasTags } from "./internal.ts";

export type DiscovererState = "STARTED" | "STOPPED";

export interface DiscovererProps {
  /**
   * The ARN of the event bus to discover schemas on. Changing it replaces
   * the discoverer.
   */
  sourceArn: string;

  /**
   * A description of the discoverer.
   */
  description?: string;

  /**
   * Whether the discoverer also discovers schemas from events sent by other
   * accounts.
   * @default true
   */
  crossAccount?: boolean;

  /**
   * The desired state of the discoverer. A discoverer starts automatically
   * on creation.
   * @default "STARTED"
   */
  state?: DiscovererState;

  /**
   * User tags to attach to the discoverer.
   */
  tags?: Record<string, string>;
}

export interface Discoverer extends Resource<
  "AWS.Schemas.Discoverer",
  DiscovererProps,
  {
    /** The ID of the discoverer. */
    discovererId: string;
    /** The ARN of the discoverer. */
    discovererArn: string;
    /** The ARN of the event bus being discovered. */
    sourceArn: string;
    /** The current state of the discoverer. */
    state: DiscovererState;
  },
  never,
  Providers
> {}

/**
 * An EventBridge schema discoverer — automatically infers schemas from the
 * events flowing through an event bus and publishes them (versioned) to the
 * AWS-managed `discovered-schemas` registry.
 *
 * @resource
 * @section Creating a Discoverer
 * @example Discover Schemas on an Event Bus
 * ```typescript
 * const bus = yield* AWS.EventBridge.EventBus("AppBus", {});
 *
 * const discoverer = yield* AWS.Schemas.Discoverer("AppDiscoverer", {
 *   sourceArn: bus.eventBusArn,
 *   description: "Discovers schemas for application events",
 * });
 * ```
 *
 * @example Stopped Discoverer
 * ```typescript
 * const discoverer = yield* AWS.Schemas.Discoverer("PausedDiscoverer", {
 *   sourceArn: bus.eventBusArn,
 *   state: "STOPPED",
 * });
 * ```
 * The discoverer is provisioned but paused; set `state: "STARTED"` (or omit
 * it) to resume discovery.
 */
export const Discoverer = Resource<Discoverer>("AWS.Schemas.Discoverer");

export const DiscovererProvider = () =>
  Provider.effect(
    Discoverer,
    Effect.gen(function* () {
      const describe = (discovererId: string) =>
        schemas
          .describeDiscoverer({ DiscovererId: discovererId })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttrs = (d: {
        DiscovererId?: string;
        DiscovererArn?: string;
        SourceArn?: string;
        State?: string;
      }) => ({
        discovererId: d.DiscovererId!,
        discovererArn: d.DiscovererArn!,
        sourceArn: d.SourceArn!,
        state: (d.State ?? "STARTED") as DiscovererState,
      });

      return Discoverer.Provider.of({
        stables: ["discovererId", "discovererArn", "sourceArn"],

        list: () =>
          schemas.listDiscoverers.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.Discoverers ?? [])
                  .filter(
                    (d) =>
                      d.DiscovererId != null &&
                      d.DiscovererArn != null &&
                      d.SourceArn != null,
                  )
                  .map(toAttrs),
              ),
            ),
          ),

        read: Effect.fn(function* ({ id, output }) {
          if (output?.discovererId) {
            const found = yield* describe(output.discovererId);
            if (!found) return undefined;
            const attrs = toAttrs(found);
            return (yield* hasAlchemyTags(id, found.Tags))
              ? attrs
              : Unowned(attrs);
          }
          // No cached id (the discoverer id is auto-assigned) — recover by
          // scanning for a discoverer branded with our ownership tags.
          const all = yield* schemas.listDiscoverers.items({}).pipe(
            Stream.runCollect,
            Effect.map((c) => Array.from(c)),
          );
          for (const d of all) {
            if (
              d.DiscovererId != null &&
              d.DiscovererArn != null &&
              d.SourceArn != null &&
              (yield* hasAlchemyTags(id, d.Tags))
            ) {
              return toAttrs(d);
            }
          }
          return undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.sourceArn !== olds.sourceArn) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);

          // OBSERVE — output.discovererId is only an id cache.
          let live:
            | {
                Description?: string;
                DiscovererArn?: string;
                DiscovererId?: string;
                SourceArn?: string;
                State?: string;
                CrossAccount?: boolean;
              }
            | undefined;
          if (output?.discovererId) {
            live = yield* describe(output.discovererId);
          }

          // ENSURE — create if missing. The id is auto-assigned, so there is
          // no name race to tolerate.
          if (live === undefined) {
            live = yield* schemas.createDiscoverer({
              SourceArn: news.sourceArn,
              Description: news.description,
              CrossAccount: news.crossAccount,
              Tags: { ...news.tags, ...internalTags },
            });
          }
          const discovererId = live.DiscovererId!;
          const discovererArn = live.DiscovererArn!;

          // SYNC description / crossAccount — diff observed against desired.
          const desiredCrossAccount = news.crossAccount ?? true;
          if (
            (news.description ?? "") !== (live.Description ?? "") ||
            desiredCrossAccount !== (live.CrossAccount ?? true)
          ) {
            live = yield* schemas.updateDiscoverer({
              DiscovererId: discovererId,
              Description: news.description ?? "",
              CrossAccount: desiredCrossAccount,
            });
          }

          // SYNC state — start/stop only on delta.
          const desiredState: DiscovererState = news.state ?? "STARTED";
          let state = (live.State ?? "STARTED") as DiscovererState;
          if (state !== desiredState) {
            if (desiredState === "STARTED") {
              const r = yield* schemas.startDiscoverer({
                DiscovererId: discovererId,
              });
              state = (r.State ?? "STARTED") as DiscovererState;
            } else {
              const r = yield* schemas.stopDiscoverer({
                DiscovererId: discovererId,
              });
              state = (r.State ?? "STOPPED") as DiscovererState;
            }
          }

          // SYNC tags — diff against observed cloud tags.
          yield* syncSchemasTags(discovererArn, id, news.tags);

          yield* session.note(discovererId);
          return {
            discovererId,
            discovererArn,
            sourceArn: live.SourceArn ?? news.sourceArn,
            state,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* schemas
            .deleteDiscoverer({ DiscovererId: output.discovererId })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
