import * as dns from "@distilled.cloud/cloudflare/dns";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { resolveZoneId, type Reference as ZoneReference } from "../Zone/lookup.ts";

/** Record types a {@link Records} set can manage. */
export type RecordsType = "A" | "AAAA" | "CNAME";

/**
 * Binding contract of {@link Records}: composites (e.g. an
 * `AWS.Website.StaticSite` attached to an `AWS.Website.Router`) contribute
 * additional record names without a circular input prop.
 */
export type RecordsBinding = {
  /**
   * Additional record names to manage alongside {@link RecordsProps.names}.
   */
  names?: string[];
};

export interface RecordsProps {
  /**
   * Zone that owns the records — a zone id, zone name, or `Zone`
   * resource. When omitted, the
   * zone containing the set's first name is inferred by walking its parent
   * domains; the deploy fails actionably when no zone matches. Every name in
   * the set lives in the one zone either way.
   */
  zone?: ZoneReference;
  /**
   * Record type shared by every record in the set. Stable — changing it
   * replaces the set.
   */
  type: RecordsType;
  /**
   * Record value shared by every record in the set (e.g. the target
   * hostname of a CNAME).
   */
  content: string;
  /**
   * Record names managed by this set. Names contributed through the binding
   * contract (see {@link RecordsBinding}) are merged in at reconcile time.
   */
  names?: string[];
  /**
   * Whether to send the records through Cloudflare's proxy.
   * @default false
   */
  proxied?: boolean;
  /**
   * TTL in seconds (`60`–`86400`), or `1` for Cloudflare's "automatic"
   * setting. Must be `1` when `proxied` is `true`.
   * @default 1
   */
  ttl?: number;
}

export interface RecordsAttributes {
  /**
   * Zone that owns the records. `undefined` only while the set is empty
   * with no explicit zone — resolved on the first reconcile that has a
   * name.
   */
  zoneId: string | undefined;
  /** Record type shared by every record in the set. */
  type: RecordsType;
  /** Record value shared by every record in the set. */
  content: string;
  /** Whether the records are proxied. */
  proxied: boolean;
  /** TTL of the records (`1` = automatic). */
  ttl: number;
  /**
   * Fully qualified names of every record currently managed by this set
   * (declared `names` plus bound names, as of the last reconcile).
   */
  names: string[];
}

export type Records = Resource<
  "Cloudflare.DNS.Records",
  RecordsProps,
  RecordsAttributes,
  RecordsBinding,
  Providers
>;

/**
 * A dynamic set of identically-configured Cloudflare DNS records that differ
 * only by name — the Cloudflare counterpart of `AWS.Route53.Records`.
 *
 * Unlike `Cloudflare.DNS.Record` (one resource per record), `Records`
 * reconciles a whole name set against the zone: names added to the set are
 * created or overwritten, names removed from the set are deleted. The set is
 * the union of the declared `names` prop and names contributed through the
 * {@link RecordsBinding} binding contract, which is how composites (e.g. a
 * site attached to an `AWS.Website.Router`) register hostnames on a
 * distribution's DNS without a circular input prop.
 *
 * Ownership: when the set is first created, records that already exist at
 * its names are reported as not owned, so the deploy refuses to overwrite
 * them unless `--adopt` (or `adopt(true)`) is set. Names added later are
 * overwritten like a Route 53 `UPSERT`, and removed again when the name
 * leaves the set or the set is destroyed. Cloudflare
 * rejects a `CNAME` at a name that already has `A`/`AAAA` records; remove
 * those first.
 * ### Managing Record Sets
 * **Example:** CNAMEs For Several Hostnames
 * ```typescript
 * const records = yield* Cloudflare.DNS.Records("AliasRecords", {
 *   type: "CNAME",
 *   content: distribution.domainName,
 *   names: ["www.example.com", "docs.example.com"],
 * });
 * ```
 *
 * **Example:** Binding Target For Composite-Contributed Names
 * ```typescript
 * // An empty set that attached sites bind their hostnames onto:
 * const records = yield* Cloudflare.DNS.Records("SiteAliasRecords", {
 *   zone: "example.com",
 *   type: "CNAME",
 *   content: distribution.domainName,
 * });
 * // elsewhere:
 * yield* records.bind`MySite`({ names: ["docs.example.com"] });
 * ```
 *
 * @resource
 * @product DNS
 * @category Domains & DNS
 */
export const Records = Resource<Records>("Cloudflare.DNS.Records");

const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();

/**
 * Union of declared and bound record names, normalized (lowercase, no
 * trailing dot), deduped and sorted for stable comparisons. Tolerates both
 * `{ sid, data }` rows (provider lifecycle) and bare binding payloads.
 * @internal
 */
const resolveDesiredNames = (
  declared: string[] | undefined,
  bindings: ReadonlyArray<RecordsBinding | ResourceBinding<RecordsBinding>>,
): string[] => {
  const bound = bindings.flatMap((binding) =>
    "data" in binding && binding.data !== undefined
      ? ((binding as ResourceBinding<RecordsBinding>).data.names ?? [])
      : ((binding as RecordsBinding).names ?? []),
  );
  return [...new Set([...(declared ?? []), ...bound].map(normalizeName))].sort((a, b) =>
    a.localeCompare(b),
  );
};

const listAtName = (zoneId: string, name: string, type: RecordsType) =>
  dns.listRecords.items({ zoneId, name: { exact: name }, type }).pipe(
    Stream.filter((record) => normalizeName(record.name) === name && record.type === type),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** Cloudflare may echo a CNAME target with different casing. */
const sameContent = (a: string | null | undefined, b: string) =>
  normalizeName(a ?? "") === normalizeName(b);

/**
 * Converge `(name, type)` to exactly one record with `body`'s value: create
 * it when missing, overwrite a record that differs (Route 53 `UPSERT`
 * semantics), and remove extra records sharing the name. A concurrent
 * create (`DnsRecordAlreadyExists`) is a race — re-observe and converge.
 */
const upsertRecordAt = (
  zoneId: string,
  body: {
    type: RecordsType;
    name: string;
    content: string;
    ttl: number;
    proxied: boolean;
  },
) =>
  Effect.gen(function* () {
    const name = normalizeName(body.name);
    const sync = Effect.gen(function* () {
      const [current, ...extra] = yield* listAtName(zoneId, name, body.type);
      if (current === undefined) {
        yield* dns.createRecord({ zoneId, ...body, name });
      } else if (
        !sameContent(current.content, body.content) ||
        current.ttl !== body.ttl ||
        (current.proxied ?? false) !== body.proxied
      ) {
        yield* dns.updateRecord({
          zoneId,
          dnsRecordId: current.id,
          ...body,
          name,
        });
      }
      yield* Effect.forEach(
        extra,
        (record) => dns.deleteRecord({ zoneId, dnsRecordId: record.id }),
        { discard: true },
      );
    });
    yield* sync.pipe(Effect.catchTag("DnsRecordAlreadyExists", () => sync));
  });

const deleteAtNames = (zoneId: string, type: RecordsType, names: string[]) =>
  Effect.forEach(
    names,
    (name) =>
      listAtName(zoneId, normalizeName(name), type).pipe(
        Effect.flatMap((found) =>
          Effect.forEach(found, (record) => dns.deleteRecord({ zoneId, dnsRecordId: record.id }), {
            discard: true,
          }),
        ),
      ),
    { discard: true },
  );

export const RecordsProvider = () =>
  Provider.succeed(Records, {
    stables: ["type"],

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // Only the record type is identity. Names, content, ttl, proxied and
      // even the zone are converged in place by reconcile (a zone move
      // removes the old zone's records). Delete first: Cloudflare rejects a
      // CNAME and an A/AAAA record on the same name.
      if (olds.type !== news.type) {
        return { action: "replace", deleteFirst: true } as const;
      }
    }),

    read: Effect.fn(function* ({ output, olds, previous }) {
      if (output === undefined) {
        // No state of our own: records already at the declared names were
        // not created by this set (DNS records carry no ownership markers),
        // so brand them `Unowned` — the engine refuses to overwrite them
        // unless `adopt` is set.
        const names = resolveDesiredNames(olds?.names, []);
        if (olds === undefined || names.length === 0) return undefined;
        const { accountId } = yield* yield* CloudflareEnvironment;
        const zoneId = yield* resolveZoneId({
          accountId,
          zone: olds.zone,
          hostname: names[0],
        }).pipe(Effect.orElseSucceed(() => undefined));
        if (zoneId === undefined) return undefined;
        const found = (yield* Effect.forEach(names, (name) =>
          listAtName(zoneId, name, olds.type).pipe(
            Effect.map((records) =>
              records[0] === undefined ? [] : [{ name, record: records[0] }],
            ),
          ),
        )).flat();
        const sample = found[0]?.record;
        if (sample === undefined) return undefined;
        const attrs = {
          zoneId,
          type: olds.type,
          content: sample.content ?? olds.content,
          proxied: sample.proxied ?? false,
          ttl: sample.ttl ?? 1,
          names: found.map(({ name }) => name),
        };
        // The record set a replacement is replacing is ours.
        const isPrevious =
          previous?.zoneId === zoneId &&
          previous.type === olds.type &&
          attrs.names.every((name) => previous.names?.includes(name));
        return isPrevious ? attrs : Unowned(attrs);
      }
      if (output.zoneId === undefined) return output;
      const zoneId = output.zoneId;
      const observed = yield* Effect.forEach(output.names, (name) =>
        listAtName(zoneId, name, output.type).pipe(
          Effect.map((records) => (records[0] === undefined ? [] : [{ name, record: records[0] }])),
        ),
      );
      const found = observed.flat();
      const sample = found[0]?.record;
      return {
        ...output,
        names: found.map(({ name }) => name),
        content: sample?.content ?? output.content,
        ttl: sample?.ttl ?? output.ttl,
        proxied: sample?.proxied ?? output.proxied,
      };
    }),

    reconcile: Effect.fn(function* ({ news, output, session, bindings }) {
      const desired = resolveDesiredNames(news.names, bindings);
      const ttl = news.ttl ?? 1;
      const proxied = news.proxied ?? false;
      const zone = news.zone ?? output?.zoneId;
      if (zone === undefined && desired.length === 0) {
        yield* session.note(`${news.type} × 0 record(s)`);
        return {
          zoneId: undefined,
          type: news.type,
          content: news.content,
          proxied,
          ttl,
          names: [],
        };
      }
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zoneId = yield* resolveZoneId({
        accountId,
        zone,
        hostname: desired[0] ?? "",
      });

      // `output.names` is the cache of which records this resource managed
      // before — the only way to know what to garbage-collect. A zone move
      // leaves every previously managed name stale in the old zone.
      const movedZone = output?.zoneId !== undefined && output.zoneId !== zoneId;
      const desiredSet = new Set(desired);
      const stale = (output?.names ?? []).filter(
        (name) => movedZone || !desiredSet.has(normalizeName(name)),
      );

      // Sync — observe each desired name and write only the delta.
      for (const name of desired) {
        yield* upsertRecordAt(zoneId, {
          type: news.type,
          name,
          content: news.content,
          ttl,
          proxied,
        });
      }

      // Garbage-collect names that left the set.
      yield* deleteAtNames(output?.zoneId ?? zoneId, news.type, stale);

      yield* session.note(
        `${news.type} × ${desired.length} record(s)` +
          (stale.length > 0 ? ` (-${stale.length})` : ""),
      );

      return {
        zoneId,
        type: news.type,
        content: news.content,
        proxied,
        ttl,
        names: desired,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      // The set never resolved a zone — it never created records.
      if (output.zoneId === undefined) return;
      yield* deleteAtNames(output.zoneId, output.type, output.names);
    }),
  });
