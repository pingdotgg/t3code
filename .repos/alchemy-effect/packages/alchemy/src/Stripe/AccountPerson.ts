import {
  withRequestOptions,
  type StripeOpError,
} from "@distilled.cloud/stripe";
import {
  DeleteAccountPerson,
  GetAccounts,
  GetAccountPersons,
  GetAccountPerson,
  CreateAccountPerson,
  UpdateAccountPerson,
  type Account as StripeAccount,
  type Person as StripePerson,
  type PersonRelationship,
  type CreateAccountPersonRequestRelationship,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";
import { isMissingStripeResource } from "./missing.ts";

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 100;
const LIST_CONCURRENCY = 10;

export interface AccountPersonRelationship {
  /**
   * Whether the person is the authorizer of the account's representative.
   */
  authorizer?: boolean;
  /**
   * Whether the person is a director of the account's legal entity.
   */
  director?: boolean;
  /**
   * Whether the person has significant responsibility to control, manage,
   * or direct the organization.
   */
  executive?: boolean;
  /**
   * Whether the person is the legal guardian of the account's
   * representative.
   */
  legalGuardian?: boolean;
  /**
   * Whether the person is an owner of the account's legal entity.
   */
  owner?: boolean;
  /**
   * The percent owned by the person of the account's legal entity.
   */
  percentOwnership?: number;
  /**
   * Whether the person is authorized as the primary representative of the
   * account. There can only be one representative at a time.
   */
  representative?: boolean;
  /**
   * The person's title (e.g. CEO, Support Engineer).
   */
  title?: string;
}

export interface AccountPersonProps {
  /**
   * Id of the Connect account this person belongs to (`acct_…`).
   * Changing it replaces the person.
   */
  account: string;
  /**
   * The person's first name.
   */
  firstName?: string;
  /**
   * The person's last name.
   */
  lastName?: string;
  /**
   * The person's email address.
   */
  email?: string;
  /**
   * The person's phone number.
   */
  phone?: string;
  /**
   * The relationship this person has with the account's legal entity.
   */
  relationship?: AccountPersonRelationship;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically. Keys may
   * not contain `:`.
   */
  metadata?: Record<string, string>;
}

export type AccountPerson = Resource<
  "Stripe.AccountPerson",
  AccountPersonProps,
  {
    /** Stripe person id (`person_…`). */
    id: string;
    /** Id of the Connect account this person belongs to (`acct_…`). */
    account: string;
    /** The person's first name, if set. */
    firstName: string | undefined;
    /** The person's last name, if set. */
    lastName: string | undefined;
    /** The person's email address, if set. */
    email: string | undefined;
    /** The person's phone number, if set. */
    phone: string | undefined;
    /** Relationship to the account's legal entity, if set. */
    relationship: AccountPersonRelationship | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Unix timestamp when the person was created. */
    created: number;
  },
  never,
  Providers
>;

/**
 * A Stripe Person on a Connect account — a director, executive, owner, or
 * representative of the account's legal entity. Name, email, phone,
 * relationship, and metadata update in place. Changing `account` replaces
 * the person. Destroy deletes the person (the account opener cannot be
 * deleted).
 *
 * @see https://docs.stripe.com/api/persons
 *
 * ### Creating a Person
 * **Example:** Director on a Connect account
 * ```typescript
 * const person = yield* Stripe.AccountPerson("cfo", {
 *   account: account.id,
 *   firstName: "Jane",
 *   lastName: "Diaz",
 *   email: "jane.diaz@example.com",
 *   relationship: { director: true, title: "CFO" },
 * });
 * ```
 *
 * **Example:** Owner with metadata
 * ```typescript
 * const person = yield* Stripe.AccountPerson("owner", {
 *   account: account.id,
 *   firstName: "Alex",
 *   lastName: "Kim",
 *   relationship: { owner: true, percentOwnership: 25 },
 *   metadata: { role: "beneficial-owner" },
 * });
 * ```
 *
 * ### Updating a Person
 * **Example:** Change email and title
 * ```typescript
 * const person = yield* Stripe.AccountPerson("cfo", {
 *   account: account.id,
 *   firstName: "Jane",
 *   lastName: "Diaz",
 *   email: "jane.diaz+updated@example.com",
 *   relationship: { director: true, title: "COO" },
 * });
 * ```
 *
 * @resource
 */
export const AccountPerson = Resource<AccountPerson>("Stripe.AccountPerson");

type AccountPersonAttributes = AccountPerson["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const fromRelationship = (
  relationship: PersonRelationship | undefined,
): AccountPersonRelationship | undefined => {
  if (relationship === undefined) return undefined;
  const value: AccountPersonRelationship = {
    ...(relationship.authorizer != null
      ? { authorizer: relationship.authorizer }
      : {}),
    ...(relationship.director != null
      ? { director: relationship.director }
      : {}),
    ...(relationship.executive != null
      ? { executive: relationship.executive }
      : {}),
    ...(relationship.legal_guardian != null
      ? { legalGuardian: relationship.legal_guardian }
      : {}),
    ...(relationship.owner != null ? { owner: relationship.owner } : {}),
    ...(relationship.percent_ownership != null
      ? { percentOwnership: relationship.percent_ownership }
      : {}),
    ...(relationship.representative != null
      ? { representative: relationship.representative }
      : {}),
    ...(relationship.title != null ? { title: relationship.title } : {}),
  };
  return Object.keys(value).length === 0 ? undefined : value;
};

const toRelationshipWire = (
  relationship: AccountPersonRelationship,
): CreateAccountPersonRequestRelationship => ({
  ...(relationship.authorizer !== undefined
    ? { authorizer: relationship.authorizer }
    : {}),
  ...(relationship.director !== undefined
    ? { director: relationship.director }
    : {}),
  ...(relationship.executive !== undefined
    ? { executive: relationship.executive }
    : {}),
  ...(relationship.legalGuardian !== undefined
    ? { legal_guardian: relationship.legalGuardian }
    : {}),
  ...(relationship.owner !== undefined ? { owner: relationship.owner } : {}),
  ...(relationship.percentOwnership !== undefined
    ? { percent_ownership: relationship.percentOwnership }
    : {}),
  ...(relationship.representative !== undefined
    ? { representative: relationship.representative }
    : {}),
  ...(relationship.title !== undefined ? { title: relationship.title } : {}),
});

const sameFlag = (
  desired: boolean | undefined,
  observed: boolean | null | undefined,
): boolean => {
  if (desired === undefined) return true;
  return (observed ?? false) === desired;
};

const relationshipChanged = (
  desired: AccountPersonRelationship | undefined,
  observed: PersonRelationship | undefined,
): boolean => {
  if (desired === undefined) return false;
  if (!sameFlag(desired.authorizer, observed?.authorizer)) return true;
  if (!sameFlag(desired.director, observed?.director)) return true;
  if (!sameFlag(desired.executive, observed?.executive)) return true;
  if (!sameFlag(desired.legalGuardian, observed?.legal_guardian)) return true;
  if (!sameFlag(desired.owner, observed?.owner)) return true;
  if (
    desired.percentOwnership !== undefined &&
    observed?.percent_ownership !== desired.percentOwnership
  ) {
    return true;
  }
  if (!sameFlag(desired.representative, observed?.representative)) return true;
  if (
    desired.title !== undefined &&
    (observed?.title ?? "") !== desired.title
  ) {
    return true;
  }
  return false;
};

const toAttrs = (
  account: string,
  person: StripePerson,
): AccountPersonAttributes => ({
  id: person.id,
  account: person.account ?? account,
  firstName: person.first_name ?? undefined,
  lastName: person.last_name ?? undefined,
  email: person.email ?? undefined,
  phone: person.phone ?? undefined,
  relationship: fromRelationship(person.relationship),
  metadata: userMetadata(person.metadata),
  created: person.created,
});

const isMissing = isMissingStripeResource;

const isSkippedListError = (error: StripeOpError): boolean =>
  isMissing(error) ||
  error._tag === "InvalidRequestError" ||
  error._tag === "Forbidden";

const getById = (account: string, person: string) =>
  GetAccountPerson({ account, person }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
  );

const listPersons = Effect.fn(function* (account: string) {
  const people: StripePerson[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetAccountPersons({
      account,
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    }).pipe(
      Effect.catchIf(isSkippedListError, () => Effect.succeed(undefined)),
    );
    if (response === undefined) {
      break;
    }
    people.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return people;
});

const listAllAccounts = Effect.fn(function* () {
  const accounts: StripeAccount[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const response = yield* GetAccounts({
      limit: LIST_PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    accounts.push(...response.data);
    if (!response.has_more || response.data.length === 0) {
      break;
    }
    startingAfter = response.data[response.data.length - 1]?.id;
    if (startingAfter === undefined) {
      break;
    }
  }
  return accounts;
});

const findByAlchemyIdOnAccount = Effect.fn(function* (
  account: string,
  id: string,
) {
  const people = yield* listPersons(account);
  const matches: StripePerson[] = [];
  for (const person of people) {
    if (yield* hasAlchemyMetadata(id, tagRecord(person.metadata))) {
      matches.push(person);
    }
  }
  matches.sort((a, b) => b.created - a.created);
  return matches[0];
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const accounts = yield* listAllAccounts();
  const matches = yield* Effect.forEach(
    accounts,
    (account) => findByAlchemyIdOnAccount(account.id, id),
    { concurrency: LIST_CONCURRENCY },
  );
  const found = matches.filter(
    (person): person is StripePerson => person !== undefined,
  );
  found.sort((a, b) => b.created - a.created);
  return found[0];
});

const observe = Effect.fn(function* (input: {
  account?: string;
  id?: string;
  logicalId: string;
}) {
  if (input.account !== undefined && input.id !== undefined) {
    const byId = yield* getById(input.account, input.id);
    if (byId !== undefined) return byId;
  }
  if (input.account !== undefined) {
    const onAccount = yield* findByAlchemyIdOnAccount(
      input.account,
      input.logicalId,
    );
    if (onAccount !== undefined) return onAccount;
  }
  return yield* findByAlchemyId(input.logicalId);
});

const desiredMetadata = Effect.fn(function* (
  id: string,
  metadata: Record<string, string> | undefined,
) {
  return {
    ...toMetadata(metadata),
    ...(yield* createInternalMetadata(id)),
  };
});

const shouldReplace = (
  news: AccountPersonProps,
  output: AccountPersonAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  return news.account !== output.account;
};

export const AccountPersonProvider = () =>
  Provider.succeed(AccountPerson, {
    stables: ["id", "account", "created"],
    nuke: { dependsOn: ["Stripe.Account"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const account =
        output?.account ??
        (typeof olds?.account === "string" ? olds.account : undefined);
      const existing = yield* observe({
        account,
        id: output?.id,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const resolvedAccount = existing.account ?? account;
      if (resolvedAccount === undefined) return undefined;
      const attrs = toAttrs(resolvedAccount, existing);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const accounts = yield* listAllAccounts();
      const rows = yield* Effect.forEach(
        accounts,
        (account) =>
          listPersons(account.id).pipe(
            Effect.map((people) =>
              people
                .filter(
                  (person) =>
                    tagRecord(person.metadata)[alchemyMetadataKeys.stack] !==
                    undefined,
                )
                .map((person) => toAttrs(account.id, person)),
            ),
          ),
        { concurrency: LIST_CONCURRENCY },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output, instanceId }) {
      const metadata = yield* desiredMetadata(id, news.metadata);
      const desiredFirstName = news.firstName ?? "";
      const desiredLastName = news.lastName ?? "";
      const desiredEmail = news.email ?? "";
      const desiredPhone = news.phone ?? "";

      let current: StripePerson | undefined = yield* observe({
        account: news.account,
        id: output?.id,
        logicalId: id,
      });
      if (
        current !== undefined &&
        shouldReplace(news, toAttrs(news.account, current))
      ) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateAccountPerson({
          account: news.account,
          ...(desiredFirstName.length > 0
            ? { first_name: desiredFirstName }
            : {}),
          ...(desiredLastName.length > 0 ? { last_name: desiredLastName } : {}),
          ...(desiredEmail.length > 0 ? { email: desiredEmail } : {}),
          ...(desiredPhone.length > 0 ? { phone: desiredPhone } : {}),
          ...(news.relationship !== undefined
            ? { relationship: toRelationshipWire(news.relationship) }
            : {}),
          metadata,
        }).pipe(
          withRequestOptions({
            idempotencyKey: `alchemy-account-person-${instanceId}`,
          }),
        );
      }

      const observedMetadata = tagRecord(current.metadata);
      const { upsert, removed } = diffMetadata(observedMetadata, metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const firstNameChanged = (current.first_name ?? "") !== desiredFirstName;
      const lastNameChanged = (current.last_name ?? "") !== desiredLastName;
      const emailChanged = (current.email ?? "") !== desiredEmail;
      const phoneChanged = (current.phone ?? "") !== desiredPhone;
      const relChanged = relationshipChanged(
        news.relationship,
        current.relationship,
      );

      if (
        !firstNameChanged &&
        !lastNameChanged &&
        !emailChanged &&
        !phoneChanged &&
        !relChanged &&
        !metadataChanged
      ) {
        return toAttrs(news.account, current);
      }

      const updated = yield* UpdateAccountPerson({
        account: news.account,
        person: current.id,
        ...(firstNameChanged ? { first_name: desiredFirstName } : {}),
        ...(lastNameChanged ? { last_name: desiredLastName } : {}),
        ...(emailChanged ? { email: desiredEmail } : {}),
        ...(phoneChanged ? { phone: desiredPhone } : {}),
        ...(relChanged && news.relationship !== undefined
          ? { relationship: toRelationshipWire(news.relationship) }
          : {}),
        ...(metadataChanged
          ? {
              metadata: {
                ...Object.fromEntries(
                  upsert.map((tag) => [tag.Key, tag.Value]),
                ),
                ...Object.fromEntries(removed.map((key) => [key, ""])),
              },
            }
          : {}),
      });
      return toAttrs(news.account, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteAccountPerson({
        account: output.account,
        person: output.id,
      }).pipe(Effect.catchIf(isMissing, () => Effect.void));
    }),
  });
