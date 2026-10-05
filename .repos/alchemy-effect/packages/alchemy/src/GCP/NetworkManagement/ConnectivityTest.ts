import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_GLOBAL,
  MAX_CONNECTIVITY_TEST_ID_LENGTH,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName as qualifiedName,
  rfc1035,
  sameJson,
  sameStringList,
  toNetworkResource,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "connectivityTests";
const DEFAULT_PROTOCOL = "TCP";

export type ConnectivityTestNetworkType =
  | networkmanagement.EndpointNetworkTypeEnum
  | (string & {});

export type ConnectivityTestEndpoint = {
  /** IP address of the endpoint (internal or external). */
  ipAddress?: string;
  /** TCP or UDP port. Ignored for other protocols. */
  port?: number;
  /** Compute Engine instance URI. */
  instance?: string;
  /**
   * Forwarding rule URI. Destination only. Format
   * `projects/{project}/global/forwardingRules/{id}` or
   * `projects/{project}/regions/{region}/forwardingRules/{id}`.
   */
  forwardingRule?: string;
  /** GKE control-plane cluster URI. */
  gkeMasterCluster?: string;
  /**
   * GKE control-plane DNS endpoint. Requires `gkeMasterCluster`.
   * Destination only; cannot be combined with `ipAddress` or `network`.
   */
  fqdn?: string;
  /** Cloud SQL instance URI. */
  cloudSqlInstance?: string;
  /** Memorystore Redis instance URI. Destination only. */
  redisInstance?: string;
  /** Memorystore Redis cluster URI. Destination only. */
  redisCluster?: string;
  /** GKE Pod URI. */
  gkePod?: string;
  /**
   * Database Migration Service private connection. Format
   * `projects/{project}/locations/{location}/privateConnections/{privateConnection}`.
   */
  dmsPrivateConnection?: string;
  /** Cloud Function. Source only. */
  cloudFunction?: { uri?: string };
  /** App Engine service version. Source only. */
  appEngineVersion?: { uri?: string };
  /** Cloud Run revision. Source only. */
  cloudRunRevision?: { uri?: string };
  /**
   * Cloud Run job URI. Source only. Format
   * `projects/{project}/locations/{location}/jobs/{job}`.
   */
  cloudRunJob?: string;
  /**
   * VPC network URI. For sources, used with `networkType`. For
   * destinations, used when the source is external and the destination
   * is internal.
   */
  network?: string;
  /** Type of network where the source endpoint lives. Source only. */
  networkType?: ConnectivityTestNetworkType;
  /** Source endpoint project id. Source only. */
  projectId?: string;
};

export type ConnectivityTestProps = {
  /**
   * Test id (the `{test}` segment of
   * `projects/{project}/locations/global/connectivityTests/{test}`). If
   * omitted, a unique RFC1035 name is generated. Must be 1-40 characters,
   * start with a letter, and end with a letter or number. Immutable —
   * changing it replaces the test.
   */
  testId?: string;
  /**
   * Location. Must be `global`. Immutable — changing it replaces the
   * test.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 512 characters).
   */
  description?: string;
  /**
   * Source endpoint. Combine IP, URI, project, and VPC network to
   * identify the origin.
   */
  source: ConnectivityTestEndpoint;
  /**
   * Destination endpoint. Combine IP, URI, project, and VPC network to
   * identify the target.
   */
  destination: ConnectivityTestEndpoint;
  /**
   * IP protocol. When omitted, `TCP` is assumed.
   * @default "TCP"
   */
  protocol?: string;
  /**
   * Other projects that may be relevant for reachability analysis when
   * the path crosses project boundaries.
   */
  relatedProjects?: string[];
  /**
   * Also analyze the return path from destination to source.
   * @default false
   */
  roundTrip?: boolean;
  /**
   * Skip firewall checking during analysis.
   * @default false
   */
  bypassFirewallChecks?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ConnectivityTest = Resource<
  "GCP.NetworkManagement.ConnectivityTest",
  ConnectivityTestProps,
  {
    /** Full resource name `projects/{project}/locations/global/connectivityTests/{test}`. */
    name: string;
    /** Test id (last path segment). */
    testId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Source endpoint as stored by the API. */
    source: ConnectivityTestEndpoint | undefined;
    /** Destination endpoint as stored by the API. */
    destination: ConnectivityTestEndpoint | undefined;
    /** IP protocol. */
    protocol: string | undefined;
    /** Related projects considered during analysis. */
    relatedProjects: string[];
    /** Server-generated display name. */
    displayName: string | undefined;
    /** Whether return-path analysis is enabled. */
    roundTrip: boolean;
    /** Whether firewall checking is skipped. */
    bypassFirewallChecks: boolean;
    /** Latest forward-path reachability result. */
    reachabilityResult: string | undefined;
    /** Latest return-path reachability result. */
    returnReachabilityResult: string | undefined;
    /** Latest probing result, when probing applied. */
    probingResult: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Management Connectivity Test (reachability analysis).
 *
 * Changing `testId` or `location` replaces the test. Endpoints,
 * protocol, related projects, round-trip, firewall bypass, description,
 * and labels update in place. Create runs analysis as part of the
 * long-running operation.
 *
 * ### Creating a ConnectivityTest
 * **Example:** IP-to-IP TCP test
 * ```typescript
 * const test = yield* GCP.NetworkManagement.ConnectivityTest("DnsPath", {
 *   source: {
 *     ipAddress: "10.0.0.1",
 *     networkType: "GCP_NETWORK",
 *     network: "projects/my-project/global/networks/app-vpc",
 *   },
 *   destination: { ipAddress: "10.0.0.2", port: 443 },
 *   protocol: "TCP",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Named test with round trip
 * ```typescript
 * const test = yield* GCP.NetworkManagement.ConnectivityTest("DnsPath", {
 *   testId: "app-dns-path",
 *   source: { ipAddress: "8.8.8.8", networkType: "NON_GCP_NETWORK" },
 *   destination: { ipAddress: "1.1.1.1", port: 443 },
 *   protocol: "TCP",
 *   roundTrip: true,
 *   description: "public dns path",
 * });
 * ```
 *
 * @resource
 * @category NetworkManagement
 */
export const ConnectivityTest = Resource<ConnectivityTest>(
  "GCP.NetworkManagement.ConnectivityTest",
);

const resourceName = (project: string, location: string, testId: string) =>
  qualifiedName(project, location, COLLECTION, testId);

const toEndpoint = (
  endpoint: ConnectivityTestEndpoint | networkmanagement.Endpoint | undefined,
  project?: string,
): ConnectivityTestEndpoint | undefined => {
  if (endpoint === undefined) return undefined;
  const next: ConnectivityTestEndpoint = {
    ipAddress: endpoint.ipAddress,
    port: endpoint.port,
    instance: endpoint.instance,
    forwardingRule: endpoint.forwardingRule,
    gkeMasterCluster: endpoint.gkeMasterCluster,
    fqdn: endpoint.fqdn,
    cloudSqlInstance: endpoint.cloudSqlInstance,
    redisInstance: endpoint.redisInstance,
    redisCluster: endpoint.redisCluster,
    gkePod: endpoint.gkePod,
    dmsPrivateConnection: endpoint.dmsPrivateConnection,
    cloudFunction: endpoint.cloudFunction
      ? { uri: endpoint.cloudFunction.uri }
      : undefined,
    appEngineVersion: endpoint.appEngineVersion
      ? { uri: endpoint.appEngineVersion.uri }
      : undefined,
    cloudRunRevision: endpoint.cloudRunRevision
      ? { uri: endpoint.cloudRunRevision.uri }
      : undefined,
    cloudRunJob: endpoint.cloudRunJob,
    network:
      endpoint.network !== undefined && project !== undefined
        ? toNetworkResource(project, endpoint.network)
        : endpoint.network,
    networkType: endpoint.networkType,
    projectId: endpoint.projectId,
  };
  return next;
};

const endpointKey = (
  endpoint: ConnectivityTestEndpoint | undefined,
): unknown => {
  if (endpoint === undefined) return undefined;
  return {
    ipAddress: endpoint.ipAddress ?? "",
    port: endpoint.port ?? 0,
    instance: endpoint.instance ?? "",
    forwardingRule: endpoint.forwardingRule ?? "",
    gkeMasterCluster: endpoint.gkeMasterCluster ?? "",
    fqdn: endpoint.fqdn ?? "",
    cloudSqlInstance: endpoint.cloudSqlInstance ?? "",
    redisInstance: endpoint.redisInstance ?? "",
    redisCluster: endpoint.redisCluster ?? "",
    gkePod: endpoint.gkePod ?? "",
    dmsPrivateConnection: endpoint.dmsPrivateConnection ?? "",
    cloudFunction: endpoint.cloudFunction?.uri ?? "",
    appEngineVersion: endpoint.appEngineVersion?.uri ?? "",
    cloudRunRevision: endpoint.cloudRunRevision?.uri ?? "",
    cloudRunJob: endpoint.cloudRunJob ?? "",
    network: endpoint.network ?? "",
    networkType: (endpoint.networkType ?? "").toUpperCase(),
    projectId: endpoint.projectId ?? "",
  };
};

const toAttrs = (test: networkmanagement.ConnectivityTest, project: string) => {
  const name = test.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    testId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: test.description,
    source: toEndpoint(test.source, parsed.project || project),
    destination: toEndpoint(test.destination, parsed.project || project),
    protocol: test.protocol,
    relatedProjects: test.relatedProjects ?? [],
    displayName: test.displayName,
    roundTrip: test.roundTrip === true,
    bypassFirewallChecks: test.bypassFirewallChecks === true,
    reachabilityResult: test.reachabilityDetails?.result,
    returnReachabilityResult: test.returnReachabilityDetails?.result,
    probingResult: test.probingDetails?.result,
    labels: userLabels(test.labels),
    createTime: test.createTime,
    updateTime: test.updateTime,
  };
};

const getByName = (name: string) =>
  networkmanagement
    .getProjectsLocationsGlobalConnectivityTests({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ConnectivityTestProvider = () =>
  Provider.succeed(ConnectivityTest, {
    stables: ["name", "testId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.testId ?? output?.testId;
      const nextId = news.testId
        ? rfc1035(
            news.testId,
            "connectivity-test",
            MAX_CONNECTIVITY_TEST_ID_LENGTH,
          )
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const testId = yield* toPhysicalId(
        id,
        olds?.testId,
        output?.testId,
        "connectivity-test",
        MAX_CONNECTIVITY_TEST_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = output?.name ?? resourceName(env.project, location, testId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkmanagement.listProjectsLocationsGlobalConnectivityTests.pages({
            parent: parentOf(env.project, DEFAULT_GLOBAL),
            pageSize: 1000,
          }),
          (page) => page.resources,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const testId = yield* toPhysicalId(
        id,
        news.testId,
        output?.testId,
        "connectivity-test",
        MAX_CONNECTIVITY_TEST_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, testId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const source = toEndpoint(news.source, env.project);
      const destination = toEndpoint(news.destination, env.project);
      const protocol = news.protocol ?? DEFAULT_PROTOCOL;
      const relatedProjects = news.relatedProjects ?? [];
      const roundTrip = news.roundTrip === true;
      const bypassFirewallChecks = news.bypassFirewallChecks === true;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkmanagement
          .createProjectsLocationsGlobalConnectivityTests({
            parent: parentOf(env.project, location),
            testId,
            body: {
              description: news.description,
              labels: desiredLabels,
              source,
              destination,
              protocol,
              relatedProjects:
                relatedProjects.length > 0 ? relatedProjects : undefined,
              roundTrip,
              bypassFirewallChecks,
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
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const sourceChanged = !sameJson(
        endpointKey(toEndpoint(current.source, env.project)),
        endpointKey(source),
      );
      const destinationChanged = !sameJson(
        endpointKey(toEndpoint(current.destination, env.project)),
        endpointKey(destination),
      );
      const protocolChanged =
        (current.protocol ?? DEFAULT_PROTOCOL).toUpperCase() !==
        protocol.toUpperCase();
      const relatedChanged = !sameStringList(
        current.relatedProjects,
        relatedProjects,
      );
      const roundTripChanged = (current.roundTrip === true) !== roundTrip;
      const bypassChanged =
        (current.bypassFirewallChecks === true) !== bypassFirewallChecks;

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["source", sourceChanged],
        ["destination", destinationChanged],
        ["protocol", protocolChanged],
        ["relatedProjects", relatedChanged],
        ["roundTrip", roundTripChanged],
        ["bypassFirewallChecks", bypassChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkmanagement.patchProjectsLocationsGlobalConnectivityTests(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                source,
                destination,
                protocol,
                relatedProjects,
                roundTrip,
                bypassFirewallChecks,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkmanagement
        .deleteProjectsLocationsGlobalConnectivityTests({ name: output.name })
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
