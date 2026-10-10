import * as managedidentities from "@distilled.cloud/gcp/managedidentities_v1";
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
  DEFAULT_ADMIN,
  DEFAULT_NETWORK,
  domainNameOf,
  fieldMask,
  globalParent,
  listDomains,
  networkOf,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameStringList,
  toDomainName,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type DomainProps = {
  /**
   * Fully-qualified domain name (the `{domain}` segment of
   * `projects/{project}/locations/global/domains/{domain}`). Example:
   * `corp.example.com`. If omitted, a unique FQDN is generated from the
   * stack, stage, and logical id (`{id}.alch.test`). Must be 2-64
   * characters, start with a letter, use only lowercase letters, numbers,
   * periods, and hyphens, and the first label must be 15 characters or
   * fewer. Immutable — changing it replaces the domain.
   */
  domainName?: string;
  /**
   * CIDR of internal addresses reserved for this domain (`10.0.1.0/24`).
   * Must be `/24` or larger and must not overlap subnets in
   * `authorizedNetworks`. Immutable — changing it replaces the domain.
   */
  reservedIpRange: string;
  /**
   * Regions where domain controllers are provisioned (`us-central1`,
   * `us-east4`, …). Up to 4. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default [the stack's GCP region] (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  locations?: string[];
  /**
   * VPC networks the domain is reachable from, as ids (`default`) or
   * full names (`projects/{project}/global/networks/{network}`).
   * @default ["default"]
   */
  authorizedNetworks?: string[];
  /**
   * Delegated administrator account used for Active Directory operations.
   * Immutable — changing it replaces the domain.
   * @default "setupadmin"
   */
  admin?: string;
  /**
   * Whether AD audit logs are enabled.
   * @default false
   */
  auditLogsEnabled?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Domain = Resource<
  "GCP.ManagedIdentities.Domain",
  DomainProps,
  {
    /** Full resource name `projects/{project}/locations/global/domains/{domain}`. */
    name: string;
    /** Fully-qualified domain name (last path segment). */
    domainName: string;
    /** Project id. */
    project: string;
    /** Resource location (`global`). */
    location: string;
    /** Reserved CIDR for the domain. */
    reservedIpRange: string | undefined;
    /** Regions where domain controllers are provisioned. */
    locations: string[];
    /** Authorized VPC networks. */
    authorizedNetworks: string[];
    /** Delegated administrator account. */
    admin: string | undefined;
    /** Whether AD audit logs are enabled. */
    auditLogsEnabled: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Exposed Active Directory FQDN clients use to connect. */
    fqdn: string | undefined;
    /** Current trusts associated with the domain. */
    trusts: managedidentities.Trust[];
    /** Server-reported state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Additional status information, if available. */
    statusMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Managed Microsoft Active Directory domain.
 *
 * Changing `domainName`, `reservedIpRange`, or `admin` replaces the
 * domain. `locations`, `authorizedNetworks`, `auditLogsEnabled`, and
 * `labels` update in place. Provisioning typically takes 20-60 minutes.
 *
 * ### Creating a Domain
 * **Example:** Generated FQDN
 * ```typescript
 * const domain = yield* GCP.ManagedIdentities.Domain("Corp", {
 *   reservedIpRange: "172.16.0.0/24",
 *   locations: ["us-central1"],
 * });
 * ```
 *
 * **Example:** Explicit FQDN, networks, and labels
 * ```typescript
 * const domain = yield* GCP.ManagedIdentities.Domain("Corp", {
 *   domainName: "corp.example.com",
 *   reservedIpRange: "172.16.0.0/24",
 *   locations: ["us-central1"],
 *   authorizedNetworks: ["default"],
 *   auditLogsEnabled: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Domain
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Labels and audit logs
 * ```typescript
 * const domain = yield* GCP.ManagedIdentities.Domain("Corp", {
 *   domainName: "corp.example.com",
 *   reservedIpRange: "172.16.0.0/24",
 *   locations: ["us-central1"],
 *   auditLogsEnabled: true,
 *   labels: { env: "prod", team: "identity" },
 * });
 * ```
 *
 * @resource
 * @category ManagedIdentities
 */
export const Domain = Resource<Domain>("GCP.ManagedIdentities.Domain");

const resourceName = (project: string, domainName: string) =>
  `${globalParent(project)}/domains/${domainName}`;

const locationsOf = (
  values: readonly string[] | undefined,
  defaultLocation: string,
) => (values ?? [defaultLocation]).map(normalizeLocation);

const networksOf = (values: readonly string[] | undefined, project: string) =>
  (values ?? [DEFAULT_NETWORK]).map((value) => networkOf(value, project));

const adminOf = (value: string | undefined) => value || DEFAULT_ADMIN;

const toAttrs = (item: managedidentities.Domain, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "domains");
  return {
    name,
    domainName: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    reservedIpRange: item.reservedIpRange,
    locations: item.locations ?? [],
    authorizedNetworks: item.authorizedNetworks ?? [],
    admin: item.admin,
    auditLogsEnabled: item.auditLogsEnabled === true,
    labels: userLabels(item.labels),
    fqdn: item.fqdn,
    trusts: item.trusts ?? [],
    state: item.state,
    statusMessage: item.statusMessage,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : managedidentities
        .getProjectsLocationsGlobalDomains({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["name", "domainName", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = domainNameOf(
        olds?.domainName ?? output?.domainName ?? output?.name ?? "",
      );
      const nextName = domainNameOf(
        news.domainName ?? olds?.domainName ?? output?.domainName ?? "",
      );
      const previousRange = olds?.reservedIpRange ?? output?.reservedIpRange;
      const previousAdmin = adminOf(olds?.admin ?? output?.admin);
      return replaceOnIdentity({
        previousId: previousName.length > 0 ? previousName : undefined,
        nextId: nextName.length > 0 ? nextName : undefined,
        extra:
          (previousRange !== undefined &&
            news.reservedIpRange !== previousRange) ||
          (news.admin !== undefined && adminOf(news.admin) !== previousAdmin),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const domainName = yield* toDomainName(
        id,
        olds?.domainName,
        output?.domainName,
      );
      const name = output?.name ?? resourceName(env.project, domainName);
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
        const items = yield* listDomains(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const domainName = yield* toDomainName(
        id,
        news.domainName,
        output?.domainName,
      );
      const name = resourceName(env.project, domainName);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const locations = locationsOf(
        news.locations ?? output?.locations,
        env.region,
      );
      const authorizedNetworks = networksOf(
        news.authorizedNetworks ?? output?.authorizedNetworks,
        env.project,
      );
      const auditLogsEnabled = news.auditLogsEnabled ?? false;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* managedidentities
          .createProjectsLocationsGlobalDomains({
            parent: globalParent(env.project),
            domainName,
            body: {
              reservedIpRange: news.reservedIpRange,
              locations,
              authorizedNetworks,
              admin: news.admin,
              auditLogsEnabled,
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

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item: managedidentities.Domain) => item.state,
        (item: managedidentities.Domain) => item.statusMessage,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const observedNetworks = current.authorizedNetworks ?? [];
      const observedLocations = current.locations ?? [];
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameStringList(observedLocations, locations) && "locations",
        news.authorizedNetworks !== undefined &&
          !sameStringList(observedNetworks, authorizedNetworks) &&
          "authorized_networks",
        (current.auditLogsEnabled === true) !== auditLogsEnabled &&
          "audit_logs_enabled",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* managedidentities.patchProjectsLocationsGlobalDomains({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              locations,
              authorizedNetworks,
              auditLogsEnabled,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item: managedidentities.Domain) => item.state,
          (item: managedidentities.Domain) => item.statusMessage,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* managedidentities
        .deleteProjectsLocationsGlobalDomains({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
