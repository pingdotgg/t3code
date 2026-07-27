import * as contacts from "@distilled.cloud/aws/ssm-contacts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/** How Incident Manager engages the contact through this channel. */
export type ContactChannelType = "SMS" | "VOICE" | "EMAIL";

export interface ContactChannelProps {
  /**
   * The ARN of the contact this channel belongs to. Changing it replaces the
   * channel.
   */
  contactId: string;

  /**
   * The name of the contact channel.
   *
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;

  /**
   * The channel type: `SMS`, `VOICE`, or `EMAIL`. Changing it replaces the
   * channel.
   */
  type: ContactChannelType;

  /**
   * The address of the channel: an E.164 phone number (`+15551234567`) for
   * `SMS`/`VOICE`, or an email address for `EMAIL`.
   */
  deliveryAddress: contacts.ContactChannelAddress;

  /**
   * When `true`, the channel is created without sending an activation code —
   * the contact's device does not receive a message. Activate later with
   * `sendActivationCode` + `activateContactChannel`.
   *
   * @default false (AWS sends an activation code on create)
   */
  deferActivation?: boolean;
}

/** @resource */
export interface ContactChannel extends Resource<
  "AWS.SSMContacts.ContactChannel",
  ContactChannelProps,
  {
    /** ARN of the contact channel. */
    contactChannelArn: string;
    /** ARN of the owning contact. */
    contactArn: string;
    /** Name of the channel. */
    name: string;
    /** The channel type. */
    type: string;
    /** `ACTIVATED` or `NOT_ACTIVATED`. */
    activationStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Incident Manager contact channel — the method (SMS, voice, or email)
 * that Incident Manager uses to engage a contact during an incident.
 *
 * @section Creating Contact Channels
 * @example Email channel without activation
 * ```typescript
 * const email = yield* SSMContacts.ContactChannel("Email", {
 *   contactId: oncall.contactArn,
 *   type: "EMAIL",
 *   deliveryAddress: { SimpleAddress: "oncall@example.com" },
 *   deferActivation: true,
 * });
 * ```
 *
 * @example SMS channel
 * ```typescript
 * const sms = yield* SSMContacts.ContactChannel("Sms", {
 *   contactId: oncall.contactArn,
 *   type: "SMS",
 *   deliveryAddress: { SimpleAddress: "+15551234567" },
 * });
 * ```
 */
const ContactChannelResource = Resource<ContactChannel>(
  "AWS.SSMContacts.ContactChannel",
);

export { ContactChannelResource as ContactChannel };

export const ContactChannelProvider = () =>
  Provider.effect(
    ContactChannelResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string },
      ) {
        return (
          props.name ?? (yield* createPhysicalName({ id, maxLength: 200 }))
        );
      });

      const getChannel = (arn: string) =>
        contacts
          .getContactChannel({ ContactChannelId: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      // A channel's ARN embeds a generated UUID, so without cached output we
      // fall back to searching the owning contact's channels by name + type.
      const findChannel = (contactId: string, name: string, type: string) =>
        contacts.listContactChannels.items({ ContactId: contactId }).pipe(
          Stream.filter(
            (channel) =>
              channel.Name === name && (channel.Type ?? type) === type,
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)[0]),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const buildAttrs = (channel: {
        ContactChannelArn: string;
        ContactArn: string;
        Name: string;
        Type?: string | undefined;
        ActivationStatus?: string | undefined;
      }) => ({
        contactChannelArn: channel.ContactChannelArn,
        contactArn: channel.ContactArn,
        name: channel.Name,
        type: channel.Type ?? "",
        activationStatus: channel.ActivationStatus,
      });

      return ContactChannelResource.Provider.of({
        stables: ["contactChannelArn", "contactArn", "type"],

        // Sub-resource keyed by its parent contact — enumeration across all
        // contacts is not meaningful here.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const channel = yield* getChannel(output.contactChannelArn);
            if (channel === undefined) return undefined;
            return buildAttrs(channel);
          }
          // No cached identifier — recover by searching the parent contact
          // from prior props. Channels are not taggable, so a match found
          // this way cannot prove ownership.
          if (olds?.contactId === undefined) return undefined;
          const name = yield* createName(id, olds);
          const found = yield* findChannel(olds.contactId, name, olds.type);
          return found === undefined ? undefined : Unowned(buildAttrs(found));
        }),

        // The owning contact and channel type are create-only; name and
        // delivery address update in place.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.contactId !== news.contactId) {
            return { action: "replace" } as const;
          }
          if (olds.type !== news.type) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* createName(id, news));

          // 1. OBSERVE — by cached ARN first, then by (contact, name, type).
          let channel = output
            ? yield* getChannel(output.contactChannelArn)
            : undefined;
          if (channel === undefined) {
            const found = yield* findChannel(news.contactId, name, news.type);
            if (found !== undefined) {
              channel = yield* getChannel(found.ContactChannelArn);
            }
          }

          // 2. ENSURE — create if missing; tolerate the already-exists race
          //    by re-searching.
          if (channel === undefined) {
            yield* session.note(`creating contact channel ${name}`);
            const arn = yield* contacts
              .createContactChannel({
                ContactId: news.contactId,
                Name: name,
                Type: news.type,
                DeliveryAddress: news.deliveryAddress,
                DeferActivation: news.deferActivation,
              })
              .pipe(
                Effect.map((r) => r.ContactChannelArn),
                Effect.catchTag("ConflictException", () =>
                  findChannel(news.contactId, name, news.type).pipe(
                    Effect.map((found) => found!.ContactChannelArn),
                  ),
                ),
              );
            channel = (yield* getChannel(arn))!;
          }

          // 3. SYNC name + delivery address — observed vs desired.
          const nameDelta = channel.Name !== name;
          const addressDelta =
            (channel.DeliveryAddress.SimpleAddress ?? "") !==
            (news.deliveryAddress.SimpleAddress ?? "");
          if (nameDelta || addressDelta) {
            yield* contacts.updateContactChannel({
              ContactChannelId: channel.ContactChannelArn,
              Name: name,
              DeliveryAddress: news.deliveryAddress,
            });
          }

          // 4. RETURN fresh attributes.
          const final = (yield* getChannel(channel.ContactChannelArn))!;
          yield* session.note(final.ContactChannelArn);
          return buildAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* contacts
            .deleteContactChannel({
              ContactChannelId: output.contactChannelArn,
            })
            .pipe(
              Effect.asVoid,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
