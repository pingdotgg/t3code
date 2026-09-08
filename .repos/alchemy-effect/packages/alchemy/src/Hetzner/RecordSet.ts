import { Services } from "@distilled.cloud/hetzner";
import type {
  CreateZoneRrsetRequestRecordsItem,
  GetZoneRrsetResponseRrset,
  ListZoneRrsetsResponseRrsetsItem,
} from "@distilled.cloud/hetzner/zone_rrsets";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { recordsEqual as labelsEqual } from "../Util/equal.ts";
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

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Zone(...)` and `Zone(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Zone identity an RRSet belongs to. A `Hetzner.Zone` resource satisfies
 * this via `zoneId`.
 */
export type RecordSetZone = {
  readonly zoneId: number;
};

export type RecordSetType =
  | "A"
  | "AAAA"
  | "CAA"
  | "CNAME"
  | "DS"
  | "HINFO"
  | "HTTPS"
  | "MX"
  | "NS"
  | "PTR"
  | "RP"
  | "SOA"
  | "SRV"
  | "SVCB"
  | "TLSA"
  | "TXT"
  | (string & {});

export interface RecordSetRecord {
  /**
   * Record value. Interpretation depends on `type` — an A record is an
   * IPv4 address, AAAA an IPv6 address, CNAME a hostname, etc. Must be
   * unique within the RRSet. Accepts a primitive Output (e.g. a Primary
   * IP's `ip`).
   */
  value: string;
  /**
   * Optional comment shown in the Hetzner Cloud Console. Does not affect
   * DNS responses.
   */
  comment?: string;
}

export interface RecordSetProps {
  /**
   * Zone this RRSet lives in. Accepts a `Hetzner.Zone` or `{ zoneId }`.
   * Changing the zone replaces the RRSet.
   */
  zone: Ref<RecordSetZone>;
  /**
   * DNS name of the RRSet, relative to the zone. Lowercase, must not end
   * with a dot or the zone apex. Use `@` for the zone apex. Changing this
   * replaces the RRSet.
   *
   * If omitted, a unique label is generated from the stack, stage, and
   * logical ID.
   */
  name?: string;
  /**
   * DNS record type. All `records` share this type — two A values are one
   * RRSet, not two resources. Changing this replaces the RRSet.
   */
  type: RecordSetType;
  /**
   * Records in this RRSet. Must be non-empty and contain distinct values.
   * Order is not significant. Mutable — updates in place.
   */
  records: RecordSetRecord[];
  /**
   * TTL in seconds (`60`–`2147483647`). Omit to use the Zone's default TTL
   * on create and leave the live value alone on update.
   */
  ttl?: number;
  /**
   * User-defined labels. Alchemy ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
  /**
   * Prevent the RRSet from being changed or deleted via the API.
   *
   * @default false
   */
  changeProtection?: boolean;
}

export interface RecordSetAttributes {
  /**
   * RRSet id (`{name}/{type}`, e.g. `www/A`). Stable across updates.
   */
  id: string;
  /**
   * Numeric Cloud API id of the parent Zone.
   */
  zoneId: number;
  /**
   * DNS name of the RRSet (`@` for the apex).
   */
  name: string;
  /**
   * DNS record type.
   */
  type: RecordSetType;
  /**
   * TTL in seconds, or `undefined` when the Zone default applies.
   */
  ttl: number | undefined;
  /**
   * Records currently published. Order is not significant.
   */
  records: RecordSetRecord[];
  /**
   * User-defined labels (Alchemy ownership labels stripped).
   */
  labels: Record<string, string>;
  /**
   * Whether change protection is enabled.
   */
  changeProtection: boolean;
}

export type RecordSet = Resource<
  "Hetzner.RecordSet",
  RecordSetProps,
  RecordSetAttributes,
  never,
  Providers
>;

/**
 * A Hetzner Cloud DNS resource record set (RRSet) — one `(name, type)`
 * with one or more records. Two A values are a single resource, not two.
 *
 * Identity is `(zone, name, type)`: changing any of those replaces the
 * RRSet. Records, TTL, labels, and change protection update in place.
 * Only primary Zones accept RRSet edits.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#zone-rrsets
 *
 * ### Creating an RRSet
 * **Example:** A records on a subdomain
 * ```typescript
 * const zone = yield* Hetzner.Zone("example", {
 *   name: "example.com",
 * });
 * const www = yield* Hetzner.RecordSet("www", {
 *   zone,
 *   name: "www",
 *   type: "A",
 *   records: [
 *     { value: "192.0.2.1" },
 *     { value: "192.0.2.2" },
 *   ],
 *   ttl: 300,
 * });
 * ```
 *
 * **Example:** Apex A record from a Primary IP
 * ```typescript
 * const ip = yield* Hetzner.PrimaryIp("web-ip", {
 *   type: "ipv4",
 *   location: "nbg1",
 * });
 * const apex = yield* Hetzner.RecordSet("apex", {
 *   zone,
 *   name: "@",
 *   type: "A",
 *   records: [{ value: ip.ip }],
 * });
 * ```
 *
 * ### Updating records
 * **Example:** Replace the record set and TTL
 * ```typescript
 * const www = yield* Hetzner.RecordSet("www", {
 *   zone,
 *   name: "www",
 *   type: "A",
 *   records: [{ value: "192.0.2.10" }],
 *   ttl: 600,
 * });
 * ```
 *
 * @resource
 */
export const RecordSet = Resource<RecordSet>("Hetzner.RecordSet");

export class RecordSetZoneMissing extends Data.TaggedError(
  "Hetzner.RecordSetZoneMissing",
)<{
  name: string;
  type: string;
}> {}

class RecordSetStillExists extends Data.TaggedError("RecordSetStillExists")<{
  zoneId: number;
  name: string;
  type: string;
}> {}

type CloudRrset = GetZoneRrsetResponseRrset | ListZoneRrsetsResponseRrsetsItem;

const NAME_MAX_LENGTH = 63;

const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/\.$/, "");

const normalizeType = (type: string): RecordSetType =>
  type.toUpperCase() as RecordSetType;

const compactRecord = (record: {
  value: string;
  comment?: string | null;
}): RecordSetRecord => {
  const comment = record.comment ?? undefined;
  return comment !== undefined && comment.length > 0
    ? { value: record.value, comment }
    : { value: record.value };
};

const sortRecords = (
  records: ReadonlyArray<RecordSetRecord>,
): RecordSetRecord[] =>
  [...records]
    .map(compactRecord)
    .sort((a, b) => a.value.localeCompare(b.value));

const recordsEqual = (
  a: ReadonlyArray<RecordSetRecord>,
  b: ReadonlyArray<RecordSetRecord>,
): boolean => deepEqual(sortRecords(a), sortRecords(b), { stripNullish: true });

const toWireRecords = (
  records: ReadonlyArray<RecordSetRecord>,
): CreateZoneRrsetRequestRecordsItem[] =>
  records.map((record) =>
    record.comment !== undefined
      ? { value: record.value, comment: record.comment }
      : { value: record.value },
  );

const zoneIdOf = (value: unknown): number | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { zoneId?: unknown; id?: unknown };
  if (typeof rec.zoneId === "number") return rec.zoneId;
  if (typeof rec.id === "number") return rec.id;
  return undefined;
};

const resolveName = (
  id: string,
  news: Pick<RecordSetProps, "name">,
  output: Pick<RecordSetAttributes, "name"> | undefined,
) =>
  Effect.gen(function* () {
    if (news.name !== undefined) {
      return normalizeName(news.name);
    }
    if (output?.name !== undefined) {
      return output.name;
    }
    return yield* createPhysicalName({
      id,
      lowercase: true,
      maxLength: NAME_MAX_LENGTH,
    });
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

const toAttrs = (rrset: CloudRrset): RecordSetAttributes => ({
  id: rrset.id,
  zoneId: rrset.zone,
  name: rrset.name,
  type: rrset.type,
  ttl: rrset.ttl ?? undefined,
  records: sortRecords(rrset.records.map(compactRecord)),
  labels: stripInternalLabels(tagRecord(rrset.labels)),
  changeProtection: rrset.protection.change,
});

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

const getRrset = (zoneId: number, name: string, type: string) =>
  Services.zoneRrsets
    .getZoneRrset({
      id_or_name: String(zoneId),
      rr_name: name,
      rr_type: type,
    })
    .pipe(
      Effect.map(({ rrset }) => rrset),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const findByLabels = (zoneId: number, id: string) =>
  Effect.gen(function* () {
    const selector = labelSelector(yield* createInternalLabels(id));
    if (selector.length === 0) return undefined;
    return yield* Services.zoneRrsets.listZoneRrsets
      .items({
        id_or_name: String(zoneId),
        label_selector: selector,
        per_page: 100,
      })
      .pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.map((option) =>
          option._tag === "Some" ? option.value : undefined,
        ),
      );
  });

export const RecordSetProvider = () =>
  Provider.succeed(RecordSet, {
    stables: ["id", "zoneId", "name", "type"],
    nuke: { dependsOn: ["Hetzner.Zone"] },
    list: Effect.fn(function* () {
      const zones = yield* Services.zones.listZones
        .items({ per_page: 50 })
        .pipe(Stream.runCollect);
      const rows = yield* Effect.forEach(
        [...zones],
        (zone) =>
          Services.zoneRrsets.listZoneRrsets
            .items({
              id_or_name: String(zone.id),
              label_selector: alchemyStackSelector,
              per_page: 100,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => [...chunk].map(toAttrs)),
              Effect.catchTag(
                ["NotFound", "BadRequest", "UnprocessableEntity"],
                () => Effect.succeed([] as RecordSetAttributes[]),
              ),
            ),
        { concurrency: 5 },
      );
      return rows.flat();
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      const zoneId = zoneIdOf(news.zone);
      if (zoneId !== undefined && zoneId !== output.zoneId) {
        return { action: "replace" } as const;
      }
      if (news.name !== undefined && normalizeName(news.name) !== output.name) {
        return { action: "replace" } as const;
      }
      if (normalizeType(news.type) !== output.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const zoneId = output?.zoneId ?? zoneIdOf(olds?.zone);
      const name =
        output?.name ??
        (olds?.name !== undefined ? normalizeName(olds.name) : undefined);
      const type =
        output?.type ??
        (olds?.type !== undefined ? normalizeType(olds.type) : undefined);

      let current: CloudRrset | undefined;
      if (zoneId !== undefined && name !== undefined && type !== undefined) {
        current = yield* getRrset(zoneId, name, type);
      }
      if (current === undefined && zoneId !== undefined) {
        current = yield* findByLabels(zoneId, id);
      }
      if (current === undefined) return undefined;
      const attrs = toAttrs(current);
      return (yield* hasAlchemyLabels(id, tagRecord(current.labels)))
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const zoneId = zoneIdOf(news.zone) ?? output?.zoneId;
      const name = yield* resolveName(id, news, output);
      const type = normalizeType(news.type);
      if (zoneId === undefined) {
        return yield* new RecordSetZoneMissing({ name, type });
      }

      const desiredRecords = sortRecords(news.records);
      const labels = yield* desiredLabels(id, news.labels);
      const desiredProtection = news.changeProtection ?? false;

      // 1. Observe
      let current =
        output !== undefined &&
        output.zoneId === zoneId &&
        output.name === name &&
        output.type === type
          ? yield* getRrset(output.zoneId, output.name, output.type)
          : yield* getRrset(zoneId, name, type);

      // 2. Ensure
      if (current === undefined) {
        const created = yield* retryLocked(
          Services.zoneRrsets
            .createZoneRrset({
              id_or_name: String(zoneId),
              name,
              type,
              records: toWireRecords(desiredRecords),
              labels,
              ...(news.ttl !== undefined ? { ttl: news.ttl } : {}),
            })
            .pipe(
              Effect.catchTag("Conflict", () =>
                getRrset(zoneId, name, type).pipe(
                  Effect.map((rrset) =>
                    rrset !== undefined
                      ? { rrset, action: undefined }
                      : undefined,
                  ),
                ),
              ),
            ),
        );
        if (created === undefined) {
          current = yield* getRrset(zoneId, name, type);
        } else {
          if (created.action !== undefined) {
            yield* waitForZoneAction(created.action.id);
          }
          current = (yield* getRrset(zoneId, name, type)) ?? created.rrset;
        }
      }

      if (current === undefined) {
        return yield* new RecordSetZoneMissing({ name, type });
      }

      const zoneRef = String(zoneId);

      // 3. Sync — labels (PUT overwrites the full set)
      const observedLabels = tagRecord(current.labels);
      if (!labelsEqual(observedLabels, labels)) {
        const updated = yield* retryLocked(
          Services.zoneRrsets.updateZoneRrset({
            id_or_name: zoneRef,
            rr_name: name,
            rr_type: type,
            labels,
          }),
        );
        current = updated.rrset;
      }

      // Sync — TTL
      if (news.ttl !== undefined && news.ttl !== (current.ttl ?? undefined)) {
        const { action } = yield* retryLocked(
          Services.zoneRrsetActions.changeZoneRrsetTtl({
            id_or_name: zoneRef,
            rr_name: name,
            rr_type: type,
            ttl: news.ttl,
          }),
        );
        yield* waitForZoneAction(action.id);
        current = (yield* getRrset(zoneId, name, type)) ?? current;
      }

      // Sync — records (order-insensitive; value identifies a record)
      if (!recordsEqual(current.records.map(compactRecord), desiredRecords)) {
        const { action } = yield* retryLocked(
          Services.zoneRrsetActions.setZoneRrsetRecords({
            id_or_name: zoneRef,
            rr_name: name,
            rr_type: type,
            records: toWireRecords(desiredRecords),
          }),
        );
        yield* waitForZoneAction(action.id);
        current = (yield* getRrset(zoneId, name, type)) ?? current;
      }

      // Sync — change protection
      if (current.protection.change !== desiredProtection) {
        const { action } = yield* retryLocked(
          Services.zoneRrsetActions.changeZoneRrsetProtection({
            id_or_name: zoneRef,
            rr_name: name,
            rr_type: type,
            change: desiredProtection,
          }),
        );
        yield* waitForZoneAction(action.id);
        current = (yield* getRrset(zoneId, name, type)) ?? current;
      }

      return toAttrs(current);
    }),
    delete: Effect.fn(function* ({ output }) {
      const zoneId = output.zoneId;
      const name = output.name;
      const type = output.type;
      const current = yield* getRrset(zoneId, name, type);
      if (current === undefined) return;

      if (current.protection.change) {
        const { action } = yield* retryLocked(
          Services.zoneRrsetActions.changeZoneRrsetProtection({
            id_or_name: String(zoneId),
            rr_name: name,
            rr_type: type,
            change: false,
          }),
        );
        yield* waitForZoneAction(action.id);
      }

      const deleted = yield* retryLocked(
        Services.zoneRrsets
          .deleteZoneRrset({
            id_or_name: String(zoneId),
            rr_name: name,
            rr_type: type,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (deleted !== undefined) {
        yield* waitForZoneAction(deleted.action.id);
      }

      yield* getRrset(zoneId, name, type).pipe(
        Effect.flatMap((rrset) =>
          rrset === undefined
            ? Effect.void
            : new RecordSetStillExists({ zoneId, name, type }),
        ),
        Effect.retry({
          while: (e) => e._tag === "RecordSetStillExists",
          times: 8,
          schedule: backoff,
        }),
        Effect.catchTag("RecordSetStillExists", () => Effect.void),
      );
    }),
  });
