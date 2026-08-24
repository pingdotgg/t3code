import * as logs from "@distilled.cloud/cloudflare/logs";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Logs.RetentionFlag" as const;
type TypeId = typeof TypeId;

export type LogsRetentionFlagProps = {
  /**
   * Zone whose Logpull retention flag is managed. The flag is a zone-level
   * singleton, so the zone is the resource's identity — changing it
   * triggers a replacement (the old zone's flag is restored to the value
   * it had before Alchemy managed it).
   */
  zoneId: string;
  /**
   * Whether Logpull log retention is enabled for the zone. Mutable —
   * re-posted in place.
   */
  flag: boolean;
};

export type LogsRetentionFlagAttributes = {
  /** Zone the retention flag belongs to. */
  zoneId: string;
  /** Whether Logpull log retention is enabled. */
  flag: boolean;
  /**
   * The value the flag had before Alchemy first managed it. Restored on
   * destroy, so deleting the resource puts the zone back the way it was
   * found.
   */
  initialFlag: boolean;
};

export type LogsRetentionFlag = Resource<
  TypeId,
  LogsRetentionFlagProps,
  LogsRetentionFlagAttributes,
  never,
  Providers
>;

/**
 * The zone-level Logpull retention flag
 * (`/zones/{zone_id}/logs/control/retention/flag`) pinned to a desired
 * value.
 *
 * The flag is a singleton that always exists on every zone, so this
 * resource never creates or deletes anything physical. Reconcile re-posts
 * the flag when the observed value differs from the desired one; destroy
 * restores the value the flag had before Alchemy first managed it
 * (captured as `initialFlag`) — there is no DELETE endpoint.
 *
 * Logpull is an Enterprise feature — on unentitled zones every operation
 * fails with the typed `LogsControlNotAuthorized` error.
 * @resource
 * @product Logs
 * @category Observability & Analytics
 * @section Managing log retention
 * @example Enable Logpull retention on a zone
 * ```typescript
 * const retention = yield* Cloudflare.LogsControl.LogsRetentionFlag("Retention", {
 *   zoneId: zone.zoneId,
 *   flag: true,
 * });
 * ```
 *
 * @example Explicitly disable retention
 * ```typescript
 * yield* Cloudflare.LogsControl.LogsRetentionFlag("Retention", {
 *   zoneId: zone.zoneId,
 *   flag: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/logs/logpull/enabling-log-retention/
 */
export const LogsRetentionFlag = Resource<LogsRetentionFlag>(TypeId);

/**
 * Returns true if the given value is a LogsRetentionFlag resource.
 */
export const isLogsRetentionFlag = (
  value: unknown,
): value is LogsRetentionFlag =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const LogsRetentionFlagProvider = () =>
  Provider.succeed(LogsRetentionFlag, {
    stables: ["zoneId", "initialFlag"],

    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // No account-wide API for this zone singleton — enumerate every
      // zone in the account and read its retention flag (every zone has
      // one). The observed value at enumeration time is the zone's
      // original, so it doubles as `initialFlag`.
      const allZones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        allZones.map((zone) => zone.id),
        (zoneId) =>
          getFlag(zoneId).pipe(
            Effect.map((flag) =>
              flag === undefined
                ? undefined
                : ({
                    zoneId,
                    flag,
                    initialFlag: flag,
                  } satisfies LogsRetentionFlagAttributes),
            ),
            // Logpull is Enterprise-only; unentitled zones reject with the
            // typed error — skip them rather than fail the whole listing.
            Effect.catchTag("LogsControlNotAuthorized", () =>
              Effect.succeed(undefined),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is LogsRetentionFlagAttributes => row !== undefined,
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // The zone is the singleton's identity.
      if (output !== undefined && output.zoneId !== news.zoneId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (zoneId === undefined) return undefined;
      const observed = yield* getFlag(zoneId);
      // Zone deleted out-of-band — the flag is gone with it.
      if (observed === undefined) return undefined;
      // The flag is a zone singleton that always exists — there is nothing
      // to "own", so a cold read adopts freely. The observed value at
      // adoption time becomes the `initialFlag` restored on destroy.
      const initialFlag = output?.initialFlag ?? observed;
      return { zoneId, flag: observed, initialFlag };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs were resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;

      // 1. Observe — the flag always exists; read its live value.
      const observed = yield* logs
        .getControlRetention({ zoneId })
        .pipe(Effect.map((r) => r.flag ?? false));

      // 2. Capture — the pre-management value, restored on destroy.
      const initialFlag = output?.initialFlag ?? observed;

      // 3. Sync — re-post only when the observed value differs.
      if (observed === news.flag) {
        return { zoneId, flag: observed, initialFlag };
      }
      const updated = yield* logs.createControlRetention({
        zoneId,
        flag: news.flag,
      });
      return { zoneId, flag: updated.flag ?? news.flag, initialFlag };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { zoneId, initialFlag } = output;
      // Observe — if the zone itself is gone, so is the flag.
      const observed = yield* getFlag(zoneId);
      if (observed === undefined) return;
      // Restore the pre-management value; skip the call when it already
      // matches (idempotent re-delete after a crashed run).
      if (observed === initialFlag) return;
      yield* logs
        .createControlRetention({ zoneId, flag: initialFlag })
        .pipe(Effect.catchTag("InvalidRoute", () => Effect.void));
    }),
  });

/**
 * Read the retention flag, normalizing a missing zone (`InvalidRoute`,
 * Cloudflare error code 7003) to `undefined` and a null flag to `false`.
 */
const getFlag = (zoneId: string) =>
  logs.getControlRetention({ zoneId }).pipe(
    Effect.map((r) => r.flag ?? false),
    Effect.catchTag("InvalidRoute", () => Effect.succeed(undefined)),
  );
