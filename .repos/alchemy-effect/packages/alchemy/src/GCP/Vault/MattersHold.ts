import * as vault from "@distilled.cloud/gcp/vault_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredAccounts,
  encodeOwnershipLine,
  findHoldByName,
  findOwnedHold,
  getHold,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listActiveMatters,
  listHolds,
  MAX_HOLD_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameAccounts,
  sameOrgUnit,
  toGeneratedName,
} from "./internal.ts";

export type HeldAccount = {
  /** Primary email. Takes precedence over `accountId` on write. */
  email?: string;
  /** Admin SDK account id. */
  accountId?: string;
};

export type HeldOrgUnit = {
  /** Admin SDK organizational unit id. */
  orgUnitId?: string;
};

export type MattersHoldProps = {
  /**
   * Parent matter id. Immutable — changing it replaces the hold.
   */
  matterId: string;
  /**
   * Server-assigned hold id. Leave blank on create. Immutable —
   * changing it replaces the hold.
   */
  holdId?: string;
  /**
   * Hold name (max 100 characters including Alchemy's ownership marker).
   * Vault holds have no labels field, so ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes. Immutable —
   * changing it replaces the hold.
   */
  name?: string;
  /**
   * Workspace service covered by the hold. Immutable — changing it
   * replaces the hold.
   */
  corpus: vault.HoldCorpusEnum | (string & {});
  /**
   * Individual accounts covered by the hold. Mutually exclusive with
   * `orgUnit` — switching scope replaces the hold.
   */
  accounts?: HeldAccount[];
  /**
   * Organizational unit covered by the hold. Mutually exclusive with
   * `accounts` — switching scope replaces the hold.
   */
  orgUnit?: HeldOrgUnit;
  /**
   * Service-specific query options. Must match `corpus`.
   */
  query?: vault.CorpusQuery;
};

export type MattersHold = Resource<
  "GCP.Vault.MattersHold",
  MattersHoldProps,
  {
    /** Server-assigned hold id. */
    holdId: string;
    /** Parent matter id. */
    matterId: string;
    /** Project id used when the hold was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Workspace service covered by the hold. */
    corpus: string | undefined;
    /** Individual accounts on the hold. */
    accounts: HeldAccount[] | undefined;
    /** Organizational unit on the hold. */
    orgUnit: HeldOrgUnit | undefined;
    /** Service-specific query options. */
    query: vault.CorpusQuery | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Vault hold on a matter.
 *
 * Vault holds have no labels field, so Alchemy stamps ownership into
 * `name` for `list` / nuke. Parent matter, hold id, corpus, and name are
 * identity. Query, accounts, and org unit update in place. Switching
 * between accounts and an org unit replaces the hold.
 *
 * ### Creating a Hold
 * **Example:** Mail hold on accounts
 * ```typescript
 * const hold = yield* GCP.Vault.MattersHold("Mail", {
 *   matterId: matter.matterId,
 *   corpus: "MAIL",
 *   accounts: [{ email: "user@example.com" }],
 *   query: { mailQuery: { terms: "subject:contract" } },
 * });
 * ```
 *
 * **Example:** Drive hold on an org unit
 * ```typescript
 * const hold = yield* GCP.Vault.MattersHold("Drive", {
 *   matterId: matter.matterId,
 *   name: "Drive OU",
 *   corpus: "DRIVE",
 *   orgUnit: { orgUnitId: "id:ou" },
 *   query: { driveQuery: { includeSharedDriveFiles: true } },
 * });
 * ```
 *
 * ### Updating a Hold
 * **Example:** Narrow the mail query
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const hold = yield* GCP.Vault.MattersHold("Mail", {
 *   matterId: matter.matterId,
 *   corpus: "MAIL",
 *   accounts: [{ email: "user@example.com" }],
 *   query: { mailQuery: { terms: "subject:contract 2026" } },
 * });
 * ```
 *
 * @resource
 * @category Vault
 */
export const MattersHold = Resource<MattersHold>("GCP.Vault.MattersHold");

export class MattersHoldNotResolved extends Data.TaggedError(
  "GCP.Vault.MattersHoldNotResolved",
)<{
  matterId: string;
  holdId: string;
}> {}

const accountsOf = (
  accounts: vault.HeldAccountList | undefined,
): HeldAccount[] | undefined => {
  if (accounts === undefined) return undefined;
  return accounts.map((account) => ({
    email: account.email,
    accountId: account.accountId,
  }));
};

const orgUnitOf = (
  orgUnit: vault.HeldOrgUnit | undefined,
): HeldOrgUnit | undefined => {
  if (orgUnit === undefined) return undefined;
  return { orgUnitId: orgUnit.orgUnitId };
};

const toAttrs = (hold: vault.Hold, matterId: string, project: string) => ({
  holdId: hold.holdId ?? "",
  matterId: matterId,
  project,
  name: parseOwnership(hold.name).text,
  corpus: hold.corpus,
  accounts: accountsOf(hold.accounts),
  orgUnit: orgUnitOf(hold.orgUnit),
  query: hold.query,
  updateTime: hold.updateTime,
});

export const MattersHoldProvider = () =>
  Provider.succeed(MattersHold, {
    stables: ["holdId", "matterId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMatter = olds?.matterId ?? output?.matterId;
      if (previousMatter !== undefined && news.matterId !== previousMatter) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.holdId ?? output?.holdId;
      if (
        previousId !== undefined &&
        news.holdId !== undefined &&
        news.holdId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousCorpus = olds?.corpus ?? output?.corpus;
      if (previousCorpus !== undefined && news.corpus !== previousCorpus) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousName = olds?.name ?? output?.name;
      if (
        news.name !== undefined &&
        previousName !== undefined &&
        news.name !== previousName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousOrg = olds?.orgUnit ?? output?.orgUnit;
      const previousAccounts = olds?.accounts ?? output?.accounts;
      if (
        previousOrg?.orgUnitId !== undefined &&
        news.accounts !== undefined &&
        news.accounts.length > 0
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (
        previousAccounts !== undefined &&
        previousAccounts.length > 0 &&
        news.orgUnit?.orgUnitId !== undefined
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const matterId = olds?.matterId ?? output?.matterId ?? "";
      const holdId = olds?.holdId ?? output?.holdId ?? "";
      let existing = yield* getHold(matterId, holdId);
      let parentId = matterId;
      if (existing === undefined) {
        const ownership = yield* ownershipLabels(id);
        const name = encodeOwnershipLine(
          ownership,
          olds?.name ?? output?.name,
          MAX_HOLD_NAME_LENGTH,
        );
        existing = yield* findHoldByName(matterId, name);
      }
      if (existing === undefined) {
        const owned = yield* findOwnedHold(id, matterId);
        if (owned !== undefined) {
          existing = owned.hold;
          parentId = owned.matterId;
        }
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        parentId || (existing.holdId ?? ""),
        env.project,
      );
      const resolvedMatter = parentId.length > 0 ? parentId : attrs.matterId;
      return (yield* ownedByAlchemy(id, existing.name))
        ? { ...attrs, matterId: resolvedMatter }
        : Unowned({ ...attrs, matterId: resolvedMatter });
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const matters = yield* listActiveMatters();
        const pages = yield* Effect.forEach(
          matters,
          (matter) =>
            listHolds(matter.matterId ?? "").pipe(
              Effect.map((holds) =>
                holds
                  .filter((hold) => hasOwnershipMarker(hold.name))
                  .map((hold) =>
                    toAttrs(hold, matter.matterId ?? "", env.project),
                  ),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const matterId = news.matterId;
      const ownership = yield* ownershipLabels(id);
      const displayName = yield* toGeneratedName(
        id,
        news.name,
        output?.name,
        40,
      );
      const name = encodeOwnershipLine(
        ownership,
        displayName,
        MAX_HOLD_NAME_LENGTH,
      );
      const accounts = desiredAccounts(news.accounts);
      const desired: vault.Hold = {
        name,
        corpus: news.corpus,
        accounts,
        orgUnit: news.orgUnit,
        query: news.query,
      };

      let current = yield* getHold(
        matterId,
        news.holdId ?? output?.holdId ?? "",
      );
      if (current === undefined) {
        current = yield* findHoldByName(matterId, name);
      }
      if (current === undefined) {
        const owned = yield* findOwnedHold(id, matterId);
        current = owned?.hold;
      }

      if (current === undefined) {
        const created = yield* vault
          .createMattersHolds({
            matterId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findHoldByName(matterId, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new MattersHoldNotResolved({
          matterId,
          holdId: news.holdId ?? output?.holdId ?? name,
        });
      }

      const holdId = current.holdId ?? news.holdId ?? output?.holdId ?? "";
      const queryChanged =
        news.query !== undefined && !jsonEqual(current.query, news.query);
      const accountsChanged =
        news.accounts !== undefined &&
        !sameAccounts(current.accounts, news.accounts);
      const orgUnitChanged =
        news.orgUnit !== undefined &&
        !sameOrgUnit(current.orgUnit, news.orgUnit);

      if (queryChanged || accountsChanged || orgUnitChanged) {
        current = yield* vault.updateMattersHolds({
          matterId,
          holdId,
          body: {
            query: news.query ?? current.query,
            accounts: accounts ?? current.accounts,
            orgUnit: news.orgUnit ?? current.orgUnit,
          },
        });
      }

      return toAttrs(current, matterId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.matterId.length === 0 || output.holdId.length === 0) return;
      yield* ignoreMissing(
        vault.deleteMattersHolds({
          matterId: output.matterId,
          holdId: output.holdId,
        }),
      );
    }),
  });
