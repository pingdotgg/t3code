import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandParent,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_PURPOSE = "CLIENT_SUBNET" satisfies oracle.OdbSubnetPurposeEnum;

export type OdbNetworksOdbSubnetProps = {
  /**
   * Parent ODB Network. Full name
   * `projects/{project}/locations/{location}/odbNetworks/{odb_network}`
   * or the network id (combined with `location`). Immutable — changing
   * it replaces the subnet.
   */
  odbNetwork: string;
  /**
   * Region used when `odbNetwork` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * ODB Subnet id (the `{odb_subnet}` segment of
   * `.../odbNetworks/{odb_network}/odbSubnets/{odb_subnet}`). If omitted,
   * a unique RFC1035 name is generated. Immutable — changing it
   * replaces the subnet.
   */
  odbSubnetId?: string;
  /**
   * CIDR range of the subnet. Must be RFC1918 and between `/27` and
   * `/22`. Immutable — changing it replaces the subnet.
   */
  cidrRange: string;
  /**
   * Subnet purpose. `CLIENT_SUBNET` is used by databases and GoldenGate;
   * `BACKUP_SUBNET` is used by Exadata VM Clusters. Immutable —
   * changing it replaces the subnet.
   * @default "CLIENT_SUBNET"
   */
  purpose?: oracle.OdbSubnetPurposeEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OdbNetworksOdbSubnet = Resource<
  "GCP.OracleDatabase.OdbNetworksOdbSubnet",
  OdbNetworksOdbSubnetProps,
  {
    /** Full resource name. */
    name: string;
    /** ODB Subnet id (last path segment). */
    odbSubnetId: string;
    /** Parent ODB Network resource name. */
    odbNetwork: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** CIDR range. */
    cidrRange: string | undefined;
    /** Subnet purpose. */
    purpose: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Database@Google Cloud ODB Subnet inside an ODB Network.
 *
 * Changing `odbNetwork`, `odbSubnetId`, `location`, `cidrRange`, or
 * `purpose` replaces the subnet. Labels are set at create; the API has
 * no update. Requires an Oracle Database@Google Cloud entitlement and
 * a parent ODB Network.
 *
 * ### Creating an ODB Subnet
 * **Example:** Client subnet under an ODB Network
 * ```typescript
 * const subnet = yield* GCP.OracleDatabase.OdbNetworksOdbSubnet("Client", {
 *   odbNetwork: net.name,
 *   cidrRange: "10.250.0.0/27",
 *   purpose: "CLIENT_SUBNET",
 * });
 * ```
 *
 * **Example:** Backup subnet with labels
 * ```typescript
 * const subnet = yield* GCP.OracleDatabase.OdbNetworksOdbSubnet("Backup", {
 *   odbNetwork: net.name,
 *   cidrRange: "10.250.0.32/27",
 *   purpose: "BACKUP_SUBNET",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const OdbNetworksOdbSubnet = Resource<OdbNetworksOdbSubnet>(
  "GCP.OracleDatabase.OdbNetworksOdbSubnet",
);

const desiredPurpose = (purpose: string | undefined) =>
  (purpose ?? DEFAULT_PURPOSE).toUpperCase();

const networkOf = (odbNetwork: string, project: string, location: string) =>
  expandParent(odbNetwork, project, location, "odbNetworks");

const resourceName = (odbNetwork: string, odbSubnetId: string) =>
  `${odbNetwork}/odbSubnets/${odbSubnetId}`;

const toAttrs = (subnet: oracle.OdbSubnet, project: string) => {
  const name = subnet.name ?? "";
  const parsed = parseName(name, "odbSubnets");
  return {
    name,
    odbSubnetId: parsed.id,
    odbNetwork: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    cidrRange: subnet.cidrRange,
    purpose: subnet.purpose,
    labels: userLabels(subnet.labels),
    state: subnet.state,
    createTime: subnet.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : oracle
        .getProjectsLocationsOdbNetworksOdbSubnets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listSubnets = (parent: string) =>
  oracle.listProjectsLocationsOdbNetworksOdbSubnets
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.odbSubnets ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as oracle.OdbSubnet[]),
      ),
    );

const listOwned = (project: string, region: string) =>
  Effect.gen(function* () {
    const wildcard = yield* listSubnets(
      `projects/${project}/locations/-/odbNetworks/-`,
    );
    const labeledWildcard = wildcard.filter((item) =>
      hasAlchemyLabelMap(item.labels),
    );
    if (labeledWildcard.length > 0) return labeledWildcard;

    const networks = yield* listAtLocation(project, region, (parent) =>
      oracle.listProjectsLocationsOdbNetworks
        .pages({ parent, pageSize: 1000 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.odbNetworks ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        ),
    );
    const nested = yield* Effect.forEach(
      networks,
      (network) =>
        network.name
          ? listSubnets(network.name)
          : Effect.succeed([] as oracle.OdbSubnet[]),
      { concurrency: 4 },
    );
    return nested.flat().filter((item) => hasAlchemyLabelMap(item.labels));
  });

export const OdbNetworksOdbSubnetProvider = () =>
  Provider.succeed(OdbNetworksOdbSubnet, {
    stables: [
      "name",
      "odbSubnetId",
      "odbNetwork",
      "project",
      "location",
      "cidrRange",
      "purpose",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousPurpose = desiredPurpose(olds?.purpose ?? output?.purpose);
      const nextPurpose = desiredPurpose(news.purpose ?? previousPurpose);
      const previousCidr = olds?.cidrRange ?? output?.cidrRange ?? "";
      const nextCidr = news.cidrRange ?? previousCidr;
      return replaceOnIdentity({
        previousId: olds?.odbSubnetId ?? output?.odbSubnetId,
        nextId: news.odbSubnetId ?? olds?.odbSubnetId ?? output?.odbSubnetId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        previousParent: olds?.odbNetwork ?? output?.odbNetwork,
        nextParent: news.odbNetwork ?? olds?.odbNetwork ?? output?.odbNetwork,
        extra: previousPurpose !== nextPurpose || previousCidr !== nextCidr,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const odbNetwork = networkOf(
        olds?.odbNetwork ?? output?.odbNetwork ?? "",
        env.project,
        location,
      );
      const odbSubnetId = yield* toPhysicalId(
        id,
        olds?.odbSubnetId,
        output?.odbSubnetId,
        "odbsubnet",
      );
      const name = output?.name ?? resourceName(odbNetwork, odbSubnetId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const odbNetwork = networkOf(news.odbNetwork, env.project, location);
      const odbSubnetId = yield* toPhysicalId(
        id,
        news.odbSubnetId,
        output?.odbSubnetId,
        "odbsubnet",
      );
      const name = resourceName(odbNetwork, odbSubnetId);
      const purpose = desiredPurpose(news.purpose);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsOdbNetworksOdbSubnets({
            parent: odbNetwork,
            odbSubnetId,
            body: {
              cidrRange: news.cidrRange,
              purpose,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* oracle
        .deleteProjectsLocationsOdbNetworksOdbSubnets({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
