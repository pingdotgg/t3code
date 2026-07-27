import * as notifications from "@distilled.cloud/aws/notifications";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { pinNotificationsRegion } from "./internal.ts";

export interface ChannelAssociationProps {
  /**
   * The ARN of the {@link NotificationConfiguration} to deliver from.
   * Changing the configuration replaces the association.
   */
  notificationConfigurationArn: string;

  /**
   * The ARN of the delivery channel to associate. Supported channels are
   * email contacts (`AWS.NotificationsContacts.EmailContact`), Amazon Q
   * Developer in chat applications (AWS Chatbot) channels, and AWS Console
   * Mobile Application devices. Changing the channel replaces the
   * association.
   *
   * An email contact can be associated while still `inactive` (unverified);
   * AWS begins delivering to it once the address owner activates it.
   */
  channelArn: string;
}

export interface ChannelAssociation extends Resource<
  "AWS.Notifications.ChannelAssociation",
  ChannelAssociationProps,
  {
    /** The ARN of the associated delivery channel. */
    channelArn: string;
    /** The ARN of the parent notification configuration. */
    notificationConfigurationArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS User Notifications **channel association** — attaches a delivery
 * channel (an email contact, an Amazon Q Developer chat channel, or a
 * Console Mobile Application device) to a
 * {@link NotificationConfiguration}, so matching events are actually
 * delivered somewhere beyond the Console notification center.
 *
 * The association is existence-only (there is nothing mutable): changing
 * either ARN replaces it.
 *
 * @resource
 * @section Associating a Channel
 * @example Deliver notifications to an email contact
 * ```typescript
 * import * as Notifications from "alchemy/AWS/Notifications";
 * import * as NotificationsContacts from "alchemy/AWS/NotificationsContacts";
 *
 * const config = yield* Notifications.NotificationConfiguration("Alerts", {
 *   description: "Deployment alerts",
 * });
 * const contact = yield* NotificationsContacts.EmailContact("OnCall", {
 *   emailAddress: "oncall@example.com",
 * });
 * const association = yield* Notifications.ChannelAssociation("OnCallEmail", {
 *   notificationConfigurationArn: config.notificationConfigurationArn,
 *   channelArn: contact.emailContactArn,
 * });
 * ```
 */
export const ChannelAssociation = Resource<ChannelAssociation>(
  "AWS.Notifications.ChannelAssociation",
);

export const ChannelAssociationProvider = () =>
  Provider.effect(
    ChannelAssociation,
    Effect.gen(function* () {
      // The association has no ARN of its own — identity is the
      // (configuration, channel) pair, observed via ListChannels.
      const findAssociation = Effect.fn(function* (
        notificationConfigurationArn: string,
        channelArn: string,
      ) {
        return yield* pinNotificationsRegion(
          notifications.listChannels
            .items({ notificationConfigurationArn })
            .pipe(
              Stream.filter((arn) => arn === channelArn),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
              // The parent configuration may already be gone.
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            ),
        );
      });

      return ChannelAssociation.Provider.of({
        stables: ["channelArn", "notificationConfigurationArn"],

        // Sub-resource keyed by its parent notification configuration —
        // there is no account-wide enumeration without a parent ARN.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const configArn =
            output?.notificationConfigurationArn ??
            olds?.notificationConfigurationArn;
          const channelArn = output?.channelArn ?? olds?.channelArn;
          if (configArn === undefined || channelArn === undefined) {
            return undefined;
          }
          const found = yield* findAssociation(configArn, channelArn);
          // Associations are not taggable — identity is the pair itself.
          return found !== undefined
            ? { channelArn, notificationConfigurationArn: configArn }
            : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.notificationConfigurationArn !==
              olds.notificationConfigurationArn ||
            news.channelArn !== olds.channelArn
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ news, session }) {
          // OBSERVE — existence-only: is the channel already associated?
          const existing = yield* findAssociation(
            news.notificationConfigurationArn,
            news.channelArn,
          );

          // ENSURE — associate when missing; a ConflictException means a
          // peer associated the same pair concurrently.
          if (existing === undefined) {
            yield* pinNotificationsRegion(
              notifications
                .associateChannel({
                  arn: news.channelArn,
                  notificationConfigurationArn:
                    news.notificationConfigurationArn,
                })
                .pipe(Effect.catchTag("ConflictException", () => Effect.void)),
            );
          }

          // No SYNC step — the association has no mutable aspects.
          yield* session.note(news.channelArn);
          return {
            channelArn: news.channelArn,
            notificationConfigurationArn: news.notificationConfigurationArn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent — a missing association (or an already-deleted
          // parent configuration) is not an error.
          yield* pinNotificationsRegion(
            notifications
              .disassociateChannel({
                arn: output.channelArn,
                notificationConfigurationArn:
                  output.notificationConfigurationArn,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              ),
          );
        }),
      });
    }),
  );
