import * as account from "@distilled.cloud/aws/account";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { unwrapSensitive as unwrap } from "./internal.ts";

/**
 * The category of alternate contact. Each account has at most one contact of
 * each type.
 */
export type AlternateContactType = "BILLING" | "OPERATIONS" | "SECURITY";

const ALL_CONTACT_TYPES: AlternateContactType[] = [
  "BILLING",
  "OPERATIONS",
  "SECURITY",
];

export interface AlternateContactProps {
  /**
   * Which alternate contact slot to set: `BILLING`, `OPERATIONS`, or
   * `SECURITY`. Each account holds at most one contact per type; changing the
   * type replaces the resource.
   */
  alternateContactType: AlternateContactType;
  /** Name of the alternate contact. */
  name: string;
  /** Title of the alternate contact. */
  title: string;
  /** Email address of the alternate contact. */
  emailAddress: string;
  /** Phone number of the alternate contact. */
  phoneNumber: string;
  /**
   * Account ID to operate on. Only usable from an Organizations management or
   * delegated-admin account with trusted access enabled; omit to target the
   * calling account.
   */
  accountId?: string;
}

export interface AlternateContact extends Resource<
  "AWS.Account.AlternateContact",
  AlternateContactProps,
  {
    alternateContactType: AlternateContactType;
    name: string;
    title: string;
    emailAddress: string;
    phoneNumber: string;
  },
  never,
  Providers
> {}

/**
 * An alternate contact for an AWS account. AWS accounts support one alternate
 * contact for each of the `BILLING`, `OPERATIONS`, and `SECURITY` categories.
 * These are account-global singletons: setting one overwrites any existing
 * contact of the same type, and deleting removes it entirely.
 *
 * @resource
 * @section Setting an Alternate Contact
 * @example Operations Contact
 * ```typescript
 * const contact = yield* AlternateContact("OpsContact", {
 *   alternateContactType: "OPERATIONS",
 *   name: "Ops Team",
 *   title: "On-Call Engineer",
 *   emailAddress: "ops@example.com",
 *   phoneNumber: "+15555550123",
 * });
 * ```
 *
 * @example Billing Contact for an Organizations Member Account
 * ```typescript
 * const contact = yield* AlternateContact("BillingContact", {
 *   alternateContactType: "BILLING",
 *   name: "Finance",
 *   title: "AP Clerk",
 *   emailAddress: "ap@example.com",
 *   phoneNumber: "+15555550124",
 *   accountId: "123456789012",
 * });
 * ```
 */
export const AlternateContact = Resource<AlternateContact>(
  "AWS.Account.AlternateContact",
);

export const AlternateContactProvider = () =>
  Provider.effect(
    AlternateContact,
    Effect.gen(function* () {
      const observe = (
        alternateContactType: AlternateContactType,
        accountId: string | undefined,
      ) =>
        account
          .getAlternateContact({
            AlternateContactType: alternateContactType,
            AccountId: accountId,
          })
          .pipe(
            Effect.map((r) => r.AlternateContact),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      return {
        // Account-global singleton setting: nuke must not wipe real account
        // contacts it never created.
        nuke: { skip: true },
        stables: [],
        // Changing the contact type targets a different account-global slot, so
        // it must replace rather than mutate the old slot in place.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if (
            (olds?.alternateContactType ?? news.alternateContactType) !==
            news.alternateContactType
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const type =
            output?.alternateContactType ?? olds?.alternateContactType;
          if (!type) return undefined;
          const accountId = olds?.accountId;
          const contact = yield* observe(type, accountId);
          if (!contact) return undefined;
          return {
            alternateContactType: type,
            name: unwrap(contact.Name) ?? output?.name ?? "",
            title: unwrap(contact.Title) ?? output?.title ?? "",
            emailAddress:
              unwrap(contact.EmailAddress) ?? output?.emailAddress ?? "",
            phoneNumber:
              unwrap(contact.PhoneNumber) ?? output?.phoneNumber ?? "",
          };
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          yield* account.putAlternateContact({
            AlternateContactType: news.alternateContactType,
            Name: news.name,
            Title: news.title,
            EmailAddress: news.emailAddress,
            PhoneNumber: news.phoneNumber,
            AccountId: news.accountId,
          });
          yield* session.note(
            `${news.alternateContactType}:${news.emailAddress}`,
          );
          return {
            alternateContactType: news.alternateContactType,
            name: news.name,
            title: news.title,
            emailAddress: news.emailAddress,
            phoneNumber: news.phoneNumber,
          };
        }),
        // Account-global singleton: enumerate each of the three contact slots
        // and return whichever ones exist.
        list: () =>
          Effect.gen(function* () {
            const contacts = yield* Effect.forEach(
              ALL_CONTACT_TYPES,
              (type) =>
                observe(type, undefined).pipe(
                  Effect.map((contact) =>
                    contact
                      ? {
                          alternateContactType: type,
                          name: unwrap(contact.Name) ?? "",
                          title: unwrap(contact.Title) ?? "",
                          emailAddress: unwrap(contact.EmailAddress) ?? "",
                          phoneNumber: unwrap(contact.PhoneNumber) ?? "",
                        }
                      : undefined,
                  ),
                ),
              { concurrency: 3 },
            );
            return contacts.filter((c) => c !== undefined);
          }),
        delete: Effect.fn(function* ({ output, olds }) {
          yield* account
            .deleteAlternateContact({
              AlternateContactType: output.alternateContactType,
              AccountId: olds.accountId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
