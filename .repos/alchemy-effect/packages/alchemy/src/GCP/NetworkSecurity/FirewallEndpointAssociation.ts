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
  canonicalizeLink,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  linkKey,
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

const COLLECTION = "firewallEndpointAssociations";

export type FirewallEndpointAssociationState =
  | networksecurity.FirewallEndpointAssociationStateEnum
  | (string & {});

export type FirewallEndpointAssociationProps = {
  /**
   * Association id (the `{firewallEndpointAssociation}` segment of
   * `projects/{project}/locations/{location}/firewallEndpointAssociations/{firewallEndpointAssociation}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the association.
   */
  firewallEndpointAssociationId?: string;
  /**
   * Zone of the association (`us-central1-a`, …). Immutable — changing
   * it replaces the association. `US-CENTRAL1-A` is accepted and
   * normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * FirewallEndpoint resource name
   * (`projects/{project}/locations/{location}/firewallEndpoints/{firewallEndpoint}`).
   * Immutable — changing it replaces the association.
   */
  firewallEndpoint: string;
  /**
   * VPC network resource name
   * (`projects/{project}/global/networks/{network}`). Immutable —
   * changing it replaces the association.
   */
  network: string;
  /**
   * Optional TlsInspectionPolicy resource name attached to this
   * association.
   */
  tlsInspectionPolicy?: string;
  /**
   * When true, the association exists but does not intercept traffic.
   * @default false
   */
  disabled?: boolean;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type FirewallEndpointAssociation = Resource<
  "GCP.NetworkSecurity.FirewallEndpointAssociation",
  FirewallEndpointAssociationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/firewallEndpointAssociations/{firewallEndpointAssociation}`. */
    name: string;
    /** Association id (last path segment). */
    firewallEndpointAssociationId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-a`). */
    location: string;
    /** Associated FirewallEndpoint resource name. */
    firewallEndpoint: string | undefined;
    /** Associated VPC network resource name. */
    network: string | undefined;
    /** Attached TlsInspectionPolicy resource name, if any. */
    tlsInspectionPolicy: string | undefined;
    /** Whether the association is disabled. */
    disabled: boolean;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether reconciling is in progress. */
    reconciling: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * Associates a Cloud NGFW FirewallEndpoint with a VPC network so
 * matching traffic is intercepted for inspection.
 *
 * Changing `firewallEndpointAssociationId`, `location`, `network`, or
 * `firewallEndpoint` replaces the association. Labels, `disabled`, and
 * `tlsInspectionPolicy` update in place.
 *
 * ### Creating a FirewallEndpointAssociation
 * **Example:** Attach an endpoint to a VPC
 * ```typescript
 * const association = yield* GCP.NetworkSecurity.FirewallEndpointAssociation(
 *   "Inspect",
 *   {
 *     location: "us-central1-a",
 *     firewallEndpoint: endpoint.name,
 *     network: `projects/${vpc.project}/global/networks/${vpc.networkName}`,
 *   },
 * );
 * ```
 *
 * **Example:** Disable interception
 * ```typescript
 * const association = yield* GCP.NetworkSecurity.FirewallEndpointAssociation(
 *   "Inspect",
 *   {
 *     location: "us-central1-a",
 *     firewallEndpoint: endpoint.name,
 *     network: `projects/${vpc.project}/global/networks/${vpc.networkName}`,
 *     disabled: true,
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const FirewallEndpointAssociation =
  Resource<FirewallEndpointAssociation>(
    "GCP.NetworkSecurity.FirewallEndpointAssociation",
  );

const resourceName = (
  project: string,
  location: string,
  firewallEndpointAssociationId: string,
) =>
  `projects/${project}/locations/${location}/firewallEndpointAssociations/${firewallEndpointAssociationId}`;

const toAttrs = (
  association: networksecurity.FirewallEndpointAssociation,
  project: string,
) => {
  const name = association.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  return {
    name,
    firewallEndpointAssociationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_ZONE,
    firewallEndpoint: association.firewallEndpoint
      ? canonicalizeLink(association.firewallEndpoint)
      : undefined,
    network: association.network
      ? canonicalizeLink(association.network)
      : undefined,
    tlsInspectionPolicy: association.tlsInspectionPolicy
      ? canonicalizeLink(association.tlsInspectionPolicy)
      : undefined,
    disabled: association.disabled === true,
    labels: userLabels(association.labels),
    state: association.state,
    reconciling: association.reconciling === true,
    createTime: association.createTime,
    updateTime: association.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsFirewallEndpointAssociations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const FirewallEndpointAssociationProvider = () =>
  Provider.succeed(FirewallEndpointAssociation, {
    stables: [
      "name",
      "firewallEndpointAssociationId",
      "project",
      "location",
      "firewallEndpoint",
      "network",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.firewallEndpointAssociationId ??
        output?.firewallEndpointAssociationId;
      const nextId = news.firewallEndpointAssociationId
        ? rfc1035(
            news.firewallEndpointAssociationId,
            "firewall-endpoint-association",
          )
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const previousEndpoint = linkKey(
        olds?.firewallEndpoint ?? output?.firewallEndpoint,
      );
      const nextEndpoint = linkKey(news.firewallEndpoint);
      const previousNetwork = linkKey(olds?.network ?? output?.network);
      const nextNetwork = linkKey(news.network);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousEndpoint.length > 0 && previousEndpoint !== nextEndpoint) ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallEndpointAssociationId = yield* toPhysicalId(
        id,
        olds?.firewallEndpointAssociationId,
        output?.firewallEndpointAssociationId,
        "firewall-endpoint-association",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, firewallEndpointAssociationId);
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
          networksecurity.listProjectsLocationsFirewallEndpointAssociations.pages(
            {
              parent: parentOf(env.project, "-"),
              pageSize: 1000,
            },
          ),
          (page) => page.firewallEndpointAssociations,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const firewallEndpointAssociationId = yield* toPhysicalId(
        id,
        news.firewallEndpointAssociationId,
        output?.firewallEndpointAssociationId,
        "firewall-endpoint-association",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name = resourceName(
        env.project,
        location,
        firewallEndpointAssociationId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const firewallEndpoint = canonicalizeLink(news.firewallEndpoint);
      const network = canonicalizeLink(news.network);
      const tlsInspectionPolicy = news.tlsInspectionPolicy
        ? canonicalizeLink(news.tlsInspectionPolicy)
        : undefined;
      const disabled = news.disabled === true;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsFirewallEndpointAssociations({
            parent: parentOf(env.project, location),
            firewallEndpointAssociationId,
            body: {
              firewallEndpoint,
              network,
              tlsInspectionPolicy,
              disabled,
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
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const disabledChanged = (current.disabled === true) !== disabled;
      const tlsChanged =
        canonicalizeLink(current.tlsInspectionPolicy) !==
        (tlsInspectionPolicy ?? "");
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["disabled", disabledChanged],
        ["tlsInspectionPolicy", tlsChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networksecurity.patchProjectsLocationsFirewallEndpointAssociations(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                disabled,
                tlsInspectionPolicy,
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
      const operation = yield* networksecurity
        .deleteProjectsLocationsFirewallEndpointAssociations({
          name: output.name,
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
