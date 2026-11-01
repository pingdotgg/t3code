import * as backupdr from "@distilled.cloud/gcp/backupdr_v1";
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
  fingerprint,
  listAtLocation,
  listLabeledPages,
  networkName,
  normalizeLocation,
  parentOf,
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

export type NetworkConfig = {
  /**
   * VPC network the management server is connected to. Full name
   * `projects/{project}/global/networks/{network}` or a network id.
   */
  network?: string;
  /**
   * Peering mode. Only `PRIVATE_SERVICE_ACCESS` is supported.
   */
  peeringMode?: backupdr.NetworkConfigPeeringModeEnum | (string & {});
};

export type ManagementURI = {
  /** AGM/RD Web UI URL. */
  webUi?: string;
  /** AGM/RD API URL. */
  api?: string;
};

export type WorkforceIdentityBasedManagementURI = {
  /** Third-party management URI. */
  thirdPartyManagementUri?: string;
  /** First-party management URI. */
  firstPartyManagementUri?: string;
};

export type WorkforceIdentityBasedOAuth2ClientID = {
  /** First-party OAuth client id. */
  firstPartyOauth2ClientId?: string;
  /** Third-party OAuth client id. */
  thirdPartyOauth2ClientId?: string;
};

export type ManagementServerProps = {
  /**
   * Management server id (the `{managementServer}` segment of
   * `projects/{project}/locations/{location}/managementServers/{managementServer}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the server.
   */
  managementServerId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the server. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Instance type. Immutable — changing it replaces the server.
   * @default "BACKUP_RESTORE"
   */
  type?: backupdr.ManagementServerTypeEnum | (string & {});
  /**
   * VPC networks the server is connected to. Only a single network is
   * supported. Optional when created without Private Service Access.
   * Immutable — changing it replaces the server.
   */
  networks?: NetworkConfig[];
  /**
   * Human-readable description (2048 characters or less). Set at create;
   * the API has no patch method.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Set at create; the API has no patch method.
   */
  labels?: Record<string, string>;
};

export type ManagementServer = Resource<
  "GCP.BackupDR.ManagementServer",
  ManagementServerProps,
  {
    /** Full resource name. */
    name: string;
    /** Management server id (last path segment). */
    managementServerId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Instance type. */
    type: string | undefined;
    /** Connected VPC networks. */
    networks: NetworkConfig[];
    /** Human-readable description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** OAuth 2.0 client id for the management API. */
    oauth2ClientId: string | undefined;
    /** Management URIs. */
    managementUri: ManagementURI | undefined;
    /** Workforce-identity management URIs. */
    workforceIdentityBasedManagementUri:
      | WorkforceIdentityBasedManagementURI
      | undefined;
    /** Workforce-identity OAuth client ids. */
    workforceIdentityBasedOauth2ClientId:
      | WorkforceIdentityBasedOAuth2ClientID
      | undefined;
    /** BA proxy URIs. */
    baProxyUri: string[];
    /** Server-reported state. */
    state: string | undefined;
    /** Assured Workloads PZI. */
    satisfiesPzi: boolean | undefined;
    /** Assured Workloads PZS. */
    satisfiesPzs: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Backup and DR management console (ManagementServer). Provisioning is
 * slow (tens of minutes) and typically limited to one console per region.
 *
 * There is no patch API — labels, description, type, and networks are
 * set at create. Changing `managementServerId`, `location`, `type`, or
 * `networks` replaces the server.
 *
 * ### Creating a Management Server
 * **Example:** Generated name, default network
 * ```typescript
 * const server = yield* GCP.BackupDR.ManagementServer("Console", {
 *   networks: [{ network: "default", peeringMode: "PRIVATE_SERVICE_ACCESS" }],
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const server = yield* GCP.BackupDR.ManagementServer("Console", {
 *   managementServerId: "backup-console",
 *   type: "BACKUP_RESTORE",
 *   description: "primary management console",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category BackupDR
 */
export const ManagementServer = Resource<ManagementServer>(
  "GCP.BackupDR.ManagementServer",
);

const resourceName = (
  project: string,
  location: string,
  managementServerId: string,
) =>
  `projects/${project}/locations/${location}/managementServers/${managementServerId}`;

const toNetworks = (
  project: string,
  networks: readonly NetworkConfig[] | undefined,
): NetworkConfig[] | undefined => {
  if (networks === undefined) return undefined;
  return networks.map((network) => ({
    network: networkName(project, network.network),
    peeringMode: network.peeringMode,
  }));
};

const fromNetworks = (
  networks: readonly backupdr.NetworkConfig[] | undefined,
): NetworkConfig[] =>
  (networks ?? []).map((network) => ({
    network: network.network,
    peeringMode: network.peeringMode,
  }));

const toAttrs = (
  item: backupdr.ManagementServer,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "managementServers", region);
  return {
    name,
    managementServerId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    type: item.type,
    networks: fromNetworks(item.networks),
    description: item.description,
    labels: userLabels(item.labels),
    oauth2ClientId: item.oauth2ClientId,
    managementUri: item.managementUri,
    workforceIdentityBasedManagementUri:
      item.workforceIdentityBasedManagementUri,
    workforceIdentityBasedOauth2ClientId:
      item.workforceIdentityBasedOauth2ClientId,
    baProxyUri: item.baProxyUri ?? [],
    state: item.state,
    satisfiesPzi: item.satisfiesPzi,
    satisfiesPzs: item.satisfiesPzs,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  backupdr
    .getProjectsLocationsManagementServers({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      backupdr.listProjectsLocationsManagementServers.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.managementServers,
      (item) => item.labels,
    ),
  );

export const ManagementServerProvider = () =>
  Provider.succeed(ManagementServer, {
    stables: [
      "name",
      "managementServerId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.type ?? output?.type;
      const previousNetworks = fingerprint(olds?.networks ?? output?.networks);
      const nextNetworks =
        news.networks === undefined
          ? previousNetworks
          : fingerprint(news.networks);
      return replaceOnIdentity({
        previousId: olds?.managementServerId ?? output?.managementServerId,
        nextId:
          news.managementServerId ??
          olds?.managementServerId ??
          output?.managementServerId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousType !== undefined &&
            news.type !== undefined &&
            previousType !== news.type) ||
          previousNetworks !== nextNetworks,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const managementServerId = yield* toPhysicalId(
        id,
        olds?.managementServerId,
        output?.managementServerId,
        "mgmtserver",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, managementServerId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const managementServerId = yield* toPhysicalId(
        id,
        news.managementServerId,
        output?.managementServerId,
        "mgmtserver",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, managementServerId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const networks = toNetworks(env.project, news.networks);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* backupdr
          .createProjectsLocationsManagementServers({
            parent: parentOf(env.project, location),
            managementServerId,
            body: {
              type: news.type,
              networks,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* backupdr
        .deleteProjectsLocationsManagementServers({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
