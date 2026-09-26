import * as dns from "@distilled.cloud/cloudflare/dns";
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Data from "effect/Data";
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

/**
 * Cloudflare's structured DNS record components, keyed by record type.
 */
export interface RecordDataByType {
  CAA: dns.RecordsCreateRequestDataCAARecord;
  CERT: dns.RecordsCreateRequestDataCERTRecord;
  DNSKEY: dns.RecordsCreateRequestDataDNSKEYRecord;
  DS: dns.RecordsCreateRequestDataDSRecord;
  HTTPS: dns.RecordsCreateRequestDataHTTPSRecord;
  LOC: dns.RecordsCreateRequestDataLOCRecord;
  NAPTR: dns.RecordsCreateRequestDataNAPTRRecord;
  SMIMEA: dns.RecordsCreateRequestDataSMIMEARecord;
  SRV: dns.RecordsCreateRequestDataSRVRecord;
  SSHFP: dns.RecordsCreateRequestDataSSHFPRecord;
  SVCB: dns.RecordsCreateRequestDataHTTPSRecord;
  TLSA: dns.RecordsCreateRequestDataSMIMEARecord;
  URI: dns.RecordsCreateRequestDataURIRecord;
}

/** Structured DNS record components accepted by Cloudflare. */
export type RecordData = RecordDataByType[keyof RecordDataByType];

export interface RecordCommonProps {
  /**
   * Zone the record lives in. Stable — changing the zone triggers
   * replacement.
   */
  zoneId: string;
  /**
   * Fully-qualified or zone-relative record name (e.g.
   * `cluster-admin.microtrack.ai`, `_dmarc`, or `@` for the zone apex).
   * Cloudflare normalizes relative names to their fully-qualified form.
   *
   * Stable — Cloudflare treats `(name, type)` as the record's identity,
   * so a rename is a delete + create. Declared as plain `string` (not
   * `string`) so it is statically knowable inside `diff`.
   */
  name: string;
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
}

type StringRecordType = Exclude<RecordType, keyof RecordDataByType | "MX">;

type StringRecordProps = {
  /** Record type. Stable — changing triggers replacement. */
  type: StringRecordType;
  /** Formatted record value. Mutable — patched in place. */
  content: string;
  priority?: never;
};

interface MxRecordProps {
  /** Record type. Stable — changing triggers replacement. */
  type: "MX";
  /** Mail server hostname. Mutable — patched in place. */
  content: string;
  /** Mail server priority; lower values are preferred. */
  priority?: number;
}

type StructuredRecordProps = {
  [Type in keyof RecordDataByType]: {
    /** Record type. Stable — changing triggers replacement. */
    type: Type;
    /**
     * Record value as formatted DNS content or typed Cloudflare components.
     * Mutable — patched in place.
     */
    content: string | RecordDataByType[Type];
    /**
     * Top-level priority, used by URI records. SRV, SVCB, and HTTPS put their
     * priority inside structured `content`.
     */
    priority?: Type extends "URI" ? number : never;
  };
}[keyof RecordDataByType];

/** Input properties for a Cloudflare DNS record. */
export type RecordProps = RecordCommonProps &
  (StringRecordProps | MxRecordProps | StructuredRecordProps);

export interface RecordAttributes {
  /** Cloudflare-assigned DNS record UUID. */
  recordId: string;
  /** Zone that owns this record. */
  zoneId: string;
  /** Record name (FQDN, as Cloudflare returns it). */
  name: string;
  /** Record type. */
  type: RecordType;
  /** Formatted record value returned by Cloudflare. */
  content: string;
  /** Structured record components, when Cloudflare returns them. */
  data?: RecordData;
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
 *
 * Several records may legitimately share `(name, type)` — MX fallbacks,
 * multiple TXT records, round-robin A records. When the scan finds more
 * than one candidate, the declared `content` (and `priority`) must match
 * exactly one record; a record with no exact match is treated as missing
 * (a new sibling record is created), and a still-ambiguous match fails
 * with an error listing the candidates. To adopt one record out of such
 * a set, declare its current `content`/`priority` verbatim first, then
 * change them in a follow-up deploy.
 * ### Proxied CNAME pointing at a tunnel
 * **Example:** Route a subdomain through a Cloudflare Tunnel
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
 * ### Plain A record
 * **Example:** Direct A record (not proxied)
 * ```typescript
 * yield* Cloudflare.DNS.Record("ApiA", {
 *   zoneId: zone.zoneId,
 *   name: "api.example.com",
 *   type: "A",
 *   content: "203.0.113.42",
 *   ttl: 300,
 * });
 * ```
 *
 * ### Structured service binding records
 * **Example:** SVCB record
 * ```typescript
 * yield* Cloudflare.DNS.Record("McpSvcb", {
 *   zoneId: zone.zoneId,
 *   name: "_mcp._agents.example.com",
 *   type: "SVCB",
 *   content: {
 *     priority: 1,
 *     target: "mcp.example.com.",
 *     value: 'mandatory="alpn,port" alpn="h2,h3" port="443"',
 *   },
 * });
 * ```
 *
 * **Example:** HTTPS record
 * ```typescript
 * yield* Cloudflare.DNS.Record("WebsiteHttps", {
 *   zoneId: zone.zoneId,
 *   name: "example.com",
 *   type: "HTTPS",
 *   content: {
 *     priority: 1,
 *     target: ".",
 *     value: 'alpn="h2,h3"',
 *   },
 * });
 * ```
 *
 * @resource
 * @product DNS
 * @category Domains & DNS
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
      const body = buildMutableBody(news);

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
        const existing = yield* findByNameType(zoneId, news.name, news.type, {
          content: body.content,
          data: body.data,
          priority: news.priority,
        });
        if (existing) {
          foundByScan = true;
          observed = existing;
        }
      }

      // 3. Ensure.
      if (!observed) {
        const created = yield* dns.createRecord({ zoneId, ...body }).pipe(
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
            findByNameType(zoneId, news.name, news.type, {
              content: body.content,
              data: body.data,
              priority: news.priority,
            }).pipe(
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
            ...body,
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
            "Cloudflare returned a DNS record without id/type/value/ttl",
          ),
        );
      }
      return {
        recordId: observed.id,
        zoneId,
        name: observed.name ?? body.name,
        type: observed.type,
        content: observed.content,
        data: observed.data,
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
      // unless `adopt` is set. Several records may legitimately share
      // `(name, type)` (MX fallbacks, multiple TXT/A records) — the
      // declared `content`/`priority` disambiguate which one this
      // resource corresponds to.
      const zoneId = output?.zoneId ?? olds?.zoneId;
      const name = output?.name ?? olds?.name;
      const type = output?.type ?? olds?.type;
      if (zoneId && name && type) {
        const observed = yield* findByNameType(zoneId, name, type, {
          content:
            typeof olds?.content === "string"
              ? olds.content
              : olds?.content === undefined
                ? output?.content
                : undefined,
          data: typeof olds?.content === "object" ? olds.content : output?.data,
          priority: olds?.priority,
        });
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

/**
 * Property match used to disambiguate between several records sharing
 * `(name, type)` — MX fallbacks, multiple TXT records, round-robin A
 * records are all legitimate Cloudflare configurations.
 */
interface RecordMatch {
  readonly content?: string;
  readonly data?: RecordData;
  readonly priority?: number;
}

/**
 * Raised when several DNS records share `(name, type)` and the declared
 * `content`/`data`/`priority` do not select exactly one of them — adoption must
 * never pick a record arbitrarily.
 */
export class AmbiguousDnsRecordError extends Data.TaggedError(
  "AmbiguousDnsRecordError",
)<{
  readonly zoneId: string;
  readonly name: string;
  readonly type: RecordType;
  readonly candidates: ReadonlyArray<{
    readonly id?: string;
    readonly content?: string;
    readonly data?: RecordData;
    readonly priority?: number;
  }>;
  readonly message: string;
}> {}

// Locate an existing record by `(zoneId, name, type)`. Cloudflare accepts
// relative names on writes but returns FQDNs on reads, so check the supplied
// name first and then its zone-qualified form. Used both for the adoption path
// and to surface a conflict when the caller hasn't opted into adoption.
//
// `(name, type)` alone is NOT a unique identity — several records may share
// it. A single candidate is returned as-is (preserving the adopt-then-modify
// flow where the desired content differs from the live record). With multiple
// candidates, the desired record value/priority must select exactly one:
//   - exactly one exact match -> that record
//   - no exact match          -> `undefined` (a new sibling record is created)
//   - several exact matches   -> fail with an actionable error
const findByNameType = (
  zoneId: string,
  name: string,
  type: RecordType,
  match: RecordMatch,
) =>
  listExactByNameType(zoneId, name, type).pipe(
    Effect.flatMap((found) => {
      if (found.length > 0) return Effect.succeed(found);

      return zones.getZone({ zoneId }).pipe(
        Effect.flatMap((zone) => {
          const normalizedName = normalizeRecordName(name, zone.name);
          return normalizedName === name
            ? Effect.succeed([] as ObservedRecord[])
            : listExactByNameType(zoneId, normalizedName, type);
        }),
      );
    }),
    Effect.flatMap(
      Effect.fn(function* (candidates) {
        if (candidates.length === 0) return undefined;
        if (candidates.length === 1) return candidates[0];
        const narrowed = candidates.filter(
          (r) =>
            (match.content === undefined || r.content === match.content) &&
            (match.data === undefined ||
              recordDataEquals(match.data, r.data)) &&
            (match.priority === undefined || r.priority === match.priority),
        );
        if (narrowed.length === 1) return narrowed[0];
        if (narrowed.length === 0) return undefined;
        return yield* new AmbiguousDnsRecordError({
          zoneId,
          name,
          type,
          candidates: candidates.map((r) => ({
            id: r.id,
            content: r.content,
            data: r.data,
            priority: r.priority,
          })),
          message:
            `Multiple DNS records in zone ${zoneId} match (name=${name}, ` +
            `type=${type}) and the desired record value/priority does not ` +
            `select exactly one. Set \`content\`` +
            (type === "MX" || type === "URI" ? " and `priority`" : "") +
            ` to exactly match the record this resource should adopt ` +
            `(you can change it afterwards). Candidates:\n` +
            candidates
              .map(
                (r) =>
                  `  - id=${r.id} content=${JSON.stringify(r.content)}` +
                  (r.data === undefined
                    ? ""
                    : ` data=${JSON.stringify(r.data)}`) +
                  (r.priority === undefined ? "" : ` priority=${r.priority}`),
              )
              .join("\n"),
        });
      }),
    ),
  );

const listExactByNameType = (zoneId: string, name: string, type: RecordType) =>
  dns.listRecords
    .items({
      zoneId,
      name: { exact: name },
      type: type as dns.ListRecordsRequest["type"],
    })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .filter((r) => r.name === name && r.type === type)
          .map((r) => narrowRecord(r as Parameters<typeof narrowRecord>[0])),
      ),
    );

const normalizeRecordName = (name: string, zoneName: string): string => {
  if (name === "@") return zoneName;
  if (name === zoneName || name.endsWith(`.${zoneName}`)) return name;
  return `${name}.${zoneName}`;
};

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
  readonly data?: RecordData;
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
  data?: Readonly<{ [key: string]: unknown }> | null;
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
  data: normalizeRecordData(raw.data),
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
    data: observed.data,
    ttl: observed.ttl,
    proxied: observed.proxied ?? false,
    createdOn: observed.createdOn,
    modifiedOn: observed.modifiedOn,
  };
};

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

interface RecordMutableBodyCommon {
  name: string;
  type: RecordType;
  ttl: number;
  proxied?: boolean;
  comment?: string;
  tags?: string[];
  priority?: number;
}

type RecordMutableBody = RecordMutableBodyCommon &
  ({ content: string; data?: never } | { content?: never; data: RecordData });

const buildMutableBody = (news: RecordProps): RecordMutableBody => {
  const common: RecordMutableBodyCommon = {
    name: news.name,
    type: news.type,
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
    tags: news.tags === undefined ? undefined : Array.from(news.tags),
    priority: news.priority,
  };
  return typeof news.content === "string"
    ? { ...common, content: news.content }
    : { ...common, data: news.content };
};

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

const bodyEqualsObserved = (
  desired: RecordMutableBody,
  observed: ObservedRecord,
): boolean => {
  if (desired.content !== undefined && desired.content !== observed.content) {
    return false;
  }
  if (
    desired.data !== undefined &&
    !recordDataEquals(desired.data, observed.data)
  ) {
    return false;
  }
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

const normalizeRecordData = (
  data: Readonly<{ [key: string]: unknown }> | null | undefined,
): RecordData | undefined => {
  if (data == null) return undefined;
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value != null),
  ) as RecordData;
};

const recordDataEquals = (
  desired: RecordData,
  observed: RecordData | undefined,
): boolean => {
  if (observed === undefined) return false;
  const desiredEntries = Object.entries(desired).filter(
    ([, value]) => value != null,
  );
  const observedEntries = Object.entries(observed).filter(
    ([, value]) => value != null,
  );
  return (
    desiredEntries.length === observedEntries.length &&
    desiredEntries.every(([key, value]) =>
      observedEntries.some(
        ([observedKey, observedValue]) =>
          observedKey === key && observedValue === value,
      ),
    )
  );
};
