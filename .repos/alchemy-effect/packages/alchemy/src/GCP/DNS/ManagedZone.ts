import * as dns from "@distilled.cloud/gcp/dns_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type LongRunningOperation,
  waitForOperation as waitForLongRunning,
} from "../Operation.ts";

const MAX_NAME_LENGTH = 63;
const DEFAULT_VISIBILITY = "public";
const GENERATED_DNS_SUFFIX = ".alchemy-gcp-test.";

export type ManagedZoneVisibility = "public" | "private";

export type ManagedZoneProps = {
  /**
   * User-assigned zone name, unique within the project. If omitted, a
   * unique RFC1035 name is generated from the stack, stage, and logical
   * id. Must be 1-63 characters, begin with a letter, end with a letter
   * or digit, and contain only lowercase letters, digits, or dashes.
   * Immutable — changing it replaces the zone.
   */
  zoneName?: string;
  /**
   * DNS name of the zone, for instance `"example.com."`. A trailing dot
   * is added if omitted. If the prop is omitted entirely, a unique name
   * is derived from `zoneName` (`{zoneName}.alchemy-gcp-test.`).
   * Immutable — changing it replaces the zone.
   */
  dnsName?: string;
  /**
   * Human-readable description (max 1024 characters).
   */
  description?: string;
  /**
   * Zone visibility. Public zones are exposed to the Internet; private
   * zones are visible only to VPC resources listed in `networks`.
   * Immutable — changing it replaces the zone.
   * @default "public"
   */
  visibility?: ManagedZoneVisibility;
  /**
   * VPC networks that can query a private zone. Each value may be a
   * network name, a `projects/.../global/networks/...` path, or a full
   * compute URL. Ignored for public zones. Updates in place.
   */
  networks?: string[];
  /**
   * Enable Cloud DNS query logging. Public zones only.
   * @default false
   */
  enableLogging?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Delete all non-SOA/NS record sets before destroying the zone.
   * @default false
   */
  forceDestroy?: boolean;
};

export type ManagedZone = Resource<
  "GCP.DNS.ManagedZone",
  ManagedZoneProps,
  {
    /** User-assigned zone name. */
    zoneName: string;
    /** DNS name, including the trailing dot. */
    dnsName: string;
    /** Project id. */
    project: string;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /** `public` or `private`. */
    visibility: string;
    /** User description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether query logging is enabled. */
    enableLogging: boolean;
    /** VPC network URLs for a private zone. */
    networks: ReadonlyArray<string>;
    /** Authoritative name servers (output only). */
    nameServers: ReadonlyArray<string>;
    /** RFC3339 creation timestamp. */
    creationTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud DNS managed zone.
 *
 * Name, DNS name, and visibility are identity — changing them replaces
 * the zone. Description, labels, query logging, and the private-zone
 * network list update in place.
 *
 * ### Creating a Zone
 * **Example:** Generated name (public)
 * ```typescript
 * const zone = yield* GCP.DNS.ManagedZone("Public", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * **Example:** Explicit name, DNS name, and labels
 * ```typescript
 * const zone = yield* GCP.DNS.ManagedZone("Public", {
 *   zoneName: "app-public",
 *   dnsName: "app.example.com.",
 *   description: "application public zone",
 *   labels: { env: "prod" },
 *   enableLogging: true,
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Private Zone
 * **Example:** Private zone visible from one VPC
 * ```typescript
 * const zone = yield* GCP.DNS.ManagedZone("Internal", {
 *   dnsName: "internal.example.com.",
 *   visibility: "private",
 *   networks: ["app-vpc"],
 *   forceDestroy: true,
 * });
 * ```
 *
 * @resource
 * @category DNS
 */
export const ManagedZone = Resource<ManagedZone>("GCP.DNS.ManagedZone");

export class ManagedZoneNotResolved extends Data.TaggedError(
  "GCP.DNS.ManagedZoneNotResolved",
)<{
  zoneName: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const isDone = (status: string | undefined) =>
  (status ?? "").toLowerCase() === "done";

const normalizeDnsName = (value: string) =>
  value.endsWith(".") ? value : `${value}.`;

const normalizeVisibility = (value: string | undefined) =>
  (value ?? DEFAULT_VISIBILITY).toLowerCase();

const toZoneName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `a${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const toDnsName = (
  zoneName: string,
  dnsName: string | undefined,
  existing?: string,
) =>
  dnsName !== undefined
    ? normalizeDnsName(dnsName)
    : existing !== undefined
      ? normalizeDnsName(existing)
      : `${zoneName}${GENERATED_DNS_SUFFIX}`;

const toNetworkUrl = (project: string, network: string) => {
  if (network.startsWith("https://") || network.startsWith("http://")) {
    return network;
  }
  if (network.includes("/")) {
    const path = network.replace(/^\//, "");
    return path.startsWith("compute/")
      ? `https://www.googleapis.com/${path}`
      : `https://www.googleapis.com/compute/v1/${path}`;
  }
  return `https://www.googleapis.com/compute/v1/projects/${project}/global/networks/${network}`;
};

const desiredNetworks = (project: string, networks: string[] | undefined) =>
  [
    ...new Set(
      (networks ?? []).map((network) => toNetworkUrl(project, network)),
    ),
  ].sort((left, right) => lastSegment(left).localeCompare(lastSegment(right)));

const observedNetworks = (zone: dns.ManagedZone) =>
  (zone.privateVisibilityConfig?.networks ?? [])
    .map((network) => network.networkUrl ?? "")
    .filter((url) => url.length > 0)
    .sort((left, right) => lastSegment(left).localeCompare(lastSegment(right)));

const sameNetworks = (left: string[], right: string[]) =>
  left.length === right.length &&
  left.every(
    (url, index) => lastSegment(url) === lastSegment(right[index] ?? ""),
  );

const toAttrs = (zone: dns.ManagedZone, project: string) => ({
  zoneName: zone.name ?? "",
  dnsName: zone.dnsName ?? "",
  project,
  id: zone.id,
  visibility: zone.visibility ?? DEFAULT_VISIBILITY,
  description:
    zone.description && zone.description.length > 0
      ? zone.description
      : undefined,
  labels: userLabels(zone.labels),
  enableLogging: zone.cloudLoggingConfig?.enableLogging === true,
  networks: observedNetworks(zone),
  nameServers: zone.nameServers ?? [],
  creationTime: zone.creationTime,
});

const getByName = (project: string, zoneName: string) =>
  dns
    .getManagedZones({ project, managedZone: zoneName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/** Cloud DNS operations and changes report `status: "pending" | "done"`. */
const asLongRunning = (value: {
  id?: string;
  status?: string;
}): LongRunningOperation => ({ name: value.id, done: isDone(value.status) });

/** Zone updates and record changes propagate within a few minutes. */
const DNS_BUDGET = "5 minutes";

const waitForOperation = (
  project: string,
  zoneName: string,
  operation: dns.Operation,
) =>
  waitForLongRunning(
    asLongRunning(operation),
    (operationId) =>
      dns
        .getManagedZoneOperations({
          project,
          managedZone: zoneName,
          operation: operationId,
        })
        .pipe(Effect.map(asLongRunning)),
    { budget: DNS_BUDGET, interval: "1 second" },
  );

const waitForChange = (project: string, zoneName: string, change: dns.Change) =>
  waitForLongRunning(
    asLongRunning(change),
    (changeId) =>
      dns
        .getChanges({ project, managedZone: zoneName, changeId })
        .pipe(Effect.map(asLongRunning)),
    { budget: DNS_BUDGET, interval: "1 second" },
  );

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

const emptyZone = (
  project: string,
  zoneName: string,
  dnsName: string | undefined,
) =>
  Effect.gen(function* () {
    const apex = dnsName ? normalizeDnsName(dnsName) : undefined;
    const extra = (yield* listRrsets(project, zoneName)).filter((rrset) => {
      const type = rrset.type ?? "";
      const name = rrset.name ?? "";
      if (
        apex !== undefined &&
        name === apex &&
        (type === "NS" || type === "SOA")
      ) {
        return false;
      }
      return true;
    });
    if (extra.length === 0) return;
    const change = yield* dns.createChanges({
      project,
      managedZone: zoneName,
      body: { deletions: extra },
    });
    yield* waitForChange(project, zoneName, change);
  });

const privateVisibilityConfig = (networks: string[]) =>
  networks.length === 0
    ? undefined
    : {
        networks: networks.map((networkUrl) => ({ networkUrl })),
      };

export const ManagedZoneProvider = () =>
  Provider.succeed(ManagedZone, {
    stables: [
      "zoneName",
      "dnsName",
      "project",
      "id",
      "visibility",
      "nameServers",
      "creationTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName = olds?.zoneName ?? output?.zoneName;
      const nextName = news.zoneName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousDns = olds?.dnsName ?? output?.dnsName;
      const nextDns =
        news.dnsName !== undefined
          ? normalizeDnsName(news.dnsName)
          : previousDns !== undefined
            ? normalizeDnsName(previousDns)
            : undefined;
      const dnsChanged =
        previousDns !== undefined &&
        nextDns !== undefined &&
        normalizeDnsName(previousDns) !== nextDns;

      const previousVisibility = normalizeVisibility(
        olds?.visibility ?? output?.visibility,
      );
      const nextVisibility = normalizeVisibility(
        news.visibility ?? previousVisibility,
      );
      const visibilityChanged = previousVisibility !== nextVisibility;

      if (!nameChanged && !dnsChanged && !visibilityChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName !== undefined &&
          nextName === previousName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const zoneName = yield* toZoneName(id, olds?.zoneName, output?.zoneName);
      const existing = yield* getByName(env.project, zoneName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* dns.listManagedZones({
            project: env.project,
            maxResults: 1000,
            pageToken,
          });
          for (const zone of response.managedZones ?? []) {
            if (
              Object.keys(zone.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              )
            ) {
              found.push(toAttrs(zone, env.project));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const zoneName = yield* toZoneName(id, news.zoneName, output?.zoneName);
      const dnsName = toDnsName(zoneName, news.dnsName, output?.dnsName);
      const visibility = normalizeVisibility(
        news.visibility ?? output?.visibility,
      );
      const description = news.description ?? "";
      const enableLogging = news.enableLogging === true;
      const networks =
        visibility === "private"
          ? desiredNetworks(env.project, news.networks)
          : [];
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, zoneName);

      if (current === undefined) {
        const created = yield* dns
          .createManagedZones({
            project: env.project,
            body: {
              name: zoneName,
              dnsName,
              description,
              visibility,
              labels: desiredLabels,
              cloudLoggingConfig: { enableLogging },
              privateVisibilityConfig: privateVisibilityConfig(networks),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => getByName(env.project, zoneName)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ManagedZoneNotResolved({ zoneName });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged = (current.description ?? "") !== description;
      const loggingChanged =
        (current.cloudLoggingConfig?.enableLogging === true) !== enableLogging;
      const networksChanged =
        visibility === "private" &&
        !sameNetworks(observedNetworks(current), networks);

      if (
        labelsChanged ||
        descriptionChanged ||
        loggingChanged ||
        networksChanged
      ) {
        const body: dns.ManagedZone = {};
        if (labelsChanged) body.labels = desiredLabels;
        if (descriptionChanged) body.description = description;
        if (loggingChanged) {
          body.cloudLoggingConfig = { enableLogging };
        }
        if (networksChanged) {
          body.privateVisibilityConfig = privateVisibilityConfig(networks);
        }
        const operation = yield* dns.patchManagedZones({
          project: env.project,
          managedZone: zoneName,
          body,
        });
        yield* waitForOperation(env.project, zoneName, operation);
        current = (yield* getByName(env.project, zoneName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const mayEmpty = olds.forceDestroy === true || force === true;
      const project = output.project;
      const zoneName = output.zoneName;
      if (mayEmpty) {
        yield* emptyZone(project, zoneName, output.dnsName);
      }
      const attempt = dns
        .deleteManagedZones({ project, managedZone: zoneName })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* attempt.pipe(
        Effect.catchIf(
          (error) =>
            mayEmpty &&
            (error._tag === "Conflict" || error._tag === "BadRequest"),
          () =>
            emptyZone(project, zoneName, output.dnsName).pipe(
              Effect.andThen(attempt),
            ),
        ),
      );
    }),
  });
