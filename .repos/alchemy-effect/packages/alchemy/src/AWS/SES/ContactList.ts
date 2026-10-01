import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * A subscription topic on a contact list. Pass the distilled shape directly:
 * `TopicName` (the stable id), `DisplayName`, an optional `Description`, and a
 * `DefaultSubscriptionStatus` of `"OPT_IN"` or `"OPT_OUT"`.
 */
export type ContactListTopic = sesv2.Topic;

export interface ContactListProps {
  /**
   * Name of the contact list. May contain letters, numbers, dashes and
   * underscores, up to 64 characters. If omitted, a deterministic physical
   * name is generated from the app, stage, and logical ID. Changing the name
   * replaces the contact list.
   */
  contactListName?: string;
  /**
   * A human-readable description of the contact list. Leave undefined to keep
   * whatever SES currently has.
   */
  description?: string;
  /**
   * The interest topics contacts can subscribe to. Replaced wholesale when
   * set — pass the full desired set. Leave undefined to keep whatever SES
   * currently has.
   */
  topics?: ContactListTopic[];
  /**
   * Tags to apply to the contact list. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface ContactList extends Resource<
  "AWS.SES.ContactList",
  ContactListProps,
  {
    /** Name of the contact list. */
    contactListName: string;
    /** ARN of the contact list. */
    contactListArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 contact list — a named audience of email contacts with
 * subscription topics, used with SES's list-management and unsubscribe
 * handling.
 *
 * Add contacts with `SES.Contact`. Deleting the list deletes all of its
 * contacts.
 *
 * SES allows only **one contact list per AWS account**, so renaming a list
 * replaces it by deleting the old list (and its contacts) before creating the
 * new one — a create-then-delete replacement would exceed the account limit.
 * ### Creating Contact Lists
 * **Example:** Basic Contact List
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const list = yield* SES.ContactList("Newsletter", {
 *   description: "Weekly product newsletter",
 * });
 * ```
 *
 * **Example:** Contact List with Topics
 * ```typescript
 * const list = yield* SES.ContactList("Newsletter", {
 *   topics: [
 *     {
 *       TopicName: "product-updates",
 *       DisplayName: "Product Updates",
 *       DefaultSubscriptionStatus: "OPT_IN",
 *     },
 *     {
 *       TopicName: "promotions",
 *       DisplayName: "Promotions",
 *       DefaultSubscriptionStatus: "OPT_OUT",
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Contact List with Tags
 * ```typescript
 * const list = yield* SES.ContactList("Newsletter", {
 *   tags: { Team: "growth", Environment: "prod" },
 * });
 * ```
 *
 * ### Populating the List
 * **Example:** Add Contacts to the List
 * ```typescript
 * const list = yield* SES.ContactList("Newsletter", {
 *   topics: [
 *     {
 *       TopicName: "product-updates",
 *       DisplayName: "Product Updates",
 *       DefaultSubscriptionStatus: "OPT_IN",
 *     },
 *   ],
 * });
 *
 * for (const email of ["a@example.com", "b@example.com"]) {
 *   yield* SES.Contact(`Subscriber-${email}`, {
 *     contactListName: list.contactListName,
 *     emailAddress: email,
 *     topicPreferences: [
 *       { TopicName: "product-updates", SubscriptionStatus: "OPT_IN" },
 *     ],
 *   });
 * }
 * ```
 *
 * @resource
 */
export const ContactList = Resource<ContactList>("AWS.SES.ContactList");

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

const contactListArnOf = (region: string, accountId: string, name: string) =>
  `arn:aws:ses:${region}:${accountId}:contact-list/${name}`;

const sameTopics = (
  a: ReadonlyArray<ContactListTopic> | undefined,
  b: ReadonlyArray<ContactListTopic> | undefined,
): boolean => {
  const key = (topics: ReadonlyArray<ContactListTopic> | undefined) =>
    JSON.stringify(
      [...(topics ?? [])]
        .map((t) => ({
          TopicName: t.TopicName,
          DisplayName: t.DisplayName,
          Description: t.Description,
          DefaultSubscriptionStatus: t.DefaultSubscriptionStatus,
        }))
        .sort((x, y) => x.TopicName.localeCompare(y.TopicName)),
    );
  return key(a) === key(b);
};

export const ContactListProvider = () =>
  Provider.effect(
    ContactList,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ContactListProps, "contactListName">,
      ) {
        return (
          props.contactListName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getList = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getContactList({ ContactListName: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return ContactList.Provider.of({
        stables: ["contactListName", "contactListArn"],

        list: Effect.fn(function* () {
          const { accountId, region } = yield* AWSEnvironment.current;
          const pages = yield* sesv2.listContactLists
            .pages({})
            .pipe(Stream.runCollect);
          return Array.from(pages)
            .flatMap((page) => page.ContactLists ?? [])
            .flatMap((entry) =>
              entry.ContactListName
                ? [
                    {
                      contactListName: entry.ContactListName,
                      contactListArn: contactListArnOf(
                        region,
                        accountId,
                        entry.ContactListName,
                      ),
                    },
                  ]
                : [],
            );
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.contactListName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getList(name);
          if (!found) return undefined;
          const attrs = {
            contactListName: name,
            contactListArn: contactListArnOf(region, accountId, name),
          };
          const tags = toTagRecord(found.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            // Only one contact list is allowed per account, so the old list
            // has to go before the new one can be created.
            return { action: "replace", deleteFirst: true } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.contactListName ?? (yield* createName(id, news));
          const contactListArn = contactListArnOf(region, accountId, name);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getList(name);

          if (observed === undefined) {
            // 2. ENSURE — create with the full desired set; AlreadyExists is a
            //    race → converge via update.
            yield* sesv2
              .createContactList({
                ContactListName: name,
                Description: news.description,
                Topics: news.topics,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateContactList({
                    ContactListName: name,
                    Description: news.description,
                    Topics: news.topics,
                  }),
                ),
              );
            // getList tolerates NotFound; the list is not always readable the
            // instant create returns, and on the AlreadyExists race another
            // writer may still be mid-create.
            observed = yield* getList(name).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (list) => list !== undefined,
                times: 8,
              }),
            );
          } else {
            // 3. SYNC — only the aspects the caller manages. An omitted prop
            //    keeps whatever SES currently has, matching every sibling
            //    resource in this service; updateContactList replaces each
            //    field it is given, so observed values are echoed back for the
            //    fields we are not managing.
            const managesDescription = news.description !== undefined;
            const managesTopics = news.topics !== undefined;
            const descriptionChanged =
              managesDescription && observed.Description !== news.description;
            const topicsChanged =
              managesTopics && !sameTopics(observed.Topics, news.topics);

            if (descriptionChanged || topicsChanged) {
              yield* sesv2.updateContactList({
                ContactListName: name,
                Description: managesDescription
                  ? news.description
                  : observed.Description,
                Topics: managesTopics ? news.topics : observed.Topics,
              });
            }
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = toTagRecord(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sesv2.tagResource({
              ResourceArn: contactListArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* sesv2.untagResource({
              ResourceArn: contactListArn,
              TagKeys: removed,
            });
          }

          yield* session.note(contactListArn);
          return { contactListName: name, contactListArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteContactList removes the list and all of its contacts, and is
          // idempotent for a missing list.
          yield* sesv2
            .deleteContactList({ ContactListName: output.contactListName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
