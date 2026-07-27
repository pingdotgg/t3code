import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export type RegistrationStatus = socialmessaging.RegistrationStatus;
export type WhatsAppPhoneNumberSummary =
  socialmessaging.WhatsAppPhoneNumberSummary;

/**
 * An event destination (Amazon SNS topic) that AWS End User Messaging Social
 * publishes WhatsApp events (messages, message status updates) to.
 */
export interface LinkedWhatsAppBusinessAccountEventDestination {
  /**
   * ARN of the SNS topic that receives WhatsApp events for this account.
   */
  eventDestinationArn: string;
  /**
   * ARN of an IAM role the service assumes to publish to the topic. Omit to
   * publish with a service principal.
   */
  roleArn?: string;
}

export interface LinkedWhatsAppBusinessAccountProps {
  /**
   * The unique identifier of the WhatsApp Business Account already linked to
   * your AWS account (format `waba-...`).
   *
   * WhatsApp Business onboarding requires the Meta embedded-signup OAuth flow
   * in the AWS console and cannot be automated — this resource adopts and
   * manages an account that has already been linked. Changing the identifier
   * replaces the resource.
   */
  accountId: string;
  /**
   * Event destinations (SNS topics) to publish WhatsApp events to. When set,
   * the full list is synced (the API replaces the whole list). When omitted,
   * existing event destinations are left untouched.
   */
  eventDestinations?: LinkedWhatsAppBusinessAccountEventDestination[];
  /**
   * Tags to associate with the linked WhatsApp Business Account.
   */
  tags?: Record<string, string>;
}

export interface LinkedWhatsAppBusinessAccount extends Resource<
  "AWS.SocialMessaging.LinkedWhatsAppBusinessAccount",
  LinkedWhatsAppBusinessAccountProps,
  {
    /**
     * ARN of the linked WhatsApp Business Account.
     */
    arn: string;
    /**
     * The unique identifier of the linked WhatsApp Business Account
     * (`waba-...`).
     */
    id: string;
    /**
     * The WhatsApp Business Account ID from Meta.
     */
    wabaId: string;
    /**
     * The name of the WhatsApp Business Account.
     */
    wabaName: string;
    /**
     * Registration status of the linked account (`COMPLETE` | `INCOMPLETE`).
     */
    registrationStatus: RegistrationStatus;
    /**
     * ISO-8601 date the WhatsApp Business Account was linked.
     */
    linkDate: string;
    /**
     * Event destinations currently configured on the account.
     */
    eventDestinations: LinkedWhatsAppBusinessAccountEventDestination[];
    /**
     * Phone numbers registered to the WhatsApp Business Account.
     */
    phoneNumbers: WhatsAppPhoneNumberSummary[];
    /**
     * Current tags reported for the account.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A WhatsApp Business Account (WABA) linked to your AWS account through
 * AWS End User Messaging Social.
 *
 * :::caution
 * Linking a WhatsApp Business Account requires the Meta embedded-signup
 * OAuth flow in the AWS console and cannot be automated. This resource
 * adopts an already-linked account by its `waba-...` identifier and manages
 * its event destinations and tags. Destroying the resource disassociates
 * the WhatsApp Business Account from your AWS account.
 * :::
 * @resource
 * @section Managing a Linked Account
 * @example Adopt a console-linked WABA and route events to SNS
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const events = yield* AWS.SNS.Topic("WhatsAppEvents", {});
 *
 * const waba = yield* AWS.SocialMessaging.LinkedWhatsAppBusinessAccount(
 *   "Business",
 *   {
 *     // from the AWS End User Messaging Social console after onboarding
 *     accountId: "waba-0123456789abcdef0123456789abcdef",
 *     eventDestinations: [{ eventDestinationArn: events.topicArn }],
 *     tags: { team: "growth" },
 *   },
 * );
 * ```
 *
 * @section Consuming WhatsApp Events
 * @example Handle Inbound Messages in a Lambda
 * WhatsApp events (inbound messages, message status updates) are delivered
 * exclusively to the SNS topics listed in `eventDestinations` — there is no
 * separate event source for this service. Compose the resource with
 * `AWS.SNS.consumeTopicNotifications` on the destination topic:
 * ```typescript
 * const events = yield* AWS.SNS.Topic("WhatsAppEvents", {});
 *
 * const waba = yield* AWS.SocialMessaging.LinkedWhatsAppBusinessAccount(
 *   "Business",
 *   {
 *     accountId: "waba-0123456789abcdef0123456789abcdef",
 *     eventDestinations: [{ eventDestinationArn: events.topicArn }],
 *   },
 * );
 *
 * // inside a Lambda Function's init effect
 * yield* AWS.SNS.consumeTopicNotifications(events, (stream) =>
 *   stream.pipe(
 *     Stream.runForEach((notification) =>
 *       Effect.log("whatsapp event", notification.Message),
 *     ),
 *   ),
 * );
 * ```
 */
export const LinkedWhatsAppBusinessAccount =
  Resource<LinkedWhatsAppBusinessAccount>(
    "AWS.SocialMessaging.LinkedWhatsAppBusinessAccount",
  );

/**
 * The referenced WhatsApp Business Account is not linked to this AWS
 * account. Linking requires the Meta embedded-signup flow in the AWS
 * console and cannot be performed by the provider.
 */
export class WhatsAppBusinessAccountNotLinked extends Data.TaggedError(
  "WhatsAppBusinessAccountNotLinked",
)<{
  readonly accountId: string;
}> {}

const fetchTags = Effect.fn(function* (arn: string) {
  const response = yield* socialmessaging.listTagsForResource({
    resourceArn: arn,
  });
  return Object.fromEntries(
    (response.tags ?? []).flatMap((tag) =>
      tag.value === undefined ? [] : [[tag.key, tag.value] as const],
    ),
  );
});

interface LinkedAccountState {
  attrs: LinkedWhatsAppBusinessAccount["Attributes"];
  account: socialmessaging.LinkedWhatsAppBusinessAccount;
}

const readLinkedAccount = Effect.fn(function* (accountId: string) {
  const response = yield* socialmessaging
    .getLinkedWhatsAppBusinessAccount({ id: accountId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  const account = response?.account;
  if (account === undefined) return undefined;
  const state: LinkedAccountState = {
    account,
    attrs: {
      arn: account.arn,
      id: account.id,
      wabaId: account.wabaId,
      wabaName: account.wabaName,
      registrationStatus: account.registrationStatus,
      linkDate: account.linkDate.toISOString(),
      eventDestinations: account.eventDestinations.map((destination) => ({
        eventDestinationArn: destination.eventDestinationArn,
        roleArn: destination.roleArn,
      })),
      phoneNumbers: account.phoneNumbers.map((phone) => ({ ...phone })),
      tags: yield* fetchTags(account.arn),
    },
  };
  return state;
});

const sortDestinations = (
  destinations: LinkedWhatsAppBusinessAccountEventDestination[],
) =>
  destinations
    .map((destination) => ({
      eventDestinationArn: destination.eventDestinationArn,
      roleArn: destination.roleArn,
    }))
    .sort((l, r) => l.eventDestinationArn.localeCompare(r.eventDestinationArn));

const destinationsDrifted = (
  observed: LinkedWhatsAppBusinessAccountEventDestination[],
  desired: LinkedWhatsAppBusinessAccountEventDestination[],
) => {
  const left = sortDestinations(observed);
  const right = sortDestinations(desired);
  return (
    left.length !== right.length ||
    left.some(
      (destination, index) =>
        destination.eventDestinationArn !== right[index].eventDestinationArn ||
        destination.roleArn !== right[index].roleArn,
    )
  );
};

export const LinkedWhatsAppBusinessAccountProvider = () =>
  Provider.effect(
    LinkedWhatsAppBusinessAccount,
    Effect.gen(function* () {
      return {
        stables: ["arn", "id", "wabaId"],
        list: () =>
          Effect.gen(function* () {
            const summaries =
              yield* socialmessaging.listLinkedWhatsAppBusinessAccounts
                .pages({})
                .pipe(
                  EffectStream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap(
                      (page) => page.linkedAccounts ?? [],
                    ),
                  ),
                );
            const hydrated = yield* Effect.forEach(
              summaries,
              (summary) => readLinkedAccount(summary.id),
              { concurrency: 5 },
            );
            return hydrated.flatMap((state) =>
              state === undefined ? [] : [state.attrs],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const accountId = output?.id ?? olds?.accountId;
          if (accountId === undefined) return undefined;
          const state = yield* readLinkedAccount(accountId);
          if (state === undefined) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The linked account identity is fixed by Meta onboarding.
          if (news.accountId !== olds.accountId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news?.accountId) {
            return yield* Effect.fail(
              new Error(
                "LinkedWhatsAppBusinessAccount requires an accountId (link the WABA in the AWS console first)",
              ),
            );
          }
          const accountId = output?.id ?? news.accountId;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — onboarding is console-only, so the account must already
          // be linked; there is no create path to fall through to.
          const state = yield* readLinkedAccount(accountId);
          if (state === undefined) {
            return yield* Effect.fail(
              new WhatsAppBusinessAccountNotLinked({ accountId }),
            );
          }

          // Sync event destinations — the API replaces the full list.
          if (
            news.eventDestinations !== undefined &&
            destinationsDrifted(
              state.attrs.eventDestinations,
              news.eventDestinations,
            )
          ) {
            yield* socialmessaging.putWhatsAppBusinessAccountEventDestinations({
              id: state.attrs.id,
              eventDestinations: news.eventDestinations.map((destination) => ({
                eventDestinationArn: destination.eventDestinationArn,
                roleArn: destination.roleArn,
              })),
            });
            yield* session.note(
              `Updated event destinations for ${state.attrs.id}`,
            );
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* socialmessaging.untagResource({
              resourceArn: state.attrs.arn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* socialmessaging.tagResource({
              resourceArn: state.attrs.arn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }

          yield* session.note(state.attrs.arn);

          const final = yield* readLinkedAccount(accountId);
          if (final === undefined) {
            return yield* Effect.fail(
              new WhatsAppBusinessAccountNotLinked({ accountId }),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* socialmessaging
            .disassociateWhatsAppBusinessAccount({ id: output.id })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
