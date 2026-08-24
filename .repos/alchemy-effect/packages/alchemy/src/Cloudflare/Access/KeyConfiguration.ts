import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Access.KeyConfiguration" as const;
type TypeId = typeof TypeId;

export type KeyConfigurationProps = {
  /**
   * The number of days between automatic Access service key rotations.
   * Cloudflare accepts values between 21 and 372 days.
   *
   * Mutable — converged in place via PUT.
   */
  keyRotationIntervalDays: number;
};

export type KeyConfigurationAttributes = {
  /** Cloudflare account the key configuration belongs to. */
  accountId: string;
  /** The number of days between key rotations. */
  keyRotationIntervalDays: number | undefined;
  /** The number of days until the next key rotation. */
  daysUntilNextRotation: number | undefined;
  /** The timestamp of the previous key rotation, if one has happened. */
  lastKeyRotationAt: string | undefined;
  /**
   * The rotation interval the account had before Alchemy first managed it.
   * Restored on destroy, so deleting the resource puts the account back
   * the way it was found. `undefined` when Cloudflare reported no interval
   * at adoption time — destroy then leaves the current interval in place.
   */
  initialKeyRotationIntervalDays: number | undefined;
};

export type KeyConfiguration = Resource<
  TypeId,
  KeyConfigurationProps,
  KeyConfigurationAttributes,
  never,
  Providers
>;

/**
 * The Cloudflare Zero Trust Access service-key rotation configuration for an
 * account (`/accounts/{account_id}/access/keys`).
 *
 * The key configuration is an account singleton — it always exists, so this
 * resource never creates or deletes anything physical. Reconcile PUTs the
 * rotation interval when the observed value differs from the desired one;
 * destroy restores the interval the account had before Alchemy first managed
 * it (captured as `initialKeyRotationIntervalDays`).
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Managing the rotation interval
 * @example Rotate Access service keys every 30 days
 * ```typescript
 * const keys = yield* Cloudflare.Access.KeyConfiguration("Keys", {
 *   keyRotationIntervalDays: 30,
 * });
 * ```
 *
 * @example Inspect rotation status
 * ```typescript
 * const keys = yield* Cloudflare.Access.KeyConfiguration("Keys", {
 *   keyRotationIntervalDays: 90,
 * });
 * // keys.daysUntilNextRotation, keys.lastKeyRotationAt
 * ```
 *
 * @see https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/keys/
 */
export const KeyConfiguration = Resource<KeyConfiguration>(TypeId);

/**
 * Returns true if the given value is an KeyConfiguration resource.
 */
export const isKeyConfiguration = (value: unknown): value is KeyConfiguration =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const KeyConfigurationProvider = () =>
  Provider.succeed(KeyConfiguration, {
    nuke: { singleton: true },
    stables: ["accountId", "initialKeyRotationIntervalDays"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Per-account singleton: the key configuration always exists with a
      // Cloudflare default and there is no enumeration API — read the one
      // instance and return it as a one-element array. The observed
      // interval becomes the value restored on destroy (adoption read).
      const observed = yield* zeroTrust.getAccessKey({ accountId });
      return [
        toAttributes(
          accountId,
          observed,
          observed.keyRotationIntervalDays ?? undefined,
        ),
      ];
    }),

    diff: Effect.fn(function* ({ output }) {
      // The configuration is an account singleton — its identity is the
      // account. Moving accounts replaces (old account's interval is
      // restored as the old instance deletes).
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const observed = yield* zeroTrust.getAccessKey({ accountId: acct });
      // The configuration is a singleton that always exists with a
      // Cloudflare default — there is nothing to "own", so a cold read
      // adopts freely (never `Unowned`). The observed interval at adoption
      // time becomes the value restored on destroy.
      const initial =
        output !== undefined
          ? output.initialKeyRotationIntervalDays
          : (observed.keyRotationIntervalDays ?? undefined);
      return toAttributes(acct, observed, initial);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — the configuration always exists; read the live value.
      const observed = yield* zeroTrust.getAccessKey({ accountId });

      // 2. Capture — the pre-management interval, restored on destroy.
      //    `output` (including an adoption read) already carries it;
      //    otherwise this is our first touch and the observed interval is
      //    the account's original.
      const initial =
        output !== undefined
          ? output.initialKeyRotationIntervalDays
          : (observed.keyRotationIntervalDays ?? undefined);

      // 3. Sync — PUT only when the observed interval differs.
      if (observed.keyRotationIntervalDays === news.keyRotationIntervalDays) {
        return toAttributes(accountId, observed, initial);
      }
      const updated = yield* zeroTrust.putAccessKey({
        accountId,
        keyRotationIntervalDays: news.keyRotationIntervalDays,
      });
      return toAttributes(accountId, updated, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { accountId, initialKeyRotationIntervalDays } = output;
      // Nothing physical to delete — restore the pre-management interval.
      // If Cloudflare reported no interval at adoption time there is
      // nothing to restore to; leave the current value in place.
      if (initialKeyRotationIntervalDays === undefined) return;
      const observed = yield* zeroTrust.getAccessKey({ accountId });
      // Skip the PUT when the live value already matches (idempotent
      // re-delete after a crashed run).
      if (observed.keyRotationIntervalDays === initialKeyRotationIntervalDays) {
        return;
      }
      yield* zeroTrust.putAccessKey({
        accountId,
        keyRotationIntervalDays: initialKeyRotationIntervalDays,
      });
    }),
  });

const toAttributes = (
  accountId: string,
  observed: zeroTrust.GetAccessKeyResponse | zeroTrust.PutAccessKeyResponse,
  initialKeyRotationIntervalDays: number | undefined,
): KeyConfigurationAttributes => ({
  accountId,
  keyRotationIntervalDays: observed.keyRotationIntervalDays ?? undefined,
  daysUntilNextRotation: observed.daysUntilNextRotation ?? undefined,
  lastKeyRotationAt: observed.lastKeyRotationAt ?? undefined,
  initialKeyRotationIntervalDays,
});
