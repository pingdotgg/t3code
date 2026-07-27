import * as notifications from "@distilled.cloud/aws/notifications";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { pinNotificationsRegion } from "./internal.ts";

export interface NotificationHubProps {
  /**
   * The AWS region to enable as a notification hub (where User
   * Notifications stores and replicates notification events), e.g.
   * `us-west-2`. Changing the region replaces the hub.
   */
  region: string;
}

export interface NotificationHub extends Resource<
  "AWS.Notifications.NotificationHub",
  NotificationHubProps,
  {
    /** The region registered as a notification hub. */
    notificationHubRegion: string;
    /** Hub status: `ACTIVE`, `REGISTERING`, `DEREGISTERING` or `INACTIVE`. */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS User Notifications **notification hub** — a regional enablement
 * that stores and replicates notification events. An account can register
 * at most 3 hubs, and at least one ACTIVE hub must exist for notification
 * configurations to deliver events.
 *
 * Registration is a true upsert keyed by region (re-registering an existing
 * hub region is a no-op), so the hub behaves like a per-region singleton.
 *
 * **AWS refuses to deregister the last ACTIVE hub in the account**
 * (`ConflictException`). Destroying a stack containing the account's only
 * hub therefore fails — keep a baseline hub registered outside the stack,
 * or register a second hub first.
 *
 * @resource
 * @section Registering a Notification Hub
 * @example Enable a region as a notification hub
 * ```typescript
 * import * as Notifications from "alchemy/AWS/Notifications";
 *
 * const hub = yield* Notifications.NotificationHub("Hub", {
 *   region: "us-east-2",
 * });
 * ```
 */
export const NotificationHub = Resource<NotificationHub>(
  "AWS.Notifications.NotificationHub",
);

/**
 * Poll until the hub reaches a terminal status (bounded and fail-open —
 * registration is typically ACTIVE immediately).
 *
 * Explicitly typed so `Effect.repeat`'s conditional return type doesn't
 * survive into declaration emit and widen the provider layer.
 */
const untilActive = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  status: (a: A) => string | undefined,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.fixed("2 seconds"),
    until: (a) => status(a) !== "REGISTERING",
    times: 20,
  });

export const NotificationHubProvider = () =>
  Provider.effect(
    NotificationHub,
    Effect.gen(function* () {
      const findByRegion = Effect.fn(function* (region: string) {
        return yield* pinNotificationsRegion(
          notifications.listNotificationHubs.items({}).pipe(
            Stream.filter((hub) => hub.notificationHubRegion === region),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          ),
        );
      });

      const toAttrs = (hub: {
        notificationHubRegion: string;
        statusSummary: { status: string };
      }) => ({
        notificationHubRegion: hub.notificationHubRegion,
        status: hub.statusSummary.status,
      });

      return NotificationHub.Provider.of({
        stables: ["notificationHubRegion"],

        list: () =>
          pinNotificationsRegion(
            notifications.listNotificationHubs.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk).map(toAttrs)),
            ),
          ),

        read: Effect.fn(function* ({ olds, output }) {
          const region = output?.notificationHubRegion ?? olds?.region;
          if (region === undefined) return undefined;
          const found = yield* findByRegion(region);
          // Hubs are not taggable — identity is the region itself.
          return found ? toAttrs(found) : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.region !== olds.region) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // OBSERVE — the hub is keyed by region; registration is an
          // idempotent upsert so a concurrent create is harmless.
          let live = yield* findByRegion(news.region);

          // ENSURE — register when missing (or not yet ACTIVE; re-register
          // of an existing region is a no-op returning current state).
          if (live === undefined) {
            const registered = yield* pinNotificationsRegion(
              notifications.registerNotificationHub({
                notificationHubRegion: news.region,
              }),
            );
            live = registered;
          }

          // Wait for activation (bounded, fail-open — usually immediate).
          if (live.statusSummary.status === "REGISTERING") {
            const settled = yield* untilActive(
              findByRegion(news.region),
              (hub) => hub?.statusSummary.status,
            );
            live = settled ?? live;
          }

          yield* session.note(news.region);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent for an already-gone hub. A ConflictException
          // ("Cannot deregister last ACTIVE notification hub") is a genuine
          // account constraint and propagates.
          yield* pinNotificationsRegion(
            notifications
              .deregisterNotificationHub({
                notificationHubRegion: output.notificationHubRegion,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      });
    }),
  );
