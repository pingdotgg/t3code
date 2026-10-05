import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
  listOrganizations,
  normalizeZone,
  organizationParent,
  parseResourceName,
  ResourceNotResolved,
  resolveOrganization,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

export type OrganizationsFirewallEndpointState =
  | networksecurity.FirewallEndpointStateEnum
  | (string & {});

export type OrganizationsFirewallEndpointSettings = {
  /**
   * Whether jumbo frames are enabled. Immutable — changing it replaces
   * the endpoint.
   * @default false
   */
  jumboFramesEnabled?: boolean;
};

export type OrganizationsFirewallEndpointAssociation = {
  /** FirewallEndpointAssociation resource name. */
  name: string | undefined;
  /** VPC network `projects/{project}/global/networks/{name}`. */
  network: string | undefined;
};

export type OrganizationsFirewallEndpointProps = {
  /**
   * Firewall endpoint id. If omitted, a unique RFC1035 name is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the endpoint.
   */
  firewallEndpointId?: string;
  /**
   * Organization id or `organizations/{organization}`. If omitted,
   * Alchemy uses `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager parent. Immutable — changing it replaces the endpoint.
   */
  organization?: string;
  /**
   * Zone (`us-central1-a`, …). Firewall endpoints are zonal. Immutable —
   * changing it replaces the endpoint.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Project billed for the endpoint. Required for organization-scoped
   * endpoints. Defaults to the stack project.
   */
  billingProjectId?: string;
  /**
   * Endpoint settings. `jumboFramesEnabled` is immutable.
   */
  endpointSettings?: OrganizationsFirewallEndpointSettings;
  /**
   * Human-readable description (max 2048 characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OrganizationsFirewallEndpoint = Resource<
  "GCP.NetworkSecurity.OrganizationsFirewallEndpoint",
  OrganizationsFirewallEndpointProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/firewallEndpoints/{firewallEndpoint}`. */
    name: string;
    /** Firewall endpoint id (last path segment). */
    firewallEndpointId: string;
    /** Organization id. */
    organization: string;
    /** Zone id. */
    location: string;
    /** Project billed for the endpoint. */
    billingProjectId: string | undefined;
    /** Whether jumbo frames are enabled. */
    jumboFramesEnabled: boolean;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state. */
    state: string | undefined;
    /** Whether the endpoint is reconciling. */
    reconciling: boolean;
    /** Associated FirewallEndpointAssociations. */
    associations: OrganizationsFirewallEndpointAssociation[];
    /** Associated VPC networks. */
    associatedNetworks: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Cloud NGFW firewall endpoint.
 *
 * Endpoints are zonal and bill to `billingProjectId`. Changing
 * `firewallEndpointId`, `organization`, `location`, `billingProjectId`,
 * or jumbo-frame settings replaces the endpoint. Description and labels
 * update in place. Provisioning is slow — tests skip when `FAST` is set.
 *
 * ### Creating a Firewall Endpoint
 * **Example:** Generated name
 * ```typescript
 * const endpoint = yield* GCP.NetworkSecurity.OrganizationsFirewallEndpoint(
 *   "Ngfw",
 *   { location: "us-central1-a" },
 * );
 * ```
 *
 * **Example:** Named endpoint
 * ```typescript
 * const endpoint = yield* GCP.NetworkSecurity.OrganizationsFirewallEndpoint(
 *   "Ngfw",
 *   {
 *     firewallEndpointId: "app-ngfw",
 *     organization: "123456789",
 *     location: "us-central1-a",
 *     billingProjectId: "my-project",
 *     description: "prod NGFW",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const OrganizationsFirewallEndpoint =
  Resource<OrganizationsFirewallEndpoint>(
    "GCP.NetworkSecurity.OrganizationsFirewallEndpoint",
  );

const resourceName = (
  organization: string,
  location: string,
  firewallEndpointId: string,
) =>
  `organizations/${organization}/locations/${location}/firewallEndpoints/${firewallEndpointId}`;

const jumboOf = (settings: OrganizationsFirewallEndpointSettings | undefined) =>
  settings?.jumboFramesEnabled === true;

const toAttrs = (endpoint: networksecurity.FirewallEndpoint) => {
  const name = endpoint.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    firewallEndpointId: parsed.id,
    organization: parsed.parentId,
    location: parsed.location,
    billingProjectId: endpoint.billingProjectId,
    jumboFramesEnabled: endpoint.endpointSettings?.jumboFramesEnabled === true,
    description: endpoint.description,
    labels: userLabels(endpoint.labels),
    state: endpoint.state,
    reconciling: endpoint.reconciling === true,
    associations: (endpoint.associations ?? []).map((association) => ({
      name: association.name,
      network: association.network,
    })),
    associatedNetworks: endpoint.associatedNetworks ?? [],
    createTime: endpoint.createTime,
    updateTime: endpoint.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getOrganizationsLocationsFirewallEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isPendingState = (state: string | undefined) =>
  state === "CREATING" || state === "DELETING" || state === "STATE_UNSPECIFIED";

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (endpoint): endpoint is networksecurity.FirewallEndpoint =>
        endpoint !== undefined,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (endpoint) => !isPendingState(endpoint.state),
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.ResourceNotResolved",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const listOwned = (organization: string) =>
  networksecurity.listOrganizationsLocationsFirewallEndpoints
    .pages({
      parent: organizationParent(organization, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.firewallEndpoints ?? []),
      ),
      Stream.filter((endpoint) =>
        Object.keys(endpoint.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map(toAttrs),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const OrganizationsFirewallEndpointProvider = () =>
  Provider.succeed(OrganizationsFirewallEndpoint, {
    stables: [
      "name",
      "firewallEndpointId",
      "organization",
      "location",
      "billingProjectId",
      "jumboFramesEnabled",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.firewallEndpointId ?? output?.firewallEndpointId;
      const nextId = news.firewallEndpointId ?? previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization ?? previousOrg;
      const previousLocation = normalizeZone(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeZone(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousBilling =
        olds?.billingProjectId ?? output?.billingProjectId;
      const nextBilling = news.billingProjectId ?? previousBilling;
      const previousJumbo = jumboOf(olds?.endpointSettings);
      const nextJumbo =
        news.endpointSettings !== undefined
          ? jumboOf(news.endpointSettings)
          : (output?.jumboFramesEnabled ?? previousJumbo);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousOrg !== undefined &&
          nextOrg !== undefined &&
          nextOrg !== previousOrg) ||
        previousLocation !== nextLocation ||
        (previousBilling !== undefined &&
          nextBilling !== undefined &&
          previousBilling !== nextBilling) ||
        previousJumbo !== nextJumbo;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousOrg === nextOrg &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const firewallEndpointId = yield* toPhysicalId(
        id,
        olds?.firewallEndpointId,
        output?.firewallEndpointId,
        "fwep",
      );
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      ).pipe(
        Effect.catchTag("GCP.NetworkSecurity.OrganizationRequired", () =>
          Effect.succeed(output?.organization ?? ""),
        ),
      );
      const location = normalizeZone(olds?.location ?? output?.location);
      const name =
        output?.name ??
        (organization.length > 0
          ? resourceName(organization, location, firewallEndpointId)
          : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const orgs = yield* listOrganizations(env.project);
        const listed: OrganizationsFirewallEndpoint["Attributes"][] = [];
        for (const organization of orgs) {
          listed.push(...(yield* listOwned(organization)));
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallEndpointId = yield* toPhysicalId(
        id,
        news.firewallEndpointId,
        output?.firewallEndpointId,
        "fwep",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeZone(news.location ?? output?.location);
      const name = resourceName(organization, location, firewallEndpointId);
      const billingProjectId = news.billingProjectId ?? env.project;
      const jumboFramesEnabled = jumboOf(news.endpointSettings);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createOrganizationsLocationsFirewallEndpoints({
            parent: organizationParent(organization, location),
            firewallEndpointId,
            body: {
              billingProjectId,
              description: news.description,
              labels: desiredLabels,
              endpointSettings: { jumboFramesEnabled },
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
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || descriptionChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchOrganizationsLocationsFirewallEndpoints({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteOrganizationsLocationsFirewallEndpoints({ name: output.name })
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
