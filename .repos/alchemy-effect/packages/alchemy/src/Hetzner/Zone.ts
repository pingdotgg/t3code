import { Services } from "@distilled.cloud/hetzner";
import type {
  ZonePrimary,
  ZoneSecondary,
} from "@distilled.cloud/hetzner/zones";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { recordsEqual } from "../Util/equal.ts";
import { waitForZoneAction } from "./actions.ts";
import {
  alchemyLabelKeys,
  alchemyStackSelector,
  createInternalLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export type ZoneMode = "primary" | "secondary";
export type ZoneStatus = "ok" | "updating" | "error";
export type ZoneRegistrar = "hetzner" | "other" | "unknown";
export type ZoneDelegationStatus =
  | "valid"
  | "partially-valid"
  | "invalid"
  | "lame"
  | "unregistered"
  | "unknown"
  | (string & {});

export interface ZoneProps {
  /**
   * Apex domain of the zone (e.g. `example.com`). Must be lowercase, must
   * not end with a dot, and must use a well-known public suffix. Subdomains
   * are not supported. Changing this replaces the zone.
   *
   * If omitted, a unique `*.com` name is generated from the stack, stage,
   * and logical ID.
   */
  name?: string;
  /**
   * Zone mode. Primary zones are edited via the Cloud API (RRSets);
   * secondary zones are transferred from primary nameservers via AXFR.
   * Cannot be changed after creation — triggers a replacement.
   *
   * @default "primary"
   */
  mode?: ZoneMode;
  /**
   * Default TTL in seconds for RRSets that do not set their own TTL.
   * Must be between 60 and 2147483647. Omit to keep Hetzner's default on
   * create and leave the live value alone on update.
   */
  ttl?: number;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
  /**
   * Prevent the zone from being deleted via the API.
   *
   * @default false
   */
  deleteProtection?: boolean;
}

export interface ZoneAttributes {
  /** Numeric Cloud API id of the zone. Stable across updates. */
  zoneId: number;
  /** Apex domain name. */
  name: string;
  /** Zone mode (`primary` or `secondary`). */
  mode: ZoneMode;
  /** Default TTL in seconds. */
  ttl: number;
  /** User-defined labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Whether delete protection is enabled. */
  deleteProtection: boolean;
  /** Live zone status. */
  status: ZoneStatus;
  /** Number of resource records in the zone. */
  recordCount: number;
  /** Domain registrar as reported by Hetzner. */
  registrar: ZoneRegistrar;
  /** RFC3339 creation timestamp. */
  created: string;
  /** Authoritative Hetzner nameservers assigned to this zone. */
  assignedNameservers: string[];
  /** Nameservers currently delegated by the parent DNS zone. */
  delegatedNameservers: string[];
  /** Delegation check status, when Hetzner has reported one. */
  delegationStatus: ZoneDelegationStatus | undefined;
}

export type Zone = Resource<
  "Hetzner.Zone",
  ZoneProps,
  ZoneAttributes,
  never,
  Providers
>;

/**
 * A Hetzner Cloud DNS zone — an apex domain hosted on Hetzner's
 * authoritative nameservers.
 *
 * The zone `name` is the identity: changing it replaces the zone. Default
 * TTL, labels, and delete protection update in place. Resource record sets
 * are a separate resource (`RecordSet`).
 * @see https://docs.hetzner.cloud/reference/cloud#zones
 *
 * ### Creating a Zone
 * **Example:** Primary zone with a default TTL
 * ```typescript
 * const zone = yield* Hetzner.Zone("example", {
 *   name: "example.com",
 *   ttl: 3600,
 * });
 * ```
 *
 * **Example:** Zone with labels and delete protection
 * ```typescript
 * const zone = yield* Hetzner.Zone("example", {
 *   name: "example.com",
 *   labels: { env: "prod" },
 *   deleteProtection: true,
 * });
 * ```
 *
 * @resource
 */
export const Zone = Resource<Zone>("Hetzner.Zone");

type CloudZone = ZonePrimary | ZoneSecondary;

const DEFAULT_MODE: ZoneMode = "primary";

const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/\.$/, "");

const generateZoneName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 63 }).pipe(
    Effect.map((physical) => `${physical}.com`),
  );

const resolveZoneName = (
  id: string,
  news: Pick<ZoneProps, "name">,
  output: Pick<ZoneAttributes, "name"> | undefined,
) =>
  Effect.gen(function* () {
    if (news.name !== undefined) {
      return normalizeName(news.name);
    }
    if (output?.name !== undefined) {
      return output.name;
    }
    return yield* generateZoneName(id);
  });

const desiredLabels = Effect.fn(function* (
  id: string,
  user: Record<string, string> | undefined,
) {
  return {
    ...toLabels(user),
    ...(yield* createInternalLabels(id)),
  };
});

const toAttrs = (zone: CloudZone): ZoneAttributes => ({
  zoneId: zone.id,
  name: zone.name,
  mode: zone.mode,
  ttl: zone.ttl,
  labels: stripInternalLabels(tagRecord(zone.labels)),
  deleteProtection: zone.protection.delete,
  status: zone.status,
  recordCount: zone.record_count,
  registrar: zone.registrar,
  created: zone.created,
  assignedNameservers: zone.authoritative_nameservers.assigned,
  delegatedNameservers: zone.authoritative_nameservers.delegated,
  delegationStatus: zone.authoritative_nameservers.delegation_status,
});

const getZoneBy = (idOrName: string) =>
  Services.zones.getZone({ id_or_name: idOrName }).pipe(
    Effect.map(({ zone }) => zone),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

class ZoneStillExists extends Data.TaggedError("ZoneStillExists")<{
  idOrName: string;
}> {}

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const retryLocked = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Locked",
      times: 8,
      schedule: backoff,
    }),
  );

export const ZoneProvider = () =>
  Provider.succeed(Zone, {
    stables: ["zoneId", "name", "mode"],
    list: Effect.fn(function* () {
      const zones = yield* Services.zones.listZones
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(Stream.runCollect);
      return [...zones].map(toAttrs);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.name !== undefined && normalizeName(news.name) !== output.name) {
        return { action: "replace" } as const;
      }
      if ((news.mode ?? DEFAULT_MODE) !== output.mode) {
        return { action: "replace" } as const;
      }
      const desiredProtection = news.deleteProtection ?? false;
      const labelsChanged = !recordsEqual(news.labels ?? {}, output.labels);
      const ttlChanged = news.ttl !== undefined && news.ttl !== output.ttl;
      if (
        ttlChanged ||
        labelsChanged ||
        desiredProtection !== output.deleteProtection
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      let zone: CloudZone | undefined;
      if (output?.zoneId !== undefined) {
        zone = yield* getZoneBy(String(output.zoneId));
      }
      if (zone === undefined) {
        const name = output?.name ?? olds?.name;
        if (name !== undefined) {
          zone = yield* getZoneBy(normalizeName(name));
        }
      }
      if (zone === undefined) {
        const expected = yield* createInternalLabels(id);
        const selector = labelSelector(expected);
        if (selector.length > 0) {
          zone = yield* Services.zones.listZones
            .items({
              label_selector: selector,
              per_page: 50,
            })
            .pipe(
              Stream.take(1),
              Stream.runHead,
              Effect.map((option) =>
                option._tag === "Some" ? option.value : undefined,
              ),
            );
        }
      }
      if (zone === undefined) return undefined;
      const attrs = toAttrs(zone);
      return (yield* hasAlchemyLabels(id, tagRecord(zone.labels)))
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* resolveZoneName(id, news, output);
      const mode = news.mode ?? output?.mode ?? DEFAULT_MODE;
      const idOrName =
        output?.zoneId !== undefined ? String(output.zoneId) : name;

      // 1. Observe
      let current = yield* getZoneBy(idOrName);
      if (current === undefined && output?.zoneId !== undefined) {
        current = yield* getZoneBy(name);
      }

      // 2. Ensure
      if (current === undefined) {
        const labels = yield* desiredLabels(id, news.labels);
        const created = yield* retryLocked(
          Services.zones
            .createZone({
              name,
              mode,
              ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
              labels,
            })
            .pipe(
              Effect.catchTag("Conflict", () =>
                Services.zones
                  .getZone({ id_or_name: name })
                  .pipe(
                    Effect.map(({ zone }) => ({ zone, action: undefined })),
                  ),
              ),
            ),
        );
        if (created.action !== undefined) {
          yield* waitForZoneAction(created.action);
        }
        current =
          created.action === undefined
            ? created.zone
            : ((yield* getZoneBy(name)) ?? created.zone);
      }

      const zoneRef = String(current.id);

      // 3. Sync — labels (PUT overwrites the full set)
      const labels = yield* desiredLabels(id, news.labels);
      const observedLabels = tagRecord(current.labels);
      if (!recordsEqual(observedLabels, labels)) {
        const updated = yield* retryLocked(
          Services.zones.updateZone({
            id_or_name: zoneRef,
            labels,
          }),
        );
        current = updated.zone;
      }

      // Sync — default TTL (primary zones only; secondary ignores it)
      if (
        news.ttl !== undefined &&
        news.ttl !== current.ttl &&
        current.mode === "primary"
      ) {
        const { action } = yield* retryLocked(
          Services.zoneActions.changeZoneTtl({
            id_or_name: zoneRef,
            ttl: news.ttl,
          }),
        );
        yield* waitForZoneAction(action);
        current = (yield* getZoneBy(zoneRef)) ?? current;
      }

      // Sync — delete protection
      const desiredProtection = news.deleteProtection ?? false;
      if (current.protection.delete !== desiredProtection) {
        const { action } = yield* retryLocked(
          Services.zoneActions.changeZoneProtection({
            id_or_name: zoneRef,
            delete: desiredProtection,
          }),
        );
        yield* waitForZoneAction(action);
        current = (yield* getZoneBy(zoneRef)) ?? current;
      }

      return toAttrs(current);
    }),
    delete: Effect.fn(function* ({ output }) {
      const idOrName = String(output.zoneId);
      const current = yield* getZoneBy(idOrName);
      if (current === undefined) return;

      if (current.protection.delete) {
        const { action } = yield* retryLocked(
          Services.zoneActions.changeZoneProtection({
            id_or_name: idOrName,
            delete: false,
          }),
        );
        yield* waitForZoneAction(action);
      }

      const deleted = yield* retryLocked(
        Services.zones
          .deleteZone({ id_or_name: idOrName })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (deleted !== undefined) {
        yield* waitForZoneAction(deleted.action);
      }

      yield* getZoneBy(idOrName).pipe(
        Effect.flatMap((zone) =>
          zone === undefined ? Effect.void : new ZoneStillExists({ idOrName }),
        ),
        Effect.retry({
          while: (e) => e._tag === "ZoneStillExists",
          times: 8,
          schedule: backoff,
        }),
        Effect.catchTag("ZoneStillExists", () => Effect.void),
      );
    }),
  });
