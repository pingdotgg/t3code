import * as Hetzner from "@distilled.cloud/hetzner";
import type { DnsRecord, DnsRecordType } from "alchemy/DNS/Adapter";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { waitForZoneAction } from "./actions.ts";
import type { Providers } from "./Providers.ts";

export class DnsRecordListInvalidProps extends Data.TaggedError("DnsRecordListInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RecordListProps {
  /**
   * Zone that owns every record — a Hetzner zone id or zone name. When
   * omitted, each record's zone is inferred from its name by walking its
   * parent domains, so one list may span several zones.
   */
  zone?: string;
  /**
   * Records to publish. Each value is added to the name's RRSet alongside
   * values published by anyone else (the RRSet is created when missing);
   * a `CNAME` RRSet holds exactly one value, so a differing one is
   * replaced.
   */
  records?: DnsRecord[];
  /**
   * Hostnames pointed at {@link target} with a `CNAME`, merged with
   * hostnames bound through the `{ names }` binding contract (see
   * {@link RecordListBinding}).
   */
  names?: string[];
  /** CNAME target of {@link names} and bound hostnames. */
  target?: string;
}

/**
 * Binding contract of {@link RecordList}: composites (e.g. a site attached
 * to an `AWS.Website.Router`) add hostnames pointed at
 * {@link RecordListProps.target} without a circular input prop.
 */
export type RecordListBinding = {
  /** Additional hostnames pointed at the list's `target`. */
  names?: string[];
};

/** One record published by a {@link RecordList}. */
export interface RecordListEntry {
  /** Numeric id of the zone the record lives in. */
  zoneId: number;
  /** RRSet name relative to the zone (`@` for the apex). */
  name: string;
  /** Record type. */
  type: DnsRecordType;
  /** Normalized record value (TXT values unquoted, hostnames without a trailing dot). */
  value: string;
}

export interface RecordListAttributes {
  /** Every record this list currently publishes. */
  records: RecordListEntry[];
}

export type RecordList = Resource<
  "Hetzner.DNS.RecordList",
  RecordListProps,
  RecordListAttributes,
  RecordListBinding,
  Providers
>;

/**
 * An explicit list of Hetzner DNS records whose values are typically
 * computed from another resource's outputs — ACM certificate validation
 * CNAMEs, a platform's ownership-verification TXT, a server's addresses.
 *
 * This is the resource a `Hetzner.DNS.Adapter()` declares for
 * `domain.dns` record publication (see
 * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Values are added
 * to (and on removal, removed from) the name's RRSet, so a list never
 * disturbs records it did not publish.
 * ### Publishing Records
 * **Example:** Point A Hostname At A Server
 * ```typescript
 * yield* Hetzner.DNS.RecordList("App", {
 *   zone: "example.com",
 *   records: [{ name: "app.example.com", type: "A", value: server.ipv4 }],
 * });
 * ```
 *
 * @resource
 * @product DNS
 */
export const RecordList = Resource<RecordList>("Hetzner.DNS.RecordList");

const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();

const unquote = (value: string) => value.replace(/^"|"$/g, "");

const normalizeValue = (type: DnsRecordType, value: string) =>
  type === "TXT" ? unquote(value) : normalizeName(value);

/** Hetzner expects fully qualified hostnames and quoted TXT values. */
const toWire = (type: DnsRecordType, value: string) =>
  type === "TXT" ? `"${value}"` : type === "CNAME" ? `${value}.` : value;

const keyOf = (entry: RecordListEntry) =>
  `${entry.zoneId}|${entry.name}|${entry.type}|${entry.value}`;

const RRSET_CONCURRENCY = 8;

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

const retryLocked = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Locked",
      times: 8,
      schedule: backoff,
    }),
  );

const getZone = (idOrName: string) =>
  Hetzner.zones.getZone({ id_or_name: idOrName }).pipe(
    Effect.map(({ zone }) => zone),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Resolve the zone owning `hostname`: the pinned zone, else the most specific zone in the project. */
const resolveZone = (pinned: string | undefined, hostname: string) =>
  Effect.gen(function* () {
    if (pinned !== undefined) {
      const zone = yield* getZone(pinned);
      if (zone !== undefined) return zone;
    } else {
      const labels = hostname.split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const zone = yield* getZone(labels.slice(i).join("."));
        if (zone !== undefined) return zone;
      }
    }
    return yield* new DnsRecordListInvalidProps({
      message: `No Hetzner DNS zone contains "${hostname}" — create the zone first or pass "zone" explicitly.`,
    });
  });

const relativeName = (hostname: string, zoneName: string) => {
  const zone = normalizeName(zoneName);
  return hostname === zone ? "@" : hostname.slice(0, -(zone.length + 1));
};

const getRrsetValues = (entry: Omit<RecordListEntry, "value">) =>
  Hetzner.zoneRrsets
    .getZoneRrset({
      id_or_name: String(entry.zoneId),
      rr_name: entry.name,
      rr_type: entry.type,
    })
    .pipe(
      Effect.map(({ rrset }) =>
        rrset.records.map((record) => normalizeValue(entry.type, record.value)),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const addValues = (entry: Omit<RecordListEntry, "value">, values: string[]) =>
  Effect.gen(function* () {
    if (values.length === 0) return;
    const { action } = yield* retryLocked(
      Hetzner.zoneRrsetActions.addZoneRrsetRecords({
        id_or_name: String(entry.zoneId),
        rr_name: entry.name,
        rr_type: entry.type,
        records: values.map((value) => ({ value: toWire(entry.type, value) })),
      }),
    );
    yield* waitForZoneAction(action.id);
  });

const removeValues = (entry: Omit<RecordListEntry, "value">, values: string[]) =>
  Effect.gen(function* () {
    const live = new Set(yield* getRrsetValues(entry));
    const present = values.filter((value) => live.has(value));
    if (present.length === 0) return;
    const { action } = yield* retryLocked(
      Hetzner.zoneRrsetActions.removeZoneRrsetRecords({
        id_or_name: String(entry.zoneId),
        rr_name: entry.name,
        rr_type: entry.type,
        records: present.map((value) => ({ value: toWire(entry.type, value) })),
      }),
    );
    yield* waitForZoneAction(action.id);
  });

const groupBy = (entries: RecordListEntry[]) => {
  const groups = new Map<string, RecordListEntry[]>();
  for (const entry of entries) {
    const key = `${entry.zoneId}|${entry.name}|${entry.type}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
};

/**
 * Converge one RRSet: add the desired values that are missing, remove the
 * values this list published before but no longer lists. A CNAME RRSet
 * holds one value, so a differing live value is replaced.
 */
const syncRrset = (desired: RecordListEntry[], previous: RecordListEntry[]) =>
  Effect.gen(function* () {
    const sample = desired[0] ?? previous[0];
    const live = yield* getRrsetValues(sample);
    const wanted = [...new Set(desired.map((entry) => entry.value))];
    const stale = previous.map((entry) => entry.value).filter((value) => !wanted.includes(value));
    const replaced =
      sample.type === "CNAME" && wanted.length > 0
        ? live.filter((value) => !wanted.includes(value))
        : [];
    yield* removeValues(sample, [...new Set([...stale, ...replaced])]);
    yield* addValues(
      sample,
      wanted.filter((value) => !live.includes(value)),
    );
  });

export const RecordListProvider = () =>
  Provider.succeed(RecordList, {
    // No `diff`: every change converges in place.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const present = yield* Effect.forEach(output.records, (entry) =>
        getRrsetValues(entry).pipe(
          Effect.map((values) => (values.includes(entry.value) ? [entry] : [])),
        ),
      );
      return { records: present.flat() };
    }),

    reconcile: Effect.fn(function* ({ news, output, session, bindings }) {
      const zones = new Map<string, { id: number; name: string }>();
      const desiredByKey = new Map<string, RecordListEntry>();
      const bound = (bindings as ReadonlyArray<ResourceBinding<RecordListBinding>>).flatMap(
        (binding) => binding.data?.names ?? [],
      );
      const aliases =
        news.target === undefined
          ? []
          : [...new Set([...(news.names ?? []), ...bound])].map((name): DnsRecord => ({
              name,
              type: "CNAME",
              value: news.target!,
            }));
      for (const record of [...(news.records ?? []), ...aliases]) {
        const hostname = normalizeName(record.name);
        let zone = zones.get(hostname);
        if (zone === undefined) {
          zone = yield* resolveZone(news.zone, hostname);
          zones.set(hostname, zone);
        }
        const entry: RecordListEntry = {
          zoneId: zone.id,
          name: relativeName(hostname, zone.name),
          type: record.type,
          value: normalizeValue(record.type, record.value),
        };
        desiredByKey.set(keyOf(entry), entry);
      }
      const desired = [...desiredByKey.values()];
      const desiredGroups = groupBy(desired);
      const previousGroups = groupBy(output?.records ?? []);
      // RRSets are independent: converge them concurrently (each change is
      // a zone action that takes seconds to apply).
      yield* Effect.forEach(
        new Set([...desiredGroups.keys(), ...previousGroups.keys()]),
        (key) => syncRrset(desiredGroups.get(key) ?? [], previousGroups.get(key) ?? []),
        { concurrency: RRSET_CONCURRENCY, discard: true },
      );
      yield* session.note(`${desired.length} record(s)`);
      return { records: desired };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Effect.forEach(
        groupBy(output.records).values(),
        (previous) => syncRrset([], previous),
        { concurrency: RRSET_CONCURRENCY, discard: true },
      );
    }),
  });
