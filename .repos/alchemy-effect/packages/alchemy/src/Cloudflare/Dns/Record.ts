import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

/**
 * DNS record type literal — every value Cloudflare recognises. Stable
 * across reconciles; changing it triggers a replacement because record
 * type is part of a record's identity.
 */
export type RecordType =
  | "A"
  | "AAAA"
  | "CNAME"
  | "MX"
  | "NS"
  | "OPENPGPKEY"
  | "PTR"
  | "TXT"
  | "CAA"
  | "CERT"
  | "DNSKEY"
  | "DS"
  | "HTTPS"
  | "LOC"
  | "NAPTR"
  | "SMIMEA"
  | "SRV"
  | "SSHFP"
  | "SVCB"
  | "TLSA"
  | "URI"
  | (string & {});

export interface RecordProps {
  /**
   * Zone the record lives in. Stable — changing the zone triggers
   * replacement.
   */
  zoneId: string;
  /**
   * Fully-qualified record name (e.g. `cluster-admin.microtrack.ai`).
   *
   * Stable — Cloudflare treats `(name, type)` as the record's identity,
   * so a rename is a delete + create. Declared as plain `string` (not
   * `string`) so it is statically knowable inside `diff`.
   */
  name: string;
  /**
   * Record type. Stable — changing triggers replacement.
   *
   * Declared as plain `string` (narrowed to {@link RecordType}) so
   * `diff` can compare without resolving an `Input`.
   */
  type: RecordType;
  /**
   * Record value. Interpretation depends on `type` — an A record's
   * content is an IPv4, a CNAME's is a target hostname, etc.
   *
   * Mutable — patched in place.
   */
  content: string;
  /**
   * TTL in seconds (`60`–`86400`), or `"1"` for Cloudflare's "automatic"
   * setting. Must be `"1"` when `proxied` is `true`.
   *
   * @default "1"
   */
  ttl?: number | "1";
  /**
   * Whether to send the record through Cloudflare's proxy (orange-clouded
   * in the dashboard). Only valid for proxiable record types
   * (`A`, `AAAA`, `CNAME`).
   *
   * @default false
   */
  proxied?: boolean;
  /**
   * Free-form comment shown in the dashboard. No effect on DNS responses.
   */
  comment?: string;
  /**
   * Custom tags shown in the dashboard. No effect on DNS responses.
   */
  tags?: ReadonlyArray<string>;
  /**
   * Priority — required for `MX` and `URI` records, ignored for others.
   */
  priority?: number;
}

export interface RecordAttributes {
  /** Cloudflare-assigned DNS record UUID. */
  recordId: string;
  /** Zone that owns this record. */
  zoneId: string;
  /** Record name (FQDN, as Cloudflare returns it). */
  name: string;
  /** Record type. */
  type: RecordType;
  /** Resolved record value. */
  content: string;
  /** Resolved TTL (Cloudflare echoes `1` for "automatic"). */
  ttl: number;
  /** Whether the record is proxied. */
  proxied: boolean;
  /** ISO8601 creation timestamp. */
  createdOn: string | undefined;
  /** ISO8601 last-modified timestamp. */
  modifiedOn: string | undefined;
}

export type Record = Resource<
  "Cloudflare.DNS.Record",
  RecordProps,
  RecordAttributes,
  never,
  Providers
>;

/**
 * A single DNS record on a Cloudflare-managed zone.
 *
 * Safety: when there is no prior state, `read` scans the zone for an
 * existing `(name, type)` match. DNS records carry no ownership markers
 * we can inspect, so an existing match is reported as `Unowned` and the
 * engine refuses to take it over unless `--adopt` (or `adopt(true)`) is
 * set. This protects hand-edited records (especially the apex `A`/`AAAA`
 * and email DKIM/SPF records that the dashboard often manages) from
 * being clobbered.
 * @resource
 * @product DNS
 * @category Domains & DNS
 * @section Proxied CNAME pointing at a tunnel
 * @example Route a subdomain through a Cloudflare Tunnel
 * ```typescript
 * yield* Cloudflare.DNS.Record("AdminCname", {
 *   zoneId: zone.zoneId,
 *   name: "cluster-admin.example.com",
 *   type: "CNAME",
 *   content: `${tunnel.tunnelId}.cfargotunnel.com`,
 *   proxied: true,
 *   comment: "research admin UI",
 * });
 * ```
 *
 * @section Plain A record
 * @example Direct A record (not proxied)
 * ```typescript
 * yield* Cloudflare.DNS.Record("ApiA", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   type: "A",
 *   content: "203.0.113.42",
 *   ttl: 300,
 * });
 * ```
 */
export const Record = Resource<Record>("Cloudflare.DNS.Record", {
  aliases: ["Cloudflare.Dns.Record"],
});

export const RecordProvider = () =>
  Provider.succeed(Record, {
    stables: ["recordId", "zoneId", "type", "name"],

    // Zone-scoped collection: DNS records live under `/zones/{id}/dns_records`
    // with no account-wide enumeration API. Fan out over every zone in the
    // account, exhaustively paginate each zone's records, and hydrate each into
    // the same `Attributes` shape `read` produces. A fresh scoped token can 403
    // a zone (eventual consistency) or a zone may be partially provisioned —
    // skip those zones (-> []) rather than failing the whole enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          dns.listRecords.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).flatMap((r) => {
                  const attrs = toAttributes(
                    narrowRecord(r as Parameters<typeof narrowRecord>[0]),
                    zone.id,
                  );
                  return attrs ? [attrs] : [];
                }),
              ),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed([] as RecordAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ olds = {}, news }) {
      const o = olds as RecordProps;
      const n = news as RecordProps;
      if (o.type !== undefined && o.type !== n.type) {
        return { action: "replace" } as const;
      }
      if (o.name !== undefined && o.name !== n.name) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; by reconcile time both sides are
      // concrete strings.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const content = news.content as string;
      const body = buildMutableBody(news, content);

      // 1. Observe by cached id first.
      let observed: ObservedRecord | undefined;
      if (output?.recordId) {
        observed = yield* observeById(zoneId, output.recordId);
      }

      // 2. Fall back to scanning the zone for a (name, type) match.
      //    Ownership has already been verified upstream — `read` reports
      //    existing records as `Unowned` and the engine gates takeover
      //    behind the adopt policy before reconcile ever runs.
      let foundByScan = false;
      if (!observed) {
        const existing = yield* findByNameType(zoneId, news.name, news.type);
        if (existing) {
          foundByScan = true;
          observed = existing;
        }
      }

      // 3. Ensure.
      if (!observed) {
        const created = yield* dns
          .createRecord({
            zoneId,
            name: body.name,
            type: body.type,
            content: body.content,
            ttl: body.ttl,
            proxied: body.proxied,
            comment: body.comment,
            tags: body.tags === undefined ? undefined : Array.from(body.tags),
            priority: body.priority,
          })
          .pipe(
            Effect.map(
              (r) =>
                ({
                  record: narrowRecord(r as Parameters<typeof narrowRecord>[0]),
                  raced: false,
                }) as const,
            ),
            // A record with this `(name, type)` can already exist that the
            // scan above missed — a leftover from an interrupted run, or a
            // concurrent reconcile that won the create race. Cloudflare
            // answers `An identical record already exists.`
            // (`DnsRecordAlreadyExists`). Self-heal: re-scan and adopt the
            // existing record instead of failing the deploy. Ownership was
            // already gated by `read`/the adopt policy upstream.
            Effect.catchTag("DnsRecordAlreadyExists", () =>
              findByNameType(zoneId, news.name, news.type).pipe(
                Effect.flatMap((existing) =>
                  existing
                    ? Effect.succeed({ record: existing, raced: true } as const)
                    : Effect.fail(
                        new Error(
                          `Cloudflare reported an identical DNS record for ` +
                            `(${news.name}, ${news.type}) but it could not be found`,
                        ),
                      ),
                ),
              ),
            ),
          );
        observed = created.record;
        // A raced/adopted record is treated like a scanned-existing one so
        // the sync step converges its mutable fields; a genuine fresh create
        // keeps `foundByScan` false so the no-op first-reconcile suppression
        // below still applies.
        if (created.raced) foundByScan = true;
      }

      // 4. Sync — Cloudflare's update endpoint is PUT-style; resend
      //    the full desired body when any mutable field differs.
      if (!observed.id) {
        return yield* Effect.fail(
          new Error("Cloudflare did not return a record id for DNS record"),
        );
      }
      if (!bodyEqualsObserved(body, observed)) {
        // Suppress noise when we just created the record above — the
        // server echo already matches and any diff is a CF-side
        // normalisation we shouldn't fight on the very first reconcile.
        const justCreated = !output?.recordId && !foundByScan;
        if (!justCreated) {
          const updated = yield* dns.updateRecord({
            zoneId,
            dnsRecordId: observed.id,
            name: body.name,
            type: body.type,
            content: body.content,
            ttl: body.ttl,
            proxied: body.proxied,
            comment: body.comment,
            tags: body.tags === undefined ? undefined : Array.from(body.tags),
            priority: body.priority,
          });
          observed = narrowRecord(
            updated as Parameters<typeof narrowRecord>[0],
          );
        }
      }

      // 5. Return.
      if (
        !observed.id ||
        !observed.type ||
        observed.content === undefined ||
        observed.ttl === undefined
      ) {
        return yield* Effect.fail(
          new Error(
            "Cloudflare returned a DNS record without id/type/content/ttl",
          ),
        );
      }
      return {
        recordId: observed.id,
        zoneId,
        name: observed.name ?? body.name,
        type: observed.type,
        content: observed.content,
        ttl: observed.ttl,
        proxied: observed.proxied ?? false,
        createdOn: observed.createdOn,
        modifiedOn: observed.modifiedOn,
      } satisfies RecordAttributes;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteRecord({
          zoneId: output.zoneId,
          dnsRecordId: output.recordId,
        })
        .pipe(Effect.catch(() => Effect.void));
    }),

    read: Effect.fn(function* ({ output, olds }) {
      // Owned path: we have persisted state (our own recordId) — refresh it.
      if (output?.recordId) {
        const observed = yield* observeById(output.zoneId, output.recordId);
        const attrs = toAttributes(observed, output.zoneId);
        if (attrs) return attrs;
      }
      // Adoption path: no state of our own, but a record with this
      // `(zoneId, name, type)` may already exist. DNS records carry no
      // ownership markers we can inspect, so we cannot prove we created
      // it — brand it `Unowned` so the engine refuses to take over
      // unless `adopt` is set.
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      const name = output?.name ?? olds?.name;
      const type = output?.type ?? olds?.type;
      if (zoneId && name && type) {
        const observed = yield* findByNameType(zoneId, name, type);
        const attrs = toAttributes(observed, zoneId);
        if (attrs) return Unowned(attrs);
      }
      return undefined;
    }),
  });

const observeById = (zoneId: string, dnsRecordId: string) =>
  Effect.gen(function* () {
    const r = yield* dns.getRecord({ zoneId, dnsRecordId }).pipe(
      // Distilled tags transport errors but a 404 for a missing
      // record surfaces as an untagged error. Swallow so the
      // reconciler falls through to the find-by-name path.
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (r === undefined) return undefined;
    return narrowRecord(r as Parameters<typeof narrowRecord>[0]);
  });

// Locate an existing record by `(zoneId, name, type)`. Used both
// for the adoption path and to surface a conflict when the caller
// hasn't opted into adoption.
const findByNameType = (zoneId: string, name: string, type: RecordType) =>
  dns.listRecords
    .items({
      zoneId,
      name: { exact: name },
      type: type as dns.ListRecordsRequest["type"],
    })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).find((r) => r.name === name && r.type === type),
      ),
      Effect.map((found) =>
        found === undefined
          ? undefined
          : narrowRecord(found as Parameters<typeof narrowRecord>[0]),
      ),
    );

interface ObservedRecord {
  readonly id?: string;
  readonly name?: string;
  readonly type?: RecordType;
  readonly content?: string;
  readonly ttl?: number;
  readonly proxied?: boolean;
  readonly comment?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly priority?: number;
  readonly createdOn?: string;
  readonly modifiedOn?: string;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const narrowRecord = (raw: {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  content?: string | null;
  ttl?: number | null;
  proxied?: boolean | null;
  comment?: string | null;
  tags?: ReadonlyArray<string> | null;
  priority?: number | null;
  createdOn?: string | null;
  modifiedOn?: string | null;
}): ObservedRecord => ({
  id: undef(raw.id),
  name: undef(raw.name),
  type: raw.type == null ? undefined : (raw.type as RecordType),
  content: undef(raw.content),
  ttl: undef(raw.ttl),
  proxied: undef(raw.proxied),
  comment: undef(raw.comment),
  tags: raw.tags == null ? undefined : (raw.tags as ReadonlyArray<string>),
  priority: undef(raw.priority),
  createdOn: undef(raw.createdOn),
  modifiedOn: undef(raw.modifiedOn),
});

const toAttributes = (
  observed: ObservedRecord | undefined,
  zoneId: string,
): RecordAttributes | undefined => {
  if (
    !observed?.id ||
    !observed.name ||
    !observed.type ||
    observed.content === undefined ||
    observed.ttl === undefined
  ) {
    return undefined;
  }
  return {
    recordId: observed.id,
    zoneId,
    name: observed.name,
    type: observed.type,
    content: observed.content,
    ttl: observed.ttl,
    proxied: observed.proxied ?? false,
    createdOn: observed.createdOn,
    modifiedOn: observed.modifiedOn,
  };
};

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

interface RecordMutableBody {
  name: string;
  type: RecordType;
  content: string;
  ttl: number;
  proxied?: boolean;
  comment?: string;
  tags?: ReadonlyArray<string>;
  priority?: number;
}

const buildMutableBody = (
  news: RecordProps,
  resolvedContent: string,
): RecordMutableBody => ({
  name: news.name,
  type: news.type,
  content: resolvedContent,
  // Cloudflare rejects the string `"1"` even though distilled types
  // it as `number | "1"`; the API wants numeric 1 for "automatic".
  ttl:
    news.ttl === undefined
      ? 1
      : news.ttl === ("1" as unknown)
        ? 1
        : (news.ttl as number),
  proxied: news.proxied,
  comment: news.comment,
  tags: news.tags,
  priority: news.priority,
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

const bodyEqualsObserved = (
  desired: RecordMutableBody,
  observed: ObservedRecord,
): boolean => {
  if (desired.content !== observed.content) return false;
  // CF echoes ttl=1 for "automatic".
  if (desired.ttl !== observed.ttl) return false;
  if (
    desired.proxied !== undefined &&
    desired.proxied !== (observed.proxied ?? false)
  ) {
    return false;
  }
  if (
    desired.comment !== undefined &&
    desired.comment !== (observed.comment ?? "")
  ) {
    return false;
  }
  if (
    desired.tags !== undefined &&
    !arrayEqualsUnordered(desired.tags, observed.tags)
  ) {
    return false;
  }
  if (
    desired.priority !== undefined &&
    desired.priority !== observed.priority
  ) {
    return false;
  }
  return true;
};
