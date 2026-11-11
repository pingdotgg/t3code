import * as route53 from "@distilled.cloud/aws/route-53";
import type { DnsRecord, DnsRecordType } from "alchemy/DNS/Adapter";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import { resolveHostedZoneId } from "./HostedZoneLookup.ts";
import { normalizeHostedZoneId } from "./Record.ts";

export interface RecordListProps {
  /**
   * Hosted zone that owns every record. When omitted, each record's zone
   * is the most specific PUBLIC hosted zone in the account containing its
   * name, so one list may span several zones (e.g. certificate validation
   * records for `example.com` and `example.org`).
   */
  hostedZoneId?: string;
  /**
   * Records to publish.
   *
   * - `CNAME` — the record set at the name is overwritten (`UPSERT`).
   * - `A` / `AAAA` — the name's record set of that type holds exactly the
   *   listed values.
   * - `TXT` — the listed values are merged into the name's TXT record set,
   *   alongside values published by anyone else.
   */
  records: DnsRecord[];
}

/** One record published by a {@link RecordList}. */
export interface RecordListEntry {
  /** Hosted zone the record lives in. */
  hostedZoneId: string;
  /** Normalized record name (lowercase, no trailing dot). */
  name: string;
  /** Record type. */
  type: DnsRecordType;
  /** Normalized record value (TXT values unquoted). */
  value: string;
  /** TTL in seconds. */
  ttl: number;
}

export interface RecordList extends Resource<
  "AWS.Route53.RecordList",
  RecordListProps,
  {
    /** Every record this list currently publishes. */
    records: RecordListEntry[];
  },
  never,
  Providers
> {}

/**
 * An explicit list of Route 53 records whose values are typically computed
 * from another resource's outputs — ACM certificate validation CNAMEs, a
 * platform's ownership-verification TXT, a Fly App's addresses.
 *
 * This is the resource an `AWS.Route53.Adapter()` declares for
 * `domain.dns` record publication (see
 * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Each record's
 * hosted zone is inferred from its name unless `hostedZoneId` is set, and
 * only the values the list published are removed when they leave the list
 * or the list is destroyed.
 * ### Publishing Records
 * **Example:** Verification TXT For A Railway Domain
 * ```typescript
 * yield* AWS.Route53.RecordList("Verify", {
 *   records: [
 *     {
 *       name: "_railway-verify.app.example.com",
 *       type: "TXT",
 *       value: "railway-verify=abc123",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RecordList = Resource<RecordList>("AWS.Route53.RecordList");

const DEFAULT_TTL = 300;

const normalizeName = (name: string) => name.replace(/\.$/, "").toLowerCase();

const unquote = (value: string) => value.replace(/^"|"$/g, "");

const normalizeValue = (type: DnsRecordType, value: string) =>
  type === "TXT" ? unquote(value) : normalizeName(value);

const toWire = (type: DnsRecordType, value: string) => (type === "TXT" ? `"${value}"` : value);

const keyOf = (entry: RecordListEntry) =>
  `${entry.hostedZoneId}|${entry.name}|${entry.type}|${entry.value}`;

const groupKeyOf = (entry: { hostedZoneId: string; name: string; type: string }) =>
  `${entry.hostedZoneId}|${entry.name}|${entry.type}`;

const waitForChange = (changeId: string) =>
  route53.getChange({ Id: changeId.replace(/^\/change\//, "") }).pipe(
    Effect.map((response) => response.ChangeInfo.Status),
    Effect.catchTag("NoSuchChange", () => Effect.succeed("PENDING" as const)),
    Effect.repeat({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(60)]),
      until: (status) => status === "INSYNC",
    }),
  );

const findRecordSet = (hostedZoneId: string, name: string, type: DnsRecordType) =>
  route53
    .listResourceRecordSets({
      HostedZoneId: normalizeHostedZoneId(hostedZoneId),
      StartRecordName: `${name}.`,
      StartRecordType: type,
      MaxItems: 10,
    })
    .pipe(
      Effect.map((response) =>
        (response.ResourceRecordSets ?? []).find(
          (recordSet) =>
            normalizeName(recordSet.Name) === name &&
            recordSet.Type === type &&
            recordSet.SetIdentifier === undefined &&
            recordSet.AliasTarget === undefined,
        ),
      ),
      Effect.catchTag("NoSuchHostedZone", () => Effect.undefined),
    );

const liveValuesOf = (type: DnsRecordType, recordSet: route53.ResourceRecordSet | undefined) =>
  (recordSet?.ResourceRecords ?? []).map((record) => normalizeValue(type, record.Value));

const sameValues = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * Plan the change converging one `(zone, name, type)` record set: `desired`
 * are the values this list publishes there now, `previous` the values it
 * published before (removed unless still desired). `undefined` when the
 * live record set already matches.
 */
const planRecordSetChange = (
  hostedZoneId: string,
  name: string,
  type: DnsRecordType,
  desired: RecordListEntry[],
  previous: RecordListEntry[],
) =>
  Effect.gen(function* () {
    const live = yield* findRecordSet(hostedZoneId, name, type);
    const liveValues = liveValuesOf(type, live);
    const desiredValues = desired.map((entry) => entry.value);
    const removed = new Set(
      previous.map((entry) => entry.value).filter((value) => !desiredValues.includes(value)),
    );
    const values =
      type === "TXT"
        ? [...new Set([...liveValues.filter((value) => !removed.has(value)), ...desiredValues])]
        : type === "CNAME"
          ? desiredValues.slice(-1)
          : [...new Set(desiredValues)];
    const ttl = desired[0]?.ttl ?? live?.TTL ?? DEFAULT_TTL;

    if (values.length === 0) {
      // Nothing of ours (or anyone's, for TXT) remains: delete what we own.
      const ours =
        live !== undefined && (type === "TXT" || liveValues.every((value) => removed.has(value)));
      return ours ? ({ Action: "DELETE", ResourceRecordSet: live } as route53.Change) : undefined;
    }
    if (live === undefined || !sameValues(liveValues, values) || live.TTL !== ttl) {
      return {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: `${name}.`,
          Type: type,
          TTL: ttl,
          ResourceRecords: values.map((value) => ({
            Value: toWire(type, value),
          })),
        },
      } as route53.Change;
    }
    return undefined;
  });

const submitChanges = (hostedZoneId: string, changes: route53.Change[]) =>
  route53.changeResourceRecordSets({
    HostedZoneId: normalizeHostedZoneId(hostedZoneId),
    ChangeBatch: { Comment: "Alchemy Route53 record list", Changes: changes },
  });

/**
 * Apply one zone's changes as a single batch and wait for it once — each
 * Route 53 change takes up to a minute to reach `INSYNC`. A rejected batch
 * (e.g. a DELETE racing another writer) falls back to one change at a
 * time, where a rejected DELETE is benign and anything else fails.
 */
const applyChanges = (hostedZoneId: string, changes: route53.Change[]) =>
  Effect.gen(function* () {
    if (changes.length === 0) return;
    const batch = yield* submitChanges(hostedZoneId, changes).pipe(
      Effect.map((response) => [response.ChangeInfo.Id]),
      Effect.catchTag("InvalidChangeBatch", (error) =>
        changes.length === 1 && changes[0]?.Action !== "DELETE"
          ? Effect.fail(error)
          : Effect.forEach(changes, (change) =>
              submitChanges(hostedZoneId, [change]).pipe(
                Effect.map((response) => [response.ChangeInfo.Id]),
                Effect.catchTag("InvalidChangeBatch", (error) =>
                  change.Action === "DELETE" ? Effect.succeed([] as string[]) : Effect.fail(error),
                ),
              ),
            ).pipe(Effect.map((ids) => ids.flat())),
      ),
    );
    yield* Effect.forEach(batch, waitForChange, { discard: true });
  });

/**
 * Converge every `(zone, name, type)` record set touched by `desired` or
 * `previous`, one change batch per hosted zone.
 */
const syncRecordSets = (desired: RecordListEntry[], previous: RecordListEntry[]) =>
  Effect.gen(function* () {
    const desiredGroups = groupBy(desired);
    const previousGroups = groupBy(previous);
    const changesByZone = new Map<string, route53.Change[]>();
    for (const key of new Set([...desiredGroups.keys(), ...previousGroups.keys()])) {
      const group = desiredGroups.get(key) ?? [];
      const before = previousGroups.get(key) ?? [];
      const sample = group[0] ?? before[0];
      const change = yield* planRecordSetChange(
        sample.hostedZoneId,
        sample.name,
        sample.type,
        group,
        before,
      );
      if (change !== undefined) {
        changesByZone.set(sample.hostedZoneId, [
          ...(changesByZone.get(sample.hostedZoneId) ?? []),
          change,
        ]);
      }
    }
    for (const [hostedZoneId, changes] of changesByZone) {
      yield* applyChanges(hostedZoneId, changes);
    }
  });

const groupBy = (entries: RecordListEntry[]) => {
  const groups = new Map<string, RecordListEntry[]>();
  for (const entry of entries) {
    const key = groupKeyOf(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
};

export const RecordListProvider = () =>
  Provider.succeed(RecordList, {
    // No `diff`: every change (records, a pinned zone moving) converges in
    // place — reconcile removes values the list no longer publishes.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const present = yield* Effect.forEach(output.records, (entry) =>
        findRecordSet(entry.hostedZoneId, entry.name, entry.type).pipe(
          Effect.map((live) =>
            liveValuesOf(entry.type, live).includes(entry.value) ? [entry] : [],
          ),
        ),
      );
      return { records: present.flat() };
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      const zoneCache = new Map<string, string>();
      const desiredByKey = new Map<string, RecordListEntry>();
      for (const record of news.records) {
        const name = normalizeName(record.name);
        let hostedZoneId = zoneCache.get(name);
        if (hostedZoneId === undefined) {
          hostedZoneId = normalizeHostedZoneId(yield* resolveHostedZoneId(news.hostedZoneId, name));
          zoneCache.set(name, hostedZoneId);
        }
        const entry: RecordListEntry = {
          hostedZoneId,
          name,
          type: record.type,
          value: normalizeValue(record.type, record.value),
          ttl: record.ttl ?? DEFAULT_TTL,
        };
        desiredByKey.set(keyOf(entry), entry);
      }
      const desired = [...desiredByKey.values()];
      yield* syncRecordSets(desired, output?.records ?? []);

      yield* session.note(`${desired.length} record(s)`);
      return { records: desired };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* syncRecordSets([], output.records);
    }),
  });
