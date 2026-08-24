import * as contacts from "@distilled.cloud/aws/notificationscontacts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface EmailContactProps {
  /**
   * Display name of the contact (1–64 characters). If omitted, a unique
   * name is generated from the app, stage and logical ID. Contacts have no
   * update API, so changing the name replaces the contact.
   */
  name?: string;

  /**
   * The email address that receives notifications. Unique per account —
   * AWS rejects a second contact with the same address. Changing the
   * address replaces the contact.
   *
   * A new contact is created in the unverified `inactive` state; AWS sends
   * notifications to it only after the address owner confirms the
   * activation email (`SendActivationCode` / the console).
   */
  emailAddress: string;

  /**
   * User tags to attach to the contact. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface EmailContact extends Resource<
  "AWS.NotificationsContacts.EmailContact",
  EmailContactProps,
  {
    /** The ARN of the email contact (regionless). */
    emailContactArn: string;
    /** The display name of the contact. */
    name: string;
    /** The email address of the contact. */
    emailAddress: string;
    /**
     * Verification status: `inactive` until the address owner confirms the
     * activation email, then `active`.
     */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS User Notifications Contacts **email contact** — an email address
 * that can be attached to a notification configuration as a delivery
 * channel.
 *
 * Contacts are created in the unverified `inactive` state; activation is a
 * human email-confirmation loop (AWS emails the address a confirmation
 * link), so Alchemy provisions the contact and leaves activation to the
 * address owner. Contacts are immutable (no update API) — changing the
 * name or address replaces the contact; tags update in place.
 *
 * @resource
 * @section Creating an Email Contact
 * @example Basic email contact
 * ```typescript
 * import * as NotificationsContacts from "alchemy/AWS/NotificationsContacts";
 *
 * const contact = yield* NotificationsContacts.EmailContact("OnCall", {
 *   emailAddress: "oncall@example.com",
 * });
 * // contact.status === "inactive" until the address owner confirms
 * ```
 *
 * @example Named contact with tags
 * ```typescript
 * const contact = yield* NotificationsContacts.EmailContact("OnCall", {
 *   name: "platform-oncall",
 *   emailAddress: "oncall@example.com",
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const EmailContact = Resource<EmailContact>(
  "AWS.NotificationsContacts.EmailContact",
);

/** Unwrap distilled `SensitiveString` values into plain strings. */
const unwrapSensitive = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value);

const readContactTags = Effect.fn(function* (arn: string) {
  return yield* contacts.listTagsForResource({ arn }).pipe(
    Effect.map((r) => (r.tags ?? {}) as Record<string, string>),
    Effect.catchTag(["ResourceNotFoundException", "ValidationException"], () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );
});

const syncContactTags = Effect.fn(function* (
  arn: string,
  id: string,
  userTags: Record<string, string> | undefined,
) {
  const internalTags = yield* createInternalTags(id);
  const desired = { ...userTags, ...internalTags };
  const observed = yield* readContactTags(arn);
  const { upsert, removed } = diffTags(observed, desired);
  if (upsert.length > 0) {
    yield* contacts.tagResource({
      arn,
      tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
    });
  }
  if (removed.length > 0) {
    yield* contacts.untagResource({ arn, tagKeys: removed });
  }
});

export const EmailContactProvider = () =>
  Provider.effect(
    EmailContact,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: EmailContactProps,
      ) {
        return props.name ?? (yield* createPhysicalName({ id }));
      });

      // Email addresses are unique account-wide (CreateEmailContact rejects
      // duplicates with ConflictException), so an address scan is a
      // reliable identity fallback when the ARN cache is missing.
      const findByAddress = Effect.fn(function* (emailAddress: string) {
        return yield* contacts.listEmailContacts.items({}).pipe(
          Stream.filter(
            (contact) => unwrapSensitive(contact.address) === emailAddress,
          ),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
      });

      const getByArn = Effect.fn(function* (arn: string) {
        return yield* contacts.getEmailContact({ arn }).pipe(
          Effect.map((r) => r.emailContact),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      const toAttrs = (live: contacts.EmailContact) => ({
        emailContactArn: live.arn,
        name: unwrapSensitive(live.name),
        emailAddress: unwrapSensitive(live.address),
        status: live.status,
      });

      return EmailContact.Provider.of({
        stables: ["emailContactArn", "name", "emailAddress"],

        list: () =>
          contacts.listEmailContacts.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk).map(toAttrs)),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.emailContactArn
            ? yield* getByArn(output.emailContactArn)
            : olds?.emailAddress
              ? yield* findByAddress(olds.emailAddress)
              : undefined;
          if (!found) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readContactTags(found.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          // No update API — any change to the contact itself replaces it.
          if (oldName !== newName || news.emailAddress !== olds.emailAddress) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);

          // OBSERVE — cloud state is authoritative; the cached ARN falls
          // through to an address scan when it no longer resolves.
          let live = output?.emailContactArn
            ? yield* getByArn(output.emailContactArn)
            : yield* findByAddress(news.emailAddress);

          // ENSURE — create when missing; ConflictException means a
          // same-address contact already exists (race) → re-observe.
          if (live === undefined) {
            const created = yield* contacts
              .createEmailContact({
                name,
                emailAddress: news.emailAddress,
                tags: news.tags,
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  Effect.succeed(undefined),
                ),
              );
            live = created
              ? yield* getByArn(created.arn)
              : yield* findByAddress(news.emailAddress);
          }
          const arn = live!.arn;

          // SYNC tags — the contact itself is immutable; tags are the only
          // mutable aspect (diffed against observed cloud tags).
          yield* syncContactTags(arn, id, news.tags);

          yield* session.note(arn);
          return toAttrs(live!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* contacts
            .deleteEmailContact({ arn: output.emailContactArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
