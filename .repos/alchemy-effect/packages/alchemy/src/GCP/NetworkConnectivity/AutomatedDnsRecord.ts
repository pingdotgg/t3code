import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  NetworkConnectivityNotResolved,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  toNetworkResource,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "automatedDnsRecords";
const DEFAULT_TTL = "30s";

export type AutomatedDnsRecordRecordType =
  | networkconnectivity.AutomatedDnsRecordRecordTypeEnum
  | (string & {});
export type AutomatedDnsRecordCreationMode =
  | networkconnectivity.AutomatedDnsRecordCreationModeEnum
  | (string & {});
export type AutomatedDnsRecordInsertMode =
  | networkconnectivity.CreateProjectsLocationsAutomatedDnsRecordsInsertModeEnum
  | (string & {});
export type AutomatedDnsRecordDeleteMode =
  | networkconnectivity.DeleteProjectsLocationsAutomatedDnsRecordsDeleteModeEnum
  | (string & {});

export type DnsRecordConfig = {
  /** TTL as a duration string, e.g. `"30s"`. */
  ttl?: string;
  /** Resource-record data. Format depends on `recordType`. */
  rrdatas?: string[];
};

export type AutomatedDnsRecordProps = {
  /**
   * AutomatedDnsRecord id (the `{automated_dns_record}` segment of
   * `projects/{project}/locations/{location}/automatedDnsRecords/{automated_dns_record}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the record.
   */
  automatedDnsRecordId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * record. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Service class that authorizes this record. Callers need
   * `networkconnectivity.serviceClasses.use` on the class. Immutable —
   * changing it replaces the record.
   */
  serviceClass: string;
  /**
   * Creation mode. Immutable — changing it replaces the record.
   */
  creationMode: AutomatedDnsRecordCreationMode;
  /**
   * DNS record type (`A`, `AAAA`, `TXT`, `CNAME`). Immutable — changing
   * it replaces the record.
   */
  recordType: AutomatedDnsRecordRecordType;
  /**
   * Hostname prepended to `dnsSuffix` to form the FQDN. Do not include a
   * trailing dot. Immutable — changing it replaces the record.
   */
  hostname: string;
  /**
   * DNS suffix used for longest-suffix matching. Requires a trailing
   * dot, e.g. `"example.com."`. Immutable — changing it replaces the
   * record.
   */
  dnsSuffix: string;
  /**
   * Producer-specified TTL and rrdata. Immutable — changing it replaces
   * the record.
   */
  originalConfig: DnsRecordConfig;
  /**
   * Consumer VPC this record is visible to
   * (`projects/{project}/global/networks/{network}` or a Compute
   * self-link). Immutable — changing it replaces the record.
   */
  consumerNetwork: string;
  /**
   * Insert mode used on create (`FAIL_IF_EXISTS` or `OVERWRITE`).
   * Create-only.
   */
  insertMode?: AutomatedDnsRecordInsertMode;
  /**
   * Delete mode used on destroy (`DEPROGRAM` or `SKIP_DEPROGRAMMING`).
   */
  deleteMode?: AutomatedDnsRecordDeleteMode;
  /**
   * Human-readable description. Set at create; the API has no update.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AutomatedDnsRecord = Resource<
  "GCP.NetworkConnectivity.AutomatedDnsRecord",
  AutomatedDnsRecordProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/automatedDnsRecords/{automated_dns_record}`. */
    name: string;
    /** AutomatedDnsRecord id (last path segment). */
    automatedDnsRecordId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Service class that authorizes this record. */
    serviceClass: string | undefined;
    /** Creation mode. */
    creationMode: string | undefined;
    /** DNS record type. */
    recordType: string | undefined;
    /** Hostname without trailing dot. */
    hostname: string | undefined;
    /** DNS suffix with trailing dot. */
    dnsSuffix: string | undefined;
    /** Producer-specified TTL and rrdata. */
    originalConfig: DnsRecordConfig | undefined;
    /** Live Cloud DNS config, if programmed. */
    currentConfig: DnsRecordConfig | undefined;
    /** Consumer VPC resource path. */
    consumerNetwork: string | undefined;
    /** Fully-qualified domain name, with trailing dot. */
    fqdn: string | undefined;
    /** Cloud DNS zone managed by automation. */
    dnsZone: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`PROGRAMMED`, `CREATING`, …). */
    state: string | undefined;
    /** Extra state context, if any. */
    stateDetails: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A DNS record managed by Network Connectivity Service Connectivity
 * Automation.
 *
 * Identity fields (`automatedDnsRecordId`, `location`, `serviceClass`,
 * `creationMode`, `recordType`, `hostname`, `dnsSuffix`,
 * `originalConfig`, `consumerNetwork`) replace the record. The API has
 * no patch method.
 *
 * ### Creating an AutomatedDnsRecord
 * **Example:** A record on a consumer VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("AppVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const record = yield* GCP.NetworkConnectivity.AutomatedDnsRecord("Redis", {
 *   serviceClass: "gcp-memorystore-redis",
 *   creationMode: "CONSUMER_API",
 *   recordType: "A",
 *   hostname: "redis",
 *   dnsSuffix: "psc.internal.",
 *   originalConfig: { ttl: "30s", rrdatas: ["10.0.0.1"] },
 *   consumerNetwork: network.selfLink ?? network.networkName,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const AutomatedDnsRecord = Resource<AutomatedDnsRecord>(
  "GCP.NetworkConnectivity.AutomatedDnsRecord",
);

const resourceName = (
  project: string,
  location: string,
  automatedDnsRecordId: string,
) =>
  `projects/${project}/locations/${location}/automatedDnsRecords/${automatedDnsRecordId}`;

const toConfig = (
  config: DnsRecordConfig | networkconnectivity.Config | undefined,
): DnsRecordConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    ttl: config.ttl,
    rrdatas: config.rrdatas ? [...config.rrdatas] : undefined,
  };
};

const identityKey = (props: {
  serviceClass?: string;
  creationMode?: string;
  recordType?: string;
  hostname?: string;
  dnsSuffix?: string;
  originalConfig?: DnsRecordConfig;
  consumerNetwork?: string;
}) =>
  JSON.stringify({
    serviceClass: props.serviceClass ?? "",
    creationMode: (props.creationMode ?? "").toUpperCase(),
    recordType: (props.recordType ?? "").toUpperCase(),
    hostname: props.hostname ?? "",
    dnsSuffix: props.dnsSuffix ?? "",
    originalConfig: {
      ttl: props.originalConfig?.ttl ?? DEFAULT_TTL,
      rrdatas: [...(props.originalConfig?.rrdatas ?? [])].sort(),
    },
    consumerNetwork: lastNetwork(props.consumerNetwork),
  });

const lastNetwork = (network: string | undefined) =>
  network === undefined || network.length === 0
    ? ""
    : network.replace(/^https?:\/\/[^/]+\//, "").replace(/\/+$/, "");

const toAttrs = (
  record: networkconnectivity.AutomatedDnsRecord,
  project: string,
  region: string,
) => {
  const name = record.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  return {
    name,
    automatedDnsRecordId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || region,
    serviceClass: record.serviceClass,
    creationMode: record.creationMode,
    recordType: record.recordType,
    hostname: record.hostname,
    dnsSuffix: record.dnsSuffix,
    originalConfig: toConfig(record.originalConfig),
    currentConfig: toConfig(record.currentConfig),
    consumerNetwork: record.consumerNetwork,
    fqdn: record.fqdn,
    dnsZone: record.dnsZone,
    description: record.description,
    labels: userLabels(record.labels),
    state: record.state,
    stateDetails: record.stateDetails,
    etag: record.etag,
    createTime: record.createTime,
    updateTime: record.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsAutomatedDnsRecords({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const AutomatedDnsRecordProvider = () =>
  Provider.succeed(AutomatedDnsRecord, {
    stables: [
      "name",
      "automatedDnsRecordId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.automatedDnsRecordId ?? output?.automatedDnsRecordId;
      const nextId = news.automatedDnsRecordId
        ? rfc1035(news.automatedDnsRecordId, "automated-dns-record")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousKey = identityKey({
        serviceClass: olds?.serviceClass ?? output?.serviceClass,
        creationMode: olds?.creationMode ?? output?.creationMode,
        recordType: olds?.recordType ?? output?.recordType,
        hostname: olds?.hostname ?? output?.hostname,
        dnsSuffix: olds?.dnsSuffix ?? output?.dnsSuffix,
        originalConfig: olds?.originalConfig ?? output?.originalConfig,
        consumerNetwork: olds?.consumerNetwork ?? output?.consumerNetwork,
      });
      const nextKey = identityKey({
        serviceClass: news.serviceClass,
        creationMode: news.creationMode,
        recordType: news.recordType,
        hostname: news.hostname,
        dnsSuffix: news.dnsSuffix,
        originalConfig: news.originalConfig,
        consumerNetwork: news.consumerNetwork,
      });
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousKey !== nextKey
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const automatedDnsRecordId = yield* toPhysicalId(
        id,
        olds?.automatedDnsRecordId,
        output?.automatedDnsRecordId,
        "automated-dns-record",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, automatedDnsRecordId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkconnectivity.listProjectsLocationsAutomatedDnsRecords.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.automatedDnsRecords,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const automatedDnsRecordId = yield* toPhysicalId(
        id,
        news.automatedDnsRecordId,
        output?.automatedDnsRecordId,
        "automated-dns-record",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, automatedDnsRecordId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const consumerNetwork = toNetworkResource(
        env.project,
        news.consumerNetwork,
      );
      const originalConfig = {
        ttl: news.originalConfig.ttl ?? DEFAULT_TTL,
        rrdatas: news.originalConfig.rrdatas
          ? [...news.originalConfig.rrdatas]
          : undefined,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsAutomatedDnsRecords({
            parent: parentOf(env.project, location),
            automatedDnsRecordId,
            insertMode: news.insertMode,
            body: {
              serviceClass: news.serviceClass,
              creationMode: news.creationMode,
              recordType: news.recordType,
              hostname: news.hostname,
              dnsSuffix: news.dnsSuffix,
              originalConfig,
              consumerNetwork,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new NetworkConnectivityNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsAutomatedDnsRecords({
          name: output.name,
          etag: output.etag,
          deleteMode: olds?.deleteMode,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
