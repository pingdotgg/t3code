import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Dlp.Entry" as const;
type TypeId = typeof TypeId;

export interface EntryProps {
  /**
   * Name of the entry. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Whether the entry participates in scans.
   * @default true
   */
  enabled?: boolean;
  /**
   * The detection pattern.
   */
  pattern: {
    /** The regular expression to match. */
    regex: string;
    /** Optional checksum validation applied to matches. */
    validation?: "luhn";
  };
  /**
   * Optional description of the entry.
   */
  description?: string;
  /**
   * The custom DLP profile to attach the entry to at create time.
   * Immutable — changing it triggers a replacement.
   */
  profileId?: string;
}

export type EntryAttributes = {
  /** API UUID of the entry. */
  entryId: string;
  /** Account that owns the entry. */
  accountId: string;
  /** Observed entry name. */
  name: string;
  /** Whether the entry participates in scans. */
  enabled: boolean;
  /** Observed detection pattern. */
  pattern: { regex: string; validation: "luhn" | undefined };
  /** The profile the entry is attached to, if any. */
  profileId: string | undefined;
};

export type Entry = Resource<
  TypeId,
  EntryProps,
  EntryAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **DLP custom entry** — a standalone regular-
 * expression detection that can be attached to a custom DLP profile.
 * Use it when entries are managed independently of the
 * {@link Profile} that groups them.
 *
 * Requires the Cloudflare DLP entitlement (a paid Zero Trust add-on);
 * accounts without it receive the typed `Forbidden` error on all writes.
 * @resource
 * @product DLP
 * @category Cloudflare One (Zero Trust)
 * @section Creating a DLP entry
 * @example Attach a regex entry to a profile
 * ```typescript
 * const entry = yield* Cloudflare.Dlp.Entry("EmployeeId", {
 *   pattern: { regex: "EMP-[0-9]{6}" },
 *   profileId: profile.profileId,
 * });
 * ```
 *
 * @example Luhn-validated card entry
 * ```typescript
 * const card = yield* Cloudflare.Dlp.Entry("CardNumber", {
 *   pattern: { regex: "[0-9]{13,16}", validation: "luhn" },
 *   profileId: profile.profileId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/policies/data-loss-prevention/dlp-profiles/
 */
export const Entry = Resource<Entry>(TypeId);

/**
 * Returns true if the given value is a Entry resource.
 */
export const isEntry = (value: unknown): value is Entry =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const EntryProvider = () =>
  Provider.succeed(Entry, {
    stables: ["entryId", "accountId", "profileId"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // The profile association is set at create time only — replace
      // when it changes.
      const oldProfileId = output?.profileId ?? olds?.profileId;
      if (oldProfileId !== undefined && oldProfileId !== news.profileId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Entries are only refreshed by id; without a persisted id there is
      // nothing safe to adopt (the entitlement is account-gated).
      if (!output?.entryId) return undefined;
      const observed = yield* observeEntry(acct, output.entryId);
      return observed ? toAttributes(observed, acct) : undefined;
    }),

    // Account collection: enumerate every custom DLP entry in the account
    // (GET /accounts/{id}/dlp/entries), exhaustively paginated. The list
    // response is a union of entry variants; only the `custom` variant is
    // an alchemy-managed Entry, so we narrow to it and hydrate into the
    // exact `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listDlpEntryCustoms.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              .filter(
                (entry): entry is typeof entry & { type: "custom" } =>
                  "type" in entry && entry.type === "custom",
              )
              .map((entry) => toAttributes(entry, accountId)),
          ),
        ),
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createEntryName(id, news.name);

      // 1. Observe.
      const observed = output?.entryId
        ? yield* observeEntry(accountId, output.entryId)
        : undefined;

      // 2. Ensure — create when missing.
      if (!observed) {
        const created = yield* zeroTrust.createDlpEntryCustom({
          accountId,
          name,
          enabled: news.enabled ?? true,
          pattern: encodePattern(news.pattern),
          ...(news.description !== undefined
            ? { description: news.description }
            : {}),
          ...(news.profileId !== undefined
            ? { profileId: news.profileId }
            : {}),
        });
        return toAttributes(created, accountId);
      }

      // 3. Sync — PUT the full desired state when the observed state
      //    differs; skip the call on a no-op.
      const dirty =
        observed.name !== name ||
        observed.enabled !== (news.enabled ?? true) ||
        observed.pattern.regex !== news.pattern.regex ||
        (observed.pattern.validation ?? undefined) !== news.pattern.validation;
      if (!dirty) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* zeroTrust.updateDlpEntryCustom({
        accountId,
        entryId: observed.id,
        name,
        enabled: news.enabled ?? true,
        pattern: encodePattern(news.pattern),
        ...(news.description !== undefined
          ? { description: news.description }
          : {}),
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteDlpEntryCustom({
          accountId: output.accountId,
          entryId: output.entryId,
        })
        .pipe(Effect.catchTag("DlpEntryNotFound", () => Effect.void));
    }),
  });

/**
 * Structural shape shared by the custom variant of get/create/update
 * responses.
 */
type ObservedEntry = {
  id: string;
  enabled: boolean;
  name: string;
  pattern: { regex: string; validation?: "luhn" | null };
  description?: string | null;
  profileId?: string | null;
};

/**
 * Read an entry by id, mapping "gone" to `undefined` and narrowing to
 * the `custom` variant of the response union.
 */
const observeEntry = (accountId: string, entryId: string) =>
  zeroTrust.getDlpEntryCustom({ accountId, entryId }).pipe(
    Effect.map((entry) =>
      "type" in entry && entry.type === "custom" ? entry : undefined,
    ),
    Effect.catchTag("DlpEntryNotFound", () => Effect.succeed(undefined)),
  );

const createEntryName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const encodePattern = (pattern: {
  regex: string;
  validation?: "luhn";
}): { regex: string; validation?: "luhn" } => ({
  regex: pattern.regex,
  ...(pattern.validation !== undefined
    ? { validation: pattern.validation }
    : {}),
});

const toAttributes = (
  entry: ObservedEntry,
  accountId: string,
): EntryAttributes => ({
  entryId: entry.id,
  accountId,
  name: entry.name,
  enabled: entry.enabled,
  pattern: {
    regex: entry.pattern.regex,
    validation: entry.pattern.validation ?? undefined,
  },
  profileId: entry.profileId ?? undefined,
});
