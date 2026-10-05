import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as servicenetworking from "@distilled.cloud/gcp/servicenetworking_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation as waitForLongRunning } from "../Operation.ts";

const DEFAULT_SERVICE = "servicenetworking.googleapis.com";
const DEFAULT_PEERING = "servicenetworking-googleapis-com";

export type ConnectionProps = {
  /**
   * Consumer VPC network. Accepts a name (`main`), a resource path
   * (`projects/{project}/global/networks/{network}`), or a Compute
   * self-link. Immutable — changing it replaces the connection.
   */
  network: string;
  /**
   * Peering service that manages producer connectivity. For Google
   * services this is `servicenetworking.googleapis.com`. A `services/`
   * prefix is accepted. Immutable — changing it replaces the connection.
   * @default "servicenetworking.googleapis.com"
   */
  service?: string;
  /**
   * Names of allocated `VPC_PEERING` global addresses reserved for this
   * producer. Updating the list PATCHes the connection (`force` is sent
   * when a previously allocated range is dropped).
   */
  reservedPeeringRanges: string[];
  /**
   * When `ABANDON`, destroy removes the resource from state without
   * calling the API. Use this when Cloud SQL (or another managed
   * service) still depends on the peering.
   */
  deletionPolicy?: "ABANDON" | "DELETE" | (string & {});
};

export type Connection = Resource<
  "GCP.ServiceNetworking.Connection",
  ConnectionProps,
  {
    /**
     * Consumer network path
     * `projects/{projectNumber}/global/networks/{network}`.
     */
    network: string;
    /** VPC network id (last path segment). */
    networkName: string;
    /** Peering service, as `services/{service}`. */
    service: string;
    /** VPC Network Peering name created by the producer. */
    peering: string;
    /** Allocated IP range names assigned to this connection. */
    reservedPeeringRanges: ReadonlyArray<string>;
    /**
     * Resource name
     * `services/{service}/connections/{peering}`.
     */
    name: string;
    /** Project id. */
    project: string;
    /** Numeric project used in Service Networking paths. */
    projectNumber: string;
  },
  never,
  Providers
>;

/**
 * A private services access connection (VPC Network Peering to a
 * Google or third-party service producer).
 *
 * The API has no labels or description. Alchemy treats existence at
 * `(network, service)` as ownership. `list` returns connections whose
 * consumer VPC carries Alchemy ownership markers so `pnpm nuke:gcp`
 * can still clean leaks.
 *
 * `network` and `service` are immutable. `reservedPeeringRanges`
 * update in place.
 *
 * ### Creating a Connection
 * **Example:** Private services access on a VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const range = yield* GCP.Compute.GlobalAddress("PsaRange", {
 *   addressType: "INTERNAL",
 *   purpose: "VPC_PEERING",
 *   network: network.selfLink,
 *   prefixLength: 24,
 * });
 * const connection = yield* GCP.ServiceNetworking.Connection("Psa", {
 *   network: network.networkName,
 *   reservedPeeringRanges: [range.addressName],
 * });
 * ```
 *
 * **Example:** Explicit service and additional ranges
 * ```typescript
 * const connection = yield* GCP.ServiceNetworking.Connection("Psa", {
 *   network: network.networkName,
 *   service: "servicenetworking.googleapis.com",
 *   reservedPeeringRanges: [range.addressName, extra.addressName],
 * });
 * ```
 *
 * @resource
 * @category ServiceNetworking
 */
export const Connection = Resource<Connection>(
  "GCP.ServiceNetworking.Connection",
);

export class ConnectionNotResolved extends Data.TaggedError(
  "GCP.ServiceNetworking.ConnectionNotResolved",
)<{
  network: string;
  service: string;
}> {}

export class ConnectionNetworkMissing extends Data.TaggedError(
  "GCP.ServiceNetworking.ConnectionNetworkMissing",
)<{
  message: string;
}> {}

export class ConnectionRangesMissing extends Data.TaggedError(
  "GCP.ServiceNetworking.ConnectionRangesMissing",
)<{
  network: string;
  message: string;
}> {}

export class ConnectionProjectNumberMissing extends Data.TaggedError(
  "GCP.ServiceNetworking.ConnectionProjectNumberMissing",
)<{
  project: string;
}> {}

export class ConnectionStillExists extends Data.TaggedError(
  "GCP.ServiceNetworking.ConnectionStillExists",
)<{
  network: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const linkKey = (value: string | undefined) =>
  value === undefined || value === "" ? "" : lastSegment(value).toLowerCase();

const stripServicesPrefix = (service: string) =>
  service.startsWith("services/") ? service.slice("services/".length) : service;

const parentServiceOf = (service: string | undefined) =>
  `services/${stripServicesPrefix(service || DEFAULT_SERVICE)}`;

const serviceIdOf = (service: string | undefined) =>
  stripServicesPrefix(service || DEFAULT_SERVICE);

const consumerNetworkOf = (projectNumber: string, networkName: string) =>
  `projects/${projectNumber}/global/networks/${networkName}`;

const connectionNameOf = (parent: string, peering: string | undefined) =>
  `${parent}/connections/${peering && peering.length > 0 ? peering : "-"}`;

const rangeNamesOf = (ranges: readonly string[] | undefined) =>
  [...(ranges ?? [])]
    .map((range) => lastSegment(range))
    .filter((range) => range.length > 0);

const rangesKey = (ranges: readonly string[] | undefined) =>
  [...rangeNamesOf(ranges)].sort().join("\n");

const isAlchemyNetwork = (network: compute.Network) =>
  (network.description ?? "").includes("alchemy-id=");

const toAttrs = (
  connection: servicenetworking.Connection,
  project: string,
  projectNumber: string,
  fallbackNetwork: string,
  fallbackService: string,
) => {
  const network = connection.network ?? fallbackNetwork;
  const service = connection.service ?? parentServiceOf(fallbackService);
  const peering = connection.peering ?? DEFAULT_PEERING;
  return {
    network,
    networkName: lastSegment(network),
    service,
    peering,
    reservedPeeringRanges: connection.reservedPeeringRanges ?? [],
    name: connectionNameOf(parentServiceOf(service), peering),
    project,
    projectNumber,
  };
};

const getProjectNumber = (project: string) =>
  Effect.gen(function* () {
    if (/^\d+$/.test(project)) return project;
    const resource = yield* resourcemanager.getProjects({
      name: `projects/${project}`,
    });
    const number = lastSegment(resource.name ?? "");
    if (!/^\d+$/.test(number)) {
      return yield* new ConnectionProjectNumberMissing({ project });
    }
    return number;
  });

const listForNetwork = (parent: string, consumerNetwork: string) =>
  servicenetworking
    .listServicesConnections({
      parent,
      network: consumerNetwork,
    })
    .pipe(
      Effect.map((page) => page.connections ?? []),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as servicenetworking.Connection[]),
      ),
    );

const getByNetwork = (parent: string, consumerNetwork: string) =>
  listForNetwork(parent, consumerNetwork).pipe(
    Effect.map((connections): servicenetworking.Connection | undefined => {
      if (connections.length === 0) {
        return undefined;
      }
      const match = connections.find(
        (connection) =>
          linkKey(connection.network) === linkKey(consumerNetwork) ||
          connections.length === 1,
      );
      return match ?? connections[0];
    }),
  );

/**
 * Wait for a Service Networking operation. Peering changes settle within a
 * few minutes. `ALREADY_EXISTS` always succeeds; `notFoundOk` accepts
 * `NOT_FOUND` (deletes) and `ignoreRangeConflict` accepts
 * `FAILED_PRECONDITION` (another writer already changed the ranges).
 */
const waitForOperation = (
  operation: servicenetworking.Operation,
  options?: { notFoundOk?: boolean; ignoreRangeConflict?: boolean },
) =>
  waitForLongRunning(
    operation,
    (name) => servicenetworking.getOperations({ name }),
    { budget: "10 minutes" },
  ).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "GCP.OperationFailed" &&
        (error.code === 6 ||
          (options?.notFoundOk === true && error.code === 5) ||
          (options?.ignoreRangeConflict === true && error.code === 9)),
      () => Effect.void,
    ),
    Effect.catchIf(
      (error) => options?.notFoundOk === true && error._tag === "NotFound",
      () => Effect.void,
    ),
  );

const waitUntilPresent = (parent: string, consumerNetwork: string) =>
  getByNetwork(parent, consumerNetwork).pipe(
    Effect.filterOrFail(
      (connection): connection is servicenetworking.Connection =>
        connection !== undefined,
      () =>
        new ConnectionNotResolved({
          network: consumerNetwork,
          service: parent,
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ServiceNetworking.ConnectionNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (parent: string, consumerNetwork: string) =>
  getByNetwork(parent, consumerNetwork).pipe(
    Effect.flatMap((connection) =>
      connection === undefined
        ? Effect.void
        : Effect.fail(
            new ConnectionStillExists({
              network: consumerNetwork,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ServiceNetworking.ConnectionStillExists",
      times: 10,
      schedule: Schedule.spaced("8 seconds"),
    }),
  );

const patchRanges = (
  parent: string,
  peering: string | undefined,
  consumerNetwork: string,
  ranges: readonly string[],
) =>
  Effect.gen(function* () {
    const operation = yield* servicenetworking.patchServicesConnections({
      name: connectionNameOf(parent, peering),
      updateMask: "reservedPeeringRanges",
      force: true,
      body: {
        network: consumerNetwork,
        reservedPeeringRanges: [...ranges],
      },
    });
    yield* waitForOperation(operation);
  });

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "network",
      "networkName",
      "service",
      "peering",
      "name",
      "project",
      "projectNumber",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousNetwork = linkKey(olds?.network ?? output?.network);
      const nextNetwork = linkKey(news.network ?? output?.network);
      const previousService = serviceIdOf(olds?.service ?? output?.service);
      const nextService = serviceIdOf(news.service ?? output?.service);
      if (
        (previousNetwork.length > 0 && nextNetwork !== previousNetwork) ||
        (output?.service !== undefined && nextService !== previousService)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkName = lastSegment(
        olds?.network ?? output?.networkName ?? output?.network ?? "",
      );
      if (networkName.length === 0) return undefined;
      const parent = parentServiceOf(olds?.service ?? output?.service);
      const projectNumber =
        output?.projectNumber ?? (yield* getProjectNumber(env.project));
      const consumerNetwork = consumerNetworkOf(projectNumber, networkName);
      const existing = yield* getByNetwork(parent, consumerNetwork);
      if (existing === undefined) return undefined;
      // Connections have no labels. Existence at (network, service) is
      // ownership — the API allows only one PSA peering per pair.
      return toAttrs(
        existing,
        env.project,
        projectNumber,
        consumerNetwork,
        parent,
      );
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const projectNumber = yield* getProjectNumber(env.project);
        const networks = yield* compute.listNetworks
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter(isAlchemyNetwork),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const pages = yield* Effect.forEach(
          networks,
          (network) => {
            const networkName = network.name;
            if (!networkName) {
              return Effect.succeed([] as ReturnType<typeof toAttrs>[]);
            }
            const consumerNetwork = consumerNetworkOf(
              projectNumber,
              networkName,
            );
            return listForNetwork("services/-", consumerNetwork).pipe(
              Effect.map((connections) =>
                connections.map((connection) =>
                  toAttrs(
                    connection,
                    env.project,
                    projectNumber,
                    consumerNetwork,
                    connection.service ?? DEFAULT_SERVICE,
                  ),
                ),
              ),
            );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkName = lastSegment(news.network ?? output?.network ?? "");
      if (networkName.length === 0) {
        return yield* new ConnectionNetworkMissing({
          message:
            "Service Networking connections require `network` (VPC name or URL).",
        });
      }
      const parent = parentServiceOf(news.service ?? output?.service);
      const projectNumber =
        output?.projectNumber ?? (yield* getProjectNumber(env.project));
      const consumerNetwork = consumerNetworkOf(projectNumber, networkName);
      const desiredRanges = rangeNamesOf(news.reservedPeeringRanges);

      let current = yield* getByNetwork(parent, consumerNetwork);

      if (current === undefined) {
        if (desiredRanges.length === 0) {
          return yield* new ConnectionRangesMissing({
            network: consumerNetwork,
            message:
              "Service Networking connections require `reservedPeeringRanges`.",
          });
        }
        const created = yield* servicenetworking
          .createServicesConnections({
            parent,
            body: {
              network: consumerNetwork,
              reservedPeeringRanges: [...desiredRanges],
            },
          })
          .pipe(
            Effect.catchTag(["Conflict", "ConnectionAlreadyExists"], () =>
              Effect.succeed(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created, { ignoreRangeConflict: true });
        }
        current = yield* waitUntilPresent(parent, consumerNetwork).pipe(
          Effect.catchTag("GCP.ServiceNetworking.ConnectionNotResolved", () =>
            Effect.succeed(undefined),
          ),
        );
        if (
          current !== undefined &&
          desiredRanges.length > 0 &&
          rangesKey(current.reservedPeeringRanges) !== rangesKey(desiredRanges)
        ) {
          yield* patchRanges(
            parent,
            current.peering,
            consumerNetwork,
            desiredRanges,
          ).pipe(
            Effect.catchTag(
              ["Conflict", "ConnectionAlreadyExists"],
              () => Effect.void,
            ),
          );
          current = yield* waitUntilPresent(parent, consumerNetwork).pipe(
            Effect.catchTag("GCP.ServiceNetworking.ConnectionNotResolved", () =>
              Effect.succeed(undefined),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new ConnectionNotResolved({
          network: consumerNetwork,
          service: parent,
        });
      }

      if (
        desiredRanges.length > 0 &&
        rangesKey(current.reservedPeeringRanges) !== rangesKey(desiredRanges)
      ) {
        yield* patchRanges(
          parent,
          current.peering,
          consumerNetwork,
          desiredRanges,
        );
        current = yield* waitUntilPresent(parent, consumerNetwork);
      }

      if (current === undefined) {
        return yield* new ConnectionNotResolved({
          network: consumerNetwork,
          service: parent,
        });
      }

      return toAttrs(
        current,
        env.project,
        projectNumber,
        consumerNetwork,
        parent,
      );
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      if ((olds?.deletionPolicy ?? "DELETE").toUpperCase() === "ABANDON") {
        return;
      }
      const parent = parentServiceOf(output.service);
      const consumerNetwork = output.network;
      const operation = yield* servicenetworking
        .deleteConnectionServicesConnections({
          name: output.name || connectionNameOf(parent, output.peering),
          body: { consumerNetwork },
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("8 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(parent, consumerNetwork);
    }),
  });
