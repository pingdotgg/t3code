import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  DEFAULT_ZONE,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "firewallEndpoints";

export type FirewallEndpointState =
  | networksecurity.FirewallEndpointStateEnum
  | (string & {});

export type FirewallEndpointAssociationRef = {
  /** Association resource name. */
  name: string | undefined;
};

export type FirewallEndpointProps = {
  /**
   * FirewallEndpoint id (the `{firewallEndpoint}` segment of
   * `projects/{project}/locations/{location}/firewallEndpoints/{firewallEndpoint}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the endpoint.
   */
  firewallEndpointId?: string;
  /**
   * Zone of the endpoint (`us-central1-a`, …). Immutable — changing it
   * replaces the endpoint. `US-CENTRAL1-A` is accepted and normalized to
   * `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Project billed for the endpoint. Required for organization-scoped
   * endpoints; omit for project-scoped endpoints. Immutable — changing
   * it replaces the endpoint.
   */
  billingProjectId?: string;
  /**
   * Human-readable description (max 2048 characters).
   */
  description?: string;
  /**
   * Enable jumbo frames on the endpoint. Immutable — changing it
   * replaces the endpoint.
   * @default false
   */
  jumboFramesEnabled?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type FirewallEndpoint = Resource<
  "GCP.NetworkSecurity.FirewallEndpoint",
  FirewallEndpointProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/firewallEndpoints/{firewallEndpoint}`. */
    name: string;
    /** FirewallEndpoint id (last path segment). */
    firewallEndpointId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-a`). */
    location: string;
    /** Project billed for the endpoint, if set. */
    billingProjectId: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** Whether jumbo frames are enabled. */
    jumboFramesEnabled: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether reconciling is in progress. */
    reconciling: boolean;
    /** Associated FirewallEndpointAssociation names. */
    associations: FirewallEndpointAssociationRef[];
    /** Associated VPC network names (deprecated projection). */
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
 * A project-scoped Cloud NGFW firewall endpoint. Endpoints terminate
 * inspected traffic in a zone; associate them with a VPC via
 * FirewallEndpointAssociation.
 *
 * Changing `firewallEndpointId`, `location`, `billingProjectId`, or
 * jumbo-frame settings replaces the endpoint. Description and labels
 * update in place. Provisioning is asynchronous and can take several
 * minutes.
 *
 * ### Creating a FirewallEndpoint
 * **Example:** Generated name
 * ```typescript
 * const endpoint = yield* GCP.NetworkSecurity.FirewallEndpoint("Ngfw", {
 *   location: "us-central1-a",
 * });
 * ```
 *
 * **Example:** Named endpoint with labels
 * ```typescript
 * const endpoint = yield* GCP.NetworkSecurity.FirewallEndpoint("Ngfw", {
 *   firewallEndpointId: "app-ngfw",
 *   location: "us-central1-a",
 *   description: "prod inspection",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const FirewallEndpoint = Resource<FirewallEndpoint>(
  "GCP.NetworkSecurity.FirewallEndpoint",
);

const resourceName = (
  project: string,
  location: string,
  firewallEndpointId: string,
) =>
  `projects/${project}/locations/${location}/firewallEndpoints/${firewallEndpointId}`;

const toAttrs = (
  endpoint: networksecurity.FirewallEndpoint,
  project: string,
) => {
  const name = endpoint.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  return {
    name,
    firewallEndpointId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_ZONE,
    billingProjectId: endpoint.billingProjectId,
    description: endpoint.description,
    jumboFramesEnabled: endpoint.endpointSettings?.jumboFramesEnabled === true,
    labels: userLabels(endpoint.labels),
    state: endpoint.state,
    reconciling: endpoint.reconciling === true,
    associations: (endpoint.associations ?? []).map((association) => ({
      name: association.name,
    })),
    associatedNetworks: endpoint.associatedNetworks ?? [],
    createTime: endpoint.createTime,
    updateTime: endpoint.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsFirewallEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FirewallEndpointProvider = () =>
  Provider.succeed(FirewallEndpoint, {
    stables: [
      "name",
      "firewallEndpointId",
      "project",
      "location",
      "billingProjectId",
      "jumboFramesEnabled",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.firewallEndpointId ?? output?.firewallEndpointId;
      const nextId = news.firewallEndpointId
        ? rfc1035(news.firewallEndpointId, "firewall-endpoint")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const previousBilling =
        olds?.billingProjectId ?? output?.billingProjectId ?? "";
      const nextBilling = news.billingProjectId ?? previousBilling;
      const previousJumbo =
        olds?.jumboFramesEnabled ?? output?.jumboFramesEnabled ?? false;
      const nextJumbo = news.jumboFramesEnabled ?? previousJumbo;
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousBilling !== nextBilling ||
        previousJumbo !== nextJumbo
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallEndpointId = yield* toPhysicalId(
        id,
        olds?.firewallEndpointId,
        output?.firewallEndpointId,
        "firewall-endpoint",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name =
        output?.name ?? resourceName(env.project, location, firewallEndpointId);
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
          networksecurity.listProjectsLocationsFirewallEndpoints.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.firewallEndpoints,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallEndpointId = yield* toPhysicalId(
        id,
        news.firewallEndpointId,
        output?.firewallEndpointId,
        "firewall-endpoint",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name = resourceName(env.project, location, firewallEndpointId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const jumboFramesEnabled = news.jumboFramesEnabled === true;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsFirewallEndpoints({
            parent: parentOf(env.project, location),
            firewallEndpointId,
            body: {
              billingProjectId: news.billingProjectId,
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
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networksecurity.patchProjectsLocationsFirewallEndpoints({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsFirewallEndpoints({ name: output.name })
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
