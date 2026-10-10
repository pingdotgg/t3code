import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * A contact's subscription preference for a single topic. Pass the distilled
 * shape directly: `TopicName` and a `SubscriptionStatus` of `"OPT_IN"` or
 * `"OPT_OUT"`.
 */
export type ContactTopicPreference = sesv2.TopicPreference;

export interface ContactProps {
  /**
   * Name of the contact list this contact belongs to. Typically the
   * `contactListName` output of a `SES.ContactList`. Changing it replaces the
   * contact.
   */
  contactListName: string;
  /**
   * The contact's email address — the stable identifier within the list.
   * Changing it replaces the contact.
   */
  emailAddress: string;
  /**
   * The contact's per-topic subscription preferences. Replaced wholesale when
   * set — pass the full desired set. Leave undefined to keep whatever SES
   * currently has.
   */
  topicPreferences?: ContactTopicPreference[];
  /**
   * Whether the contact is unsubscribed from all topics. Leave undefined to
   * keep SES's current setting.
   * @default false
   */
  unsubscribeAll?: boolean;
  /**
   * Arbitrary application metadata attached to the contact. Serialized to the
   * JSON string SES stores; equivalent representations (key order, whitespace)
   * are ignored when detecting drift. Leave undefined to keep whatever SES
   * currently has.
   */
  attributes?: Record<string, unknown>;
}

export interface Contact extends Resource<
  "AWS.SES.Contact",
  ContactProps,
  {
    /** Name of the contact list the contact belongs to. */
    contactListName: string;
    /** The contact's email address. */
    emailAddress: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 contact — a single email address on a `SES.ContactList`,
 * with its own topic subscription preferences and unsubscribe state.
 * ### Adding Contacts
 * **Example:** Basic Contact
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const list = yield* SES.ContactList("Newsletter", {});
 * const contact = yield* SES.Contact("Subscriber", {
 *   contactListName: list.contactListName,
 *   emailAddress: "reader@example.com",
 * });
 * ```
 *
 * **Example:** Contact with Topic Preferences
 * ```typescript
 * const contact = yield* SES.Contact("Subscriber", {
 *   contactListName: list.contactListName,
 *   emailAddress: "reader@example.com",
 *   topicPreferences: [
 *     { TopicName: "product-updates", SubscriptionStatus: "OPT_IN" },
 *     { TopicName: "promotions", SubscriptionStatus: "OPT_OUT" },
 *   ],
 * });
 * ```
 *
 * **Example:** Unsubscribe a Contact from Everything
 * ```typescript
 * // unsubscribeAll overrides every per-topic preference.
 * const contact = yield* SES.Contact("Subscriber", {
 *   contactListName: list.contactListName,
 *   emailAddress: "reader@example.com",
 *   unsubscribeAll: true,
 * });
 * ```
 *
 * ### Application Metadata
 * **Example:** Attach Your Own Data to a Contact
 * ```typescript
 * // Serialized to the JSON string SES stores; re-ordering the keys is not a
 * // change, so this does not churn on every deploy.
 * const contact = yield* SES.Contact("Subscriber", {
 *   contactListName: list.contactListName,
 *   emailAddress: "reader@example.com",
 *   attributes: { plan: "pro", signupSource: "docs" },
 * });
 * ```
 *
 * @resource
 */
export const Contact = Resource<Contact>("AWS.SES.Contact");

// SES stores contact metadata as an opaque JSON string. Serialize only at the
// API boundary, and compare on a canonical (sorted-key) form so a re-ordered
// object is not mistaken for a change.
const stringifyAttributes = (
  attributes: Record<string, unknown> | undefined,
): string | undefined =>
  attributes === undefined ? undefined : JSON.stringify(attributes);

const normalizeAttributes = (
  attributes: Record<string, unknown> | string | undefined,
): string | undefined => {
  if (attributes === undefined) return undefined;
  let value: unknown = attributes;
  if (typeof attributes === "string") {
    try {
      value = JSON.parse(attributes) as unknown;
    } catch {
      // Not JSON (a hand-written contact, say) — compare the raw string.
      return attributes;
    }
  }
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, canonical(val)]),
          )
        : input;
  return JSON.stringify(canonical(value));
};

const samePreferences = (
  a: ReadonlyArray<ContactTopicPreference> | undefined,
  b: ReadonlyArray<ContactTopicPreference> | undefined,
): boolean => {
  const key = (prefs: ReadonlyArray<ContactTopicPreference> | undefined) =>
    JSON.stringify(
      [...(prefs ?? [])]
        .map((p) => ({
          TopicName: p.TopicName,
          SubscriptionStatus: p.SubscriptionStatus,
        }))
        .sort((x, y) => x.TopicName.localeCompare(y.TopicName)),
    );
  return key(a) === key(b);
};

export const ContactProvider = () =>
  Provider.effect(
    Contact,
    Effect.gen(function* () {
      const getContact = Effect.fn(function* (
        contactListName: string,
        emailAddress: string,
      ) {
        return yield* sesv2
          .getContact({
            ContactListName: contactListName,
            EmailAddress: emailAddress,
          })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Contact.Provider.of({
        // Deleting a contact requires its parent list to still exist, so the
        // list must outlive every contact nuke tears down.
        nuke: { dependsOn: ["AWS.SES.ContactList"] },
        stables: ["contactListName", "emailAddress"],

        // Contacts are keyed by their parent list, so enumeration walks every
        // contact list and pages through its contacts. SES allows one contact
        // list per account, so the outer page is at most one entry.
        list: Effect.fn(function* () {
          const listPages = yield* sesv2.listContactLists
            .pages({})
            .pipe(Stream.runCollect);
          const contactListNames = Array.from(listPages)
            .flatMap((page) => page.ContactLists ?? [])
            .flatMap((entry) =>
              entry.ContactListName ? [entry.ContactListName] : [],
            );
          const nested = yield* Effect.forEach(
            contactListNames,
            (contactListName) =>
              sesv2.listContacts
                .pages({ ContactListName: contactListName })
                .pipe(
                  Stream.runCollect,
                  Effect.map((pages) =>
                    Array.from(pages)
                      .flatMap((page) => page.Contacts ?? [])
                      .flatMap((contact) =>
                        contact.EmailAddress
                          ? [
                              {
                                contactListName,
                                emailAddress: contact.EmailAddress,
                              },
                            ]
                          : [],
                      ),
                  ),
                  // The list can be deleted between the two calls.
                  Effect.catchTag("NotFoundException", () =>
                    Effect.succeed(
                      [] as {
                        contactListName: string;
                        emailAddress: string;
                      }[],
                    ),
                  ),
                ),
            { concurrency: 2 },
          );
          return nested.flat();
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const contactListName =
            output?.contactListName ?? olds?.contactListName;
          const emailAddress = output?.emailAddress ?? olds?.emailAddress;
          if (contactListName === undefined || emailAddress === undefined) {
            return undefined;
          }
          const found = yield* getContact(contactListName, emailAddress);
          // Contacts carry no tags, so existence at the (list, email) key is
          // treated as ownership.
          return found ? { contactListName, emailAddress } : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.contactListName !== olds.contactListName ||
            news.emailAddress !== olds.emailAddress
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const contactListName =
            output?.contactListName ?? news.contactListName;
          const emailAddress = output?.emailAddress ?? news.emailAddress;
          const attributesData = yield* Effect.sync(() =>
            stringifyAttributes(news.attributes),
          );

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* getContact(contactListName, emailAddress);

          if (observed === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge via update.
            yield* sesv2
              .createContact({
                ContactListName: contactListName,
                EmailAddress: emailAddress,
                TopicPreferences: news.topicPreferences,
                UnsubscribeAll: news.unsubscribeAll,
                AttributesData: attributesData,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateContact({
                    ContactListName: contactListName,
                    EmailAddress: emailAddress,
                    TopicPreferences: news.topicPreferences,
                    UnsubscribeAll: news.unsubscribeAll,
                    AttributesData: attributesData,
                  }),
                ),
              );
          } else {
            // 3. SYNC — only the aspects the caller manages. An omitted prop
            //    keeps whatever SES currently has, matching every sibling
            //    resource in this service; updateContact replaces each field
            //    it is given, so observed values are echoed back for the
            //    fields we are not managing.
            const managesPreferences = news.topicPreferences !== undefined;
            const managesUnsubscribe = news.unsubscribeAll !== undefined;
            const managesAttributes = news.attributes !== undefined;

            const preferencesChanged =
              managesPreferences &&
              !samePreferences(
                observed.TopicPreferences,
                news.topicPreferences,
              );
            const unsubscribeChanged =
              managesUnsubscribe &&
              (observed.UnsubscribeAll ?? false) !== news.unsubscribeAll;
            const attributesChanged =
              managesAttributes &&
              (yield* Effect.sync(
                () =>
                  normalizeAttributes(observed.AttributesData) !==
                  normalizeAttributes(news.attributes),
              ));

            if (preferencesChanged || unsubscribeChanged || attributesChanged) {
              yield* sesv2.updateContact({
                ContactListName: contactListName,
                EmailAddress: emailAddress,
                TopicPreferences: managesPreferences
                  ? news.topicPreferences
                  : observed.TopicPreferences,
                UnsubscribeAll: managesUnsubscribe
                  ? news.unsubscribeAll
                  : observed.UnsubscribeAll,
                AttributesData: managesAttributes
                  ? attributesData
                  : observed.AttributesData,
              });
            }
          }

          return { contactListName, emailAddress };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteContact is idempotent for a missing contact; a missing list
          // means the contact is already gone.
          yield* sesv2
            .deleteContact({
              ContactListName: output.contactListName,
              EmailAddress: output.emailAddress,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
