import * as dns from "@distilled.cloud/cloudflare/dns";
import type { DnsRecord, DnsRecordType } from "alchemy/DNS/Adapter";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId } from "../Zone/lookup.ts";

export interface RecordListProps {
  /**
   * Zone that owns every record — a zone id or zone name. When omitted,
   * each record's zone is inferred from its name by walking its parent
   * domains, so one list may span several zones (e.g. certificate
   * validation records for `example.com` and `example.org`).
   */
  zone?: string;
  /**
   * Records to publish. Always DNS-only (never proxied).
   *
   * - `CNAME` — overwrites any record at the name (one CNAME per name).
   * - `A` / `AAAA` — the name's addresses of that type converge to exactly
   *   the listed values.
   * - `TXT` — each listed value is added alongside any other TXT values at
   *   the name.
   */
  records: DnsRecord[];
}

/** One record published by a {@link RecordList}. */
export interface RecordListEntry {
  /** Zone the record lives in. */
  zoneId: string;
  /** Normalized record name (lowercase, no trailing dot). */
  name: string;
  /** Record type. */
  type: DnsRecordType;
  /** Normalized record value. */
  value: string;
  /** TTL in seconds (`1` = automatic). */
  ttl: number;
}

export interface RecordListAttributes {
  /** Every record this list currently publishes. */
  records: RecordListEntry[];
}

export type RecordList = Resource<
  "Cloudflare.DNS.RecordList",
  RecordListProps,
  RecordListAttributes,
  never,
  Providers
>;

/**
 * An explicit list of Cloudflare DNS records whose values are typically
 * computed from another resource's outputs — ACM certificate validation
 * CNAMEs, a platform's ownership-verification TXT, a Fly App's addresses.
 *
 * This is the resource a `Cloudflare.DNS.Adapter()` declares for
 * `domain.dns` record publication (see
 * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Records are
 * DNS-only, the zone of each record is inferred from its name unless
 * `zone` is set, and only the records the list published are removed when
 * they leave the list or the list is destroyed.
 * ### Publishing Records
 * **Example:** Certificate Validation Records
 * ```typescript
 * const cert = yield* AWS.ACM.Certificate("Cert", {
 *   domainName: "app.example.com",
 *   dnsValidation: "external",
 * });
 * yield* Cloudflare.DNS.RecordList("CertValidation", {
 *   records: cert.domainValidationOptions.pipe(
 *     Output.map(AWS.ACM.validationRecordsOf),
 *   ),
 * });
 * ```
 *
 * **Example:** Verification TXT
 * ```typescript
 * yield* Cloudflare.DNS.RecordList("Verify", {
 *   zone: "example.com",
 *   records: [
 *     { name: "_verify.example.com", type: "TXT", value: "token-123" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product DNS
 * @category Domains & DNS
 */
export const RecordList = Resource<RecordList>("Cloudflare.DNS.RecordList");

const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();

const unquote = (content: string | null | undefined): string =>
  (content ?? "").replace(/^"|"$/g, "");

const normalizeValue = (type: DnsRecordType, value: string | null | undefined) =>
  type === "TXT" ? unquote(value) : normalizeName(value ?? "");

const keyOf = (entry: { name: string; type: string; value: string }) =>
  `${entry.name}|${entry.type}|${entry.value}`;

const listAt = (zoneId: string, name: string, type: DnsRecordType) =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.filter((record) => normalizeName(record.name) === name && record.type === type),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/**
 * Converge one `(zone, name, type)` group of desired records.
 */
const syncGroup = (zoneId: string, name: string, type: DnsRecordType, desired: RecordListEntry[]) =>
  Effect.gen(function* () {
    const live = yield* listAt(zoneId, name, type);
    const liveByValue = new Map(
      live.map((record) => [normalizeValue(type, record.content), record]),
    );
    for (const entry of desired) {
      const existing = liveByValue.get(entry.value);
      if (existing === undefined) {
        // A CNAME is exclusive at its name: overwrite a differing one.
        const conflicting = type === "CNAME" ? live[0] : undefined;
        if (conflicting !== undefined) {
          yield* dns.updateRecord({
            zoneId,
            dnsRecordId: conflicting.id,
            type,
            name,
            content: entry.value,
            ttl: entry.ttl,
            proxied: false,
          });
        } else {
          yield* dns
            .createRecord({
              zoneId,
              type,
              name,
              content: entry.value,
              ttl: entry.ttl,
              ...(type === "TXT" ? {} : { proxied: false }),
            })
            .pipe(Effect.catchTag("DnsRecordAlreadyExists", () => Effect.void));
        }
      } else if (existing.ttl !== entry.ttl || (type !== "TXT" && (existing.proxied ?? false))) {
        yield* dns.updateRecord({
          zoneId,
          dnsRecordId: existing.id,
          type,
          name,
          content: entry.value,
          ttl: entry.ttl,
          ...(type === "TXT" ? {} : { proxied: false }),
        });
      }
    }
    // Addresses converge to exactly the listed values.
    if (type === "A" || type === "AAAA") {
      const wanted = new Set(desired.map((entry) => entry.value));
      yield* Effect.forEach(
        live.filter((record) => !wanted.has(normalizeValue(type, record.content))),
        (record) => dns.deleteRecord({ zoneId, dnsRecordId: record.id }),
        { discard: true },
      );
    }
  });

/** Remove exactly the published `(name, type, value)` records. */
const removeEntries = (entries: RecordListEntry[]) =>
  Effect.forEach(
    entries,
    (entry) =>
      listAt(entry.zoneId, entry.name, entry.type).pipe(
        Effect.flatMap((live) =>
          Effect.forEach(
            live.filter((record) => normalizeValue(entry.type, record.content) === entry.value),
            (record) =>
              dns
                .deleteRecord({ zoneId: entry.zoneId, dnsRecordId: record.id })
                .pipe(Effect.catchTag("RecordNotFound", () => Effect.void)),
            { discard: true },
          ),
        ),
      ),
    { discard: true },
  );

export const RecordListProvider = () =>
  Provider.succeed(RecordList, {
    // No `diff`: every change (records, a pinned zone moving) converges in
    // place — reconcile removes records the list no longer publishes.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const present = yield* Effect.forEach(output.records, (entry) =>
        listAt(entry.zoneId, entry.name, entry.type).pipe(
          Effect.map((live) =>
            live.some((record) => normalizeValue(entry.type, record.content) === entry.value)
              ? [entry]
              : [],
          ),
        ),
      );
      return { records: present.flat() };
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneCache = new Map<string, string>();
      const zoneOf = (name: string) =>
        Effect.gen(function* () {
          const cached = zoneCache.get(name);
          if (cached !== undefined) return cached;
          const zoneId = yield* resolveZoneId({
            accountId,
            zone: news.zone,
            hostname: name,
          });
          zoneCache.set(name, zoneId);
          return zoneId;
        });

      // Dedupe by (name, type, value); a CNAME keeps only its last value.
      const desiredByKey = new Map<string, RecordListEntry>();
      for (const record of news.records) {
        const name = normalizeName(record.name);
        const entry: RecordListEntry = {
          zoneId: yield* zoneOf(name),
          name,
          type: record.type,
          value: normalizeValue(record.type, record.value),
          ttl: record.ttl ?? 1,
        };
        if (entry.type === "CNAME") {
          for (const [key, existing] of desiredByKey) {
            if (existing.type === "CNAME" && existing.name === name) {
              desiredByKey.delete(key);
            }
          }
        }
        desiredByKey.set(`${entry.zoneId}|${keyOf(entry)}`, entry);
      }
      const desired = [...desiredByKey.values()];

      const groups = new Map<string, RecordListEntry[]>();
      for (const entry of desired) {
        const key = `${entry.zoneId}|${entry.name}|${entry.type}`;
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      }
      for (const entries of groups.values()) {
        const [first] = entries;
        yield* syncGroup(first.zoneId, first.name, first.type, entries);
      }

      // Garbage-collect records this list published before but no longer
      // lists. A CNAME whose name is still listed was overwritten in place.
      const desiredKeys = new Set(desired.map((entry) => `${entry.zoneId}|${keyOf(entry)}`));
      const stillListedCname = new Set(
        desired
          .filter((entry) => entry.type === "CNAME")
          .map((entry) => `${entry.zoneId}|${entry.name}`),
      );
      const stale = (output?.records ?? []).filter(
        (entry) =>
          !desiredKeys.has(`${entry.zoneId}|${keyOf(entry)}`) &&
          !(entry.type === "CNAME" && stillListedCname.has(`${entry.zoneId}|${entry.name}`)),
      );
      yield* removeEntries(stale);

      yield* session.note(
        `${desired.length} record(s)` + (stale.length > 0 ? ` (-${stale.length})` : ""),
      );
      return { records: desired };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* removeEntries(output.records);
    }),
  });
