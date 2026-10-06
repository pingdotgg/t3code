import * as dns from "@distilled.cloud/gcp/dns_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_TTL = 300;
const MAX_LABEL_LENGTH = 63;
const SYSTEM_TYPES = new Set(["SOA", "NS"]);

export type ResourceRecordSetRoutingPolicy = dns.RRSetRoutingPolicy;

export type ResourceRecordSetProps = {
  /**
   * Managed zone name or numeric id that owns this record set. Immutable —
   * changing it replaces the record set.
   */
  managedZone: string;
  /**
   * Fully qualified DNS name (e.g. `"www.example.com."`). A trailing dot
   * is added if omitted. Relative names are qualified with the zone's
   * DNS name. If omitted entirely, a unique subdomain of the zone is
   * generated. Immutable — changing it replaces the record set.
   */
  name?: string;
  /**
   * DNS record type (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, …).
   * Immutable — changing it replaces the record set.
   */
  type: string;
  /**
   * TTL in seconds.
   * @default 300
   */
  ttl?: number;
  /**
   * Resource-record data. For `A` records this is a list of IPv4
   * addresses; for `TXT`, quoted strings. Mutually exclusive with
   * `routingPolicy`.
   */
  rrdatas?: string[];
  /**
   * Dynamic routing policy (geo / weighted-round-robin / primary-backup).
   * A record set has either `rrdatas` or `routingPolicy`, not both.
   */
  routingPolicy?: ResourceRecordSetRoutingPolicy;
};

export type ResourceRecordSet = Resource<
  "GCP.DNS.ResourceRecordSet",
  ResourceRecordSetProps,
  {
    /** Project id. */
    project: string;
    /** Managed zone name. */
    managedZone: string;
    /** Fully qualified DNS name, with trailing dot. */
    name: string;
    /** DNS record type. */
    type: string;
    /** TTL in seconds. */
    ttl: number;
    /** Resource-record data. */
    rrdatas: string[];
    /** Dynamic routing policy, if this is not a static record. */
    routingPolicy: ResourceRecordSetRoutingPolicy | undefined;
    /** DNSSEC signature records, if present. */
    signatureRrdatas: string[] | undefined;
    /** Server-reported kind (`dns#resourceRecordSet`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud DNS resource record set inside a managed zone.
 *
 * Identity is `(managedZone, name, type)`. TTL, `rrdatas`, and
 * `routingPolicy` are mutable. Record sets have no labels; `list` / nuke
 * discover them by enumerating managed zones stamped with `alchemy-*`
 * labels and skipping the zone's apex `SOA`/`NS` records.
 *
 * ### Creating a Record Set
 * **Example:** A record
 * ```typescript
 * const zone = yield* GCP.DNS.ManagedZone("Public", { forceDestroy: true });
 * const www = yield* GCP.DNS.ResourceRecordSet("Www", {
 *   managedZone: zone.zoneName,
 *   name: "www",
 *   type: "A",
 *   ttl: 300,
 *   rrdatas: ["203.0.113.10"],
 * });
 * ```
 *
 * **Example:** TXT record
 * ```typescript
 * const verify = yield* GCP.DNS.ResourceRecordSet("Verify", {
 *   managedZone: zone.zoneName,
 *   name: zone.dnsName,
 *   type: "TXT",
 *   ttl: 60,
 *   rrdatas: ['"v=spf1 -all"'],
 * });
 * ```
 *
 * **Example:** Generated subdomain
 * ```typescript
 * const record = yield* GCP.DNS.ResourceRecordSet("Probe", {
 *   managedZone: zone.zoneName,
 *   type: "A",
 *   rrdatas: ["203.0.113.20"],
 * });
 * ```
 *
 * @resource
 * @category DNS
 */
export const ResourceRecordSet = Resource<ResourceRecordSet>(
  "GCP.DNS.ResourceRecordSet",
);

export class ResourceRecordSetNotResolved extends Data.TaggedError(
  "GCP.DNS.ResourceRecordSetNotResolved",
)<{
  managedZone: string;
  name: string;
  type: string;
}> {}

export class ResourceRecordSetZoneNotFound extends Data.TaggedError(
  "GCP.DNS.ResourceRecordSetZoneNotFound",
)<{
  managedZone: string;
}> {}

const withTrailingDot = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;

const normalizeFqdn = (name: string) => withTrailingDot(name).toLowerCase();

const normalizeType = (type: string) => type.toUpperCase();

const isRelativeName = (name: string) => {
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  return !trimmed.includes(".");
};

const qualifyName = (name: string, dnsName: string) => {
  const zone = normalizeFqdn(dnsName);
  if (isRelativeName(name)) {
    return `${name.replace(/\.$/, "").toLowerCase()}.${zone}`;
  }
  const fqdn = normalizeFqdn(name);
  if (fqdn === zone || fqdn.endsWith(`.${zone}`)) return fqdn;
  return `${name.replace(/\.$/, "").toLowerCase()}.${zone}`;
};

const dnsLabel = (value: string) => {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const trimmed = cleaned.replace(/^-+/, "").slice(0, MAX_LABEL_LENGTH);
  const started = /^[a-z]/.test(trimmed) ? trimmed : `r${trimmed}`;
  return started.replace(/-+$/g, "").slice(0, MAX_LABEL_LENGTH);
};

const sameRrdatas = (left: string[] | undefined, right: string[] | undefined) =>
  JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

const sameRoutingPolicy = (
  left: ResourceRecordSetRoutingPolicy | undefined,
  right: ResourceRecordSetRoutingPolicy | undefined,
) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const nameIdentityChanged = (
  newsName: string | undefined,
  previousName: string | undefined,
) => {
  if (newsName === undefined || previousName === undefined) return false;
  const previous = normalizeFqdn(previousName);
  if (isRelativeName(newsName)) {
    const label = newsName.replace(/\.$/, "").toLowerCase();
    return previous.split(".")[0] !== label;
  }
  return normalizeFqdn(newsName) !== previous;
};

const isApexSystemRecord = (
  record: dns.ResourceRecordSet,
  dnsName: string | undefined,
) => {
  const type = normalizeType(record.type ?? "");
  if (!SYSTEM_TYPES.has(type)) return false;
  if (dnsName === undefined || record.name === undefined) {
    return type === "SOA";
  }
  return normalizeFqdn(record.name) === normalizeFqdn(dnsName);
};

const hasAlchemyZoneLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const toBody = (props: {
  name: string;
  type: string;
  ttl: number;
  rrdatas?: string[];
  routingPolicy?: ResourceRecordSetRoutingPolicy;
}): dns.ResourceRecordSet =>
  props.routingPolicy !== undefined
    ? {
        name: props.name,
        type: props.type,
        ttl: props.ttl,
        routingPolicy: props.routingPolicy,
      }
    : {
        name: props.name,
        type: props.type,
        ttl: props.ttl,
        rrdatas: props.rrdatas ?? [],
      };

const toAttrs = (
  record: dns.ResourceRecordSet,
  project: string,
  managedZone: string,
) => ({
  project,
  managedZone,
  name: record.name ? normalizeFqdn(record.name) : "",
  type: normalizeType(record.type ?? ""),
  ttl: record.ttl ?? DEFAULT_TTL,
  rrdatas: record.rrdatas ?? [],
  routingPolicy: record.routingPolicy,
  signatureRrdatas: record.signatureRrdatas,
  kind: record.kind,
});

const getZone = (project: string, managedZone: string) =>
  dns
    .getManagedZones({ project, managedZone })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getByName = (
  project: string,
  managedZone: string,
  name: string,
  type: string,
) =>
  dns
    .getResourceRecordSets({ project, managedZone, name, type })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toRecordName = (
  id: string,
  name: string | undefined,
  existing: string | undefined,
  dnsName: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return qualifyName(name, dnsName);
    if (existing !== undefined) return normalizeFqdn(existing);
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_LABEL_LENGTH,
      lowercase: true,
    });
    return `${dnsLabel(generated)}.${normalizeFqdn(dnsName)}`;
  });

const listRrsets = (project: string, zoneName: string) =>
  Effect.gen(function* () {
    const found: dns.ResourceRecordSet[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* dns.listResourceRecordSets({
        project,
        managedZone: zoneName,
        maxResults: 1000,
        pageToken,
      });
      found.push(...(response.rrsets ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as dns.ResourceRecordSet[]),
    ),
  );

const listAlchemyZones = (project: string) =>
  Effect.gen(function* () {
    const found: dns.ManagedZone[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* dns.listManagedZones({
        project,
        maxResults: 1000,
        pageToken,
      });
      for (const zone of response.managedZones ?? []) {
        if (hasAlchemyZoneLabels(zone.labels)) found.push(zone);
      }
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

export const ResourceRecordSetProvider = () =>
  Provider.succeed(ResourceRecordSet, {
    stables: ["project", "managedZone", "name", "type"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousZone = olds?.managedZone ?? output?.managedZone;
      const previousName = olds?.name ?? output?.name;
      const previousType = olds?.type ?? output?.type;
      const nextType = normalizeType(news.type);
      const zoneChanged =
        previousZone !== undefined && news.managedZone !== previousZone;
      const typeChanged =
        previousType !== undefined && nextType !== normalizeType(previousType);
      const nameChanged = nameIdentityChanged(news.name, previousName);
      if (zoneChanged || typeChanged || nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const managedZone = output?.managedZone ?? olds?.managedZone;
      const typeRaw = output?.type ?? olds?.type;
      if (managedZone === undefined || typeRaw === undefined) {
        return undefined;
      }
      const type = normalizeType(typeRaw);
      const zone = yield* getZone(env.project, managedZone);
      if (zone === undefined || zone.name === undefined) return undefined;
      const name = yield* toRecordName(
        id,
        olds?.name,
        output?.name,
        zone.dnsName ?? zone.name,
      );
      const existing = yield* getByName(env.project, zone.name, name, type);
      if (existing === undefined) return undefined;
      // Record sets have no labels. Identity (zone + name + type) is
      // ownership — same as Route 53 records.
      return toAttrs(existing, env.project, zone.name);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const zones = yield* listAlchemyZones(env.project);
        const pages = yield* Effect.forEach(
          zones,
          (zone) =>
            zone.name
              ? listRrsets(env.project, zone.name).pipe(
                  Effect.map((records) =>
                    records
                      .filter(
                        (record) => !isApexSystemRecord(record, zone.dnsName),
                      )
                      .map((record) =>
                        toAttrs(record, env.project, zone.name ?? ""),
                      ),
                  ),
                )
              : Effect.succeed([] as ReturnType<typeof toAttrs>[]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const zone = yield* getZone(env.project, news.managedZone);
      if (zone === undefined || zone.name === undefined) {
        return yield* new ResourceRecordSetZoneNotFound({
          managedZone: news.managedZone,
        });
      }
      const managedZone = zone.name;
      const type = normalizeType(news.type);
      const name = yield* toRecordName(
        id,
        news.name,
        output?.name,
        zone.dnsName ?? managedZone,
      );
      const ttl = news.ttl ?? DEFAULT_TTL;
      const desired = toBody({
        name,
        type,
        ttl,
        rrdatas: news.rrdatas,
        routingPolicy: news.routingPolicy,
      });

      let current = yield* getByName(env.project, managedZone, name, type);

      if (current === undefined) {
        const created = yield* dns
          .createResourceRecordSets({
            project: env.project,
            managedZone,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByName(env.project, managedZone, name, type),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ResourceRecordSetNotResolved({
          managedZone,
          name,
          type,
        });
      }

      const ttlChanged = (current.ttl ?? DEFAULT_TTL) !== ttl;
      const rrdatasChanged = !sameRrdatas(current.rrdatas, desired.rrdatas);
      const routingChanged = !sameRoutingPolicy(
        current.routingPolicy,
        desired.routingPolicy,
      );

      if (ttlChanged || rrdatasChanged || routingChanged) {
        current = yield* dns.patchResourceRecordSets({
          project: env.project,
          managedZone,
          name,
          type,
          body: desired,
        });
      }

      return toAttrs(current, env.project, managedZone);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dns
        .deleteResourceRecordSets({
          project: output.project,
          managedZone: output.managedZone,
          name: output.name,
          type: output.type,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
