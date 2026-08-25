import * as contacts from "@distilled.cloud/aws/ssm-contacts";
import * as Effect from "effect/Effect";
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
  tagRecord,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** The kind of contact: a person, an escalation plan, or an on-call schedule. */
export type ContactType = "PERSONAL" | "ESCALATION" | "ONCALL_SCHEDULE";

export interface ContactProps {
  /**
   * The unique, identifiable alias of the contact or escalation plan
   * (lowercase letters, numbers, `-`, `_`, `.`). Changing it replaces the
   * contact.
   *
   * @default ${app}-${id}-${stage}-${suffix} (lowercased)
   */
  alias?: string;

  /**
   * The full name of the contact or escalation plan.
   */
  displayName?: string;

  /**
   * `PERSONAL` for a single person, `ESCALATION` for an escalation plan that
   * engages contacts in phases, or `ONCALL_SCHEDULE` for a rotation-backed
   * schedule. Changing it replaces the contact.
   */
  type: ContactType;

  /**
   * The stages (engagement plan) that Incident Manager runs through when
   * engaging this contact. Stage targets are contact channels for `PERSONAL`
   * contacts and contacts for `ESCALATION` plans; `ONCALL_SCHEDULE` contacts
   * reference rotations via `RotationIds`.
   *
   * When omitted, an existing plan is left untouched so it can be managed by
   * the standalone `SSMContacts.Plan` resource.
   */
  plan?: contacts.Plan;

  /**
   * The contact's resource policy as a JSON policy document (string or
   * object) — shares the contact and its engagements with other accounts.
   * When omitted, any existing policy is left untouched (SSM Contacts has
   * no delete-policy API).
   */
  policy?: string | Record<string, unknown>;

  /**
   * Tags applied to the contact. Alchemy ownership tags are merged in
   * automatically.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Contact extends Resource<
  "AWS.SSMContacts.Contact",
  ContactProps,
  {
    /** ARN of the contact. */
    contactArn: string;
    /** Alias of the contact. */
    alias: string;
    /** The contact type. */
    type: string;
    /** Display name of the contact. */
    displayName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Incident Manager contact — a person Incident Manager engages during an
 * incident, an escalation plan that engages contacts in phases, or an
 * on-call schedule backed by rotations.
 *
 * Requires the account's Incident Manager replication set
 * (`SSMIncidents.ReplicationSet`) to exist.
 *
 * @section Creating Contacts
 * @example Personal contact
 * ```typescript
 * const oncall = yield* SSMContacts.Contact("Oncall", {
 *   type: "PERSONAL",
 *   displayName: "Primary On-Call",
 * });
 * ```
 *
 * @example Contact with an inline engagement plan
 * ```typescript
 * const channel = yield* SSMContacts.ContactChannel("Email", {
 *   contactId: oncall.contactArn,
 *   type: "EMAIL",
 *   deliveryAddress: { SimpleAddress: "oncall@example.com" },
 *   deferActivation: true,
 * });
 * const escalation = yield* SSMContacts.Contact("Escalation", {
 *   type: "ESCALATION",
 *   plan: {
 *     Stages: [
 *       {
 *         DurationInMinutes: 5,
 *         Targets: [
 *           { ContactTargetInfo: { ContactId: oncall.contactArn, IsEssential: true } },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 */
const ContactResource = Resource<Contact>("AWS.SSMContacts.Contact");

export { ContactResource as Contact };

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
};
const same = (l: unknown, r: unknown) =>
  JSON.stringify(normalize(l)) === JSON.stringify(normalize(r));

/** Parse a policy JSON string for structural comparison; fall back to the raw string. */
const parsePolicy = (policy: string): unknown => {
  try {
    return JSON.parse(policy);
  } catch {
    return policy;
  }
};

/** Builds the ARN of a contact from its alias in the ambient account/region. */
export const contactArn = Effect.fn(function* (alias: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:ssm-contacts:${region}:${accountId}:contact/${alias}`;
});

export const ContactProvider = () =>
  Provider.effect(
    ContactResource,
    Effect.gen(function* () {
      const createAlias = Effect.fn(function* (
        id: string,
        props: { alias?: string },
      ) {
        // Contact aliases must be lowercase.
        return (
          props.alias ??
          (yield* createPhysicalName({ id, maxLength: 200, lowercase: true }))
        );
      });

      const getContact = (arn: string) =>
        contacts
          .getContact({ ContactId: arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const readTags = (arn: string) =>
        contacts.listTagsForResource({ ResourceARN: arn }).pipe(
          // Distilled Tag has optional Key/Value; narrow to defined pairs
          // before handing off to the shared tagRecord helper.
          Effect.map((r) =>
            tagRecord(
              (r.Tags ?? []).flatMap((t) =>
                t.Key !== undefined && t.Value !== undefined
                  ? [{ Key: t.Key, Value: t.Value }]
                  : [],
              ),
            ),
          ),
          Effect.catch(() => Effect.succeed<Record<string, string>>({})),
        );

      const buildAttrs = (contact: contacts.GetContactResult) => ({
        contactArn: contact.ContactArn,
        alias: contact.Alias,
        type: contact.Type as string,
        displayName: contact.DisplayName,
      });

      return ContactResource.Provider.of({
        stables: ["contactArn", "alias", "type"],

        list: () =>
          contacts.listContacts.items({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((contact) => ({
                contactArn: contact.ContactArn,
                alias: contact.Alias,
                type: contact.Type as string,
                displayName: contact.DisplayName,
              })),
            ),
          ),

        read: Effect.fn(function* ({ id, olds, output }) {
          const alias = output?.alias ?? (yield* createAlias(id, olds ?? {}));
          const arn = output?.contactArn ?? (yield* contactArn(alias));
          const contact = yield* getContact(arn);
          if (contact === undefined) return undefined;
          const attrs = buildAttrs(contact);
          const tags = yield* readTags(contact.ContactArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Alias and type are create-only; display name, plan, and tags update
        // in place.
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldAlias = yield* createAlias(id, olds);
          const newAlias = yield* createAlias(id, news);
          if (oldAlias !== newAlias) return { action: "replace" } as const;
          if (olds.type !== news.type) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const alias = output?.alias ?? (yield* createAlias(id, news));
          const arn = output?.contactArn ?? (yield* contactArn(alias));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          let contact = yield* getContact(arn);

          // 2. ENSURE — create if missing; tolerate the already-exists race.
          if (contact === undefined) {
            yield* session.note(`creating contact ${alias}`);
            yield* contacts
              .createContact({
                Alias: alias,
                DisplayName: news.displayName,
                Type: news.type,
                Plan: news.plan ?? { Stages: [] },
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.asVoid,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            contact = (yield* getContact(arn))!;
          }

          // 3. SYNC display name + plan — diff observed against desired.
          //    `plan` is only managed here when the prop is provided, so the
          //    standalone `SSMContacts.Plan` resource can own it otherwise.
          const displayNameDelta =
            (contact.DisplayName ?? "") !== (news.displayName ?? "");
          const planDelta =
            news.plan !== undefined && !same(contact.Plan, news.plan);
          if (displayNameDelta || planDelta) {
            yield* contacts.updateContact({
              ContactId: contact.ContactArn,
              DisplayName: news.displayName ?? "",
              ...(planDelta ? { Plan: news.plan } : {}),
            });
          }

          // 3b. SYNC resource policy — observed vs desired. Only managed
          //     when the prop is provided; there is no delete-policy API.
          if (news.policy !== undefined) {
            const desiredPolicy =
              typeof news.policy === "string"
                ? news.policy
                : JSON.stringify(news.policy);
            const observedPolicy = yield* contacts
              .getContactPolicy({ ContactArn: contact.ContactArn })
              .pipe(
                Effect.map((r) => r.Policy),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (
              observedPolicy === undefined ||
              !same(parsePolicy(observedPolicy), parsePolicy(desiredPolicy))
            ) {
              yield* contacts.putContactPolicy({
                ContactArn: contact.ContactArn,
                Policy: desiredPolicy,
              });
            }
          }

          // 3c. SYNC tags — diff against OBSERVED cloud tags.
          const currentTags = yield* readTags(contact.ContactArn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* contacts.tagResource({
              ResourceARN: contact.ContactArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0) {
            yield* contacts.untagResource({
              ResourceARN: contact.ContactArn,
              TagKeys: removed,
            });
          }

          // 4. RETURN fresh attributes.
          const final = (yield* getContact(contact.ContactArn))!;
          yield* session.note(final.ContactArn);
          return buildAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* contacts.deleteContact({ ContactId: output.contactArn }).pipe(
            Effect.asVoid,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      });
    }),
  );
