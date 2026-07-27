import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Dlp.Profile" as const;
type TypeId = typeof TypeId;

/**
 * A detection entry defined inline on the profile — a regular expression
 * the DLP engine scans for.
 */
export interface ProfileEntry {
  /** Name of the entry. Unique within the profile. */
  name: string;
  /** Whether the entry participates in scans. */
  enabled: boolean;
  /** The detection pattern. */
  pattern: {
    /** The regular expression to match. */
    regex: string;
    /** Optional checksum validation applied to matches. */
    validation?: "luhn";
  };
  /** Optional description of the entry. */
  description?: string;
}

export interface ProfileProps {
  /**
   * Name of the profile. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The description of the profile.
   */
  description?: string;
  /**
   * Related DLP policies will trigger when the match count exceeds this
   * number.
   * @default 0
   */
  allowedMatchCount?: number;
  /**
   * Whether to scan images via OCR.
   */
  ocrEnabled?: boolean;
  /**
   * Confidence threshold applied to AI-context detections
   * (`low` | `medium` | `high` | `very_high`).
   */
  confidenceThreshold?: string;
  /**
   * Custom detection entries owned by this profile. Synced declaratively:
   * entries are matched to observed entries by name; entries removed from
   * this list are deleted from the profile.
   */
  entries?: ProfileEntry[];
}

export type ProfileAttributes = {
  /** API UUID of the profile. */
  profileId: string;
  /** Account that owns the profile. */
  accountId: string;
  /** Observed profile name. */
  name: string;
  /** Observed description, if any. */
  description: string | undefined;
  /** Observed allowed match count. */
  allowedMatchCount: number;
  /** Whether OCR scanning is enabled. */
  ocrEnabled: boolean;
  /** Ids of the custom entries owned by the profile, keyed by name. */
  entryIds: Record<string, string>;
};

export type Profile = Resource<
  TypeId,
  ProfileProps,
  ProfileAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **DLP custom profile** — a named collection of
 * detection entries (regular expressions) that Gateway HTTP policies and
 * CASB integrations reference to detect sensitive data in transit.
 *
 * Requires the Cloudflare DLP entitlement (a paid Zero Trust add-on);
 * accounts without it receive the typed `Forbidden` error on all writes.
 * @resource
 * @product DLP
 * @category Cloudflare One (Zero Trust)
 * @section Creating a DLP profile
 * @example Profile with a custom regex entry
 * ```typescript
 * const profile = yield* Cloudflare.Dlp.Profile("EmployeeIds", {
 *   description: "Detects internal employee identifiers",
 *   allowedMatchCount: 0,
 *   entries: [
 *     {
 *       name: "employee-id",
 *       enabled: true,
 *       pattern: { regex: "EMP-[0-9]{6}" },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Credit-card-like entry with Luhn validation
 * ```typescript
 * const cards = yield* Cloudflare.Dlp.Profile("Cards", {
 *   entries: [
 *     {
 *       name: "card-number",
 *       enabled: true,
 *       pattern: { regex: "[0-9]{13,16}", validation: "luhn" },
 *     },
 *   ],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/policies/data-loss-prevention/dlp-profiles/
 */
export const Profile = Resource<Profile>(TypeId);

/**
 * Returns true if the given value is a Profile resource.
 */
export const isProfile = (value: unknown): value is Profile =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ProfileProvider = () =>
  Provider.succeed(Profile, {
    stables: ["profileId", "accountId"],

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // DLP profiles are only refreshed by id; without a persisted id
      // there is nothing safe to adopt (names are not guaranteed unique
      // and the entitlement is account-gated).
      if (!output?.profileId) return undefined;
      const observed = yield* observeProfile(acct, output.profileId);
      return observed ? toAttributes(observed, acct) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* createProfileName(id, news.name);

      // 1. Observe.
      const observed = output?.profileId
        ? yield* observeProfile(accountId, output.profileId)
        : undefined;

      // 2. Ensure — create with the full desired state when missing.
      if (!observed) {
        const created = yield* zeroTrust.createDlpProfileCustom({
          accountId,
          name,
          ...(news.description !== undefined
            ? { description: news.description }
            : {}),
          ...(news.allowedMatchCount !== undefined
            ? { allowedMatchCount: news.allowedMatchCount }
            : {}),
          ...(news.ocrEnabled !== undefined
            ? { ocrEnabled: news.ocrEnabled }
            : {}),
          ...(news.confidenceThreshold !== undefined
            ? { confidenceThreshold: news.confidenceThreshold }
            : {}),
          ...(news.entries !== undefined
            ? { entries: news.entries.map(encodeNewEntry) }
            : {}),
        });
        const createdCustom = narrowCustom(created);
        return toAttributes(createdCustom, accountId);
      }

      // 3. Sync — PUT the full desired state when the observed state
      //    differs. Observed entries are matched to desired entries by
      //    name so existing entry ids are preserved.
      const dirty =
        observed.name !== name ||
        (observed.description ?? undefined) !== news.description ||
        observed.allowedMatchCount !== (news.allowedMatchCount ?? 0) ||
        observed.ocrEnabled !== (news.ocrEnabled ?? false) ||
        (news.confidenceThreshold !== undefined &&
          (observed.confidenceThreshold ?? undefined) !==
            news.confidenceThreshold) ||
        !sameEntries(observed, news.entries);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }
      const observedIds = entryIdsByName(observed);
      const updated = yield* zeroTrust.updateDlpProfileCustom({
        accountId,
        profileId: observed.id,
        name,
        description: news.description ?? null,
        allowedMatchCount: news.allowedMatchCount ?? 0,
        ocrEnabled: news.ocrEnabled ?? false,
        ...(news.confidenceThreshold !== undefined
          ? { confidenceThreshold: news.confidenceThreshold }
          : {}),
        ...(news.entries !== undefined
          ? {
              entries: news.entries.map((entry) => {
                const entryId = observedIds[entry.name];
                return entryId !== undefined
                  ? { ...encodeNewEntry(entry), entryId }
                  : encodeNewEntry(entry);
              }),
            }
          : {}),
      });
      return toAttributes(narrowCustom(updated), accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteDlpProfileCustom({
          accountId: output.accountId,
          profileId: output.profileId,
        })
        .pipe(Effect.catchTag("DlpProfileNotFound", () => Effect.void));
    }),

    // Account-scoped collection (pattern b): enumerate every custom DLP
    // profile via the account profiles list, then hydrate each by id into
    // the exact `read` Attributes shape so list items are delete-ready.
    // The list endpoint also returns predefined / integration profiles —
    // only `custom` profiles are modelled by this resource, so the rest
    // are filtered out.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const profileIds = yield* zeroTrust.listDlpProfiles
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).flatMap((profile) =>
                profile.type === "custom" ? [profile.id] : [],
              ),
            ),
          ),
        );

      const rows = yield* Effect.forEach(
        profileIds,
        (profileId) =>
          observeProfile(accountId, profileId).pipe(
            Effect.map((observed) =>
              observed ? toAttributes(observed, accountId) : undefined,
            ),
          ),
        { concurrency: 10 },
      );

      return rows.filter((row): row is ProfileAttributes => row !== undefined);
    }),
  });

/**
 * The custom-profile member of the DLP profile response union.
 */
type ObservedCustomProfile = Extract<
  zeroTrust.GetDlpProfileCustomResponse,
  { type: "custom" }
>;

/**
 * Narrow a profile response union to its `custom` member. Create/update
 * on the custom endpoint always return a custom profile; a different
 * shape would be a Cloudflare contract break, so fall back to a minimal
 * empty view rather than crash the engine.
 */
const narrowCustom = (
  profile: zeroTrust.GetDlpProfileCustomResponse,
): ObservedCustomProfile | undefined =>
  "type" in profile && profile.type === "custom" ? profile : undefined;

/**
 * Read a profile by id, mapping "gone" to `undefined` and narrowing to
 * the custom variant.
 */
const observeProfile = (accountId: string, profileId: string) =>
  zeroTrust.getDlpProfileCustom({ accountId, profileId }).pipe(
    Effect.map(narrowCustom),
    Effect.catchTag("DlpProfileNotFound", () => Effect.succeed(undefined)),
  );

const createProfileName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const encodeNewEntry = (
  entry: ProfileEntry,
): {
  enabled: boolean;
  name: string;
  pattern: { regex: string; validation?: "luhn" };
  description?: string | null;
} => ({
  enabled: entry.enabled,
  name: entry.name,
  pattern: {
    regex: entry.pattern.regex,
    ...(entry.pattern.validation !== undefined
      ? { validation: entry.pattern.validation }
      : {}),
  },
  ...(entry.description !== undefined
    ? { description: entry.description }
    : {}),
});

/**
 * Custom regex entries observed on the profile, keyed by name.
 */
const customEntries = (profile: ObservedCustomProfile | undefined) =>
  (profile?.entries ?? []).flatMap((entry) =>
    entry.type === "custom" ? [entry] : [],
  );

const entryIdsByName = (
  profile: ObservedCustomProfile | undefined,
): Record<string, string> =>
  Object.fromEntries(customEntries(profile).map((e) => [e.name, e.id]));

const sameEntries = (
  observed: ObservedCustomProfile,
  desired: ProfileEntry[] | undefined,
): boolean => {
  if (desired === undefined) return true;
  const observedByName = new Map(
    customEntries(observed).map((e) => [e.name, e]),
  );
  if (observedByName.size !== desired.length) return false;
  return desired.every((entry) => {
    const live = observedByName.get(entry.name);
    return (
      live !== undefined &&
      live.enabled === entry.enabled &&
      live.pattern.regex === entry.pattern.regex &&
      (live.pattern.validation ?? undefined) === entry.pattern.validation
    );
  });
};

const toAttributes = (
  profile: ObservedCustomProfile | undefined,
  accountId: string,
): ProfileAttributes => ({
  profileId: profile?.id ?? "",
  accountId,
  name: profile?.name ?? "",
  description: profile?.description ?? undefined,
  allowedMatchCount: profile?.allowedMatchCount ?? 0,
  ocrEnabled: profile?.ocrEnabled ?? false,
  entryIds: entryIdsByName(profile),
});
