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
  domainResourceOf,
  fieldMask,
  globalParent,
  listPeerings,
  networkOf,
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

export type PeeringProps = {
  /**
   * Peering id (the `{peering}` segment of
   * `projects/{project}/locations/global/peerings/{peering}`). If omitted,
   * a unique RFC1035 name is generated from the stack, stage, and logical
   * id. Must match `^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$`. Immutable —
   * changing it replaces the peering.
   */
  peeringId?: string;
  /**
   * Managed Microsoft AD domain to peer with. Must live in a different
   * project than `authorizedNetwork`. Full name
   * `projects/{project}/locations/global/domains/{domain}` or the domain
   * FQDN. Immutable — changing it replaces the peering.
   */
  domainResource: string;
  /**
   * VPC network the domain is peered into, as an id (`default`) or full
   * name (`projects/{project}/global/networks/{network}`). Caller must
   * ensure CIDR subnets do not overlap the domain. Immutable — changing
   * it replaces the peering.
   */
  authorizedNetwork: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Labels are the only mutable field.
   */
  labels?: Record<string, string>;
};

export type Peering = Resource<
  "GCP.ManagedIdentities.Peering",
  PeeringProps,
  {
    /** Full resource name `projects/{project}/locations/global/peerings/{peering}`. */
    name: string;
    /** Peering id (last path segment). */
    peeringId: string;
    /** Project id. */
    project: string;
    /** Resource location (`global`). */
    location: string;
    /** Peered domain resource name. */
    domainResource: string | undefined;
    /** Authorized VPC network. */
    authorizedNetwork: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`CONNECTED`, `CREATING`, …). */
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
 * A Managed Microsoft AD domain peering — attaches a VPC in this
 * project to a Managed AD domain that lives in a **different** project
 * so VMs on that network can join the domain. Same-project access uses
 * `Domain.authorizedNetworks` instead; creating a peering when domain
 * and network share a project is rejected with `BadRequest`.
 *
 * Changing `peeringId`, `domainResource`, or `authorizedNetwork`
 * replaces the peering. Labels update in place.
 *
 * ### Creating a Peering
 * **Example:** Generated name
 * ```typescript
 * const peering = yield* GCP.ManagedIdentities.Peering("Spoke", {
 *   domainResource: domain.name,
 *   authorizedNetwork: "default",
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const peering = yield* GCP.ManagedIdentities.Peering("Spoke", {
 *   peeringId: "app-spoke",
 *   domainResource: domain.name,
 *   authorizedNetwork: "projects/my-project/global/networks/default",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Peering
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Labels
 * ```typescript
 * const peering = yield* GCP.ManagedIdentities.Peering("Spoke", {
 *   domainResource: domain.name,
 *   authorizedNetwork: "default",
 *   labels: { env: "prod", team: "identity" },
 * });
 * ```
 *
 * @resource
 * @category ManagedIdentities
 */
export const Peering = Resource<Peering>("GCP.ManagedIdentities.Peering");

const resourceName = (project: string, peeringId: string) =>
  `${globalParent(project)}/peerings/${peeringId}`;

const toAttrs = (item: managedidentities.Peering, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "peerings");
  return {
    name,
    peeringId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    domainResource: item.domainResource,
    authorizedNetwork: item.authorizedNetwork,
    labels: userLabels(item.labels),
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
        .getProjectsLocationsGlobalPeerings({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const PeeringProvider = () =>
  Provider.succeed(Peering, {
    stables: ["name", "peeringId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousDomain = domainResourceOf(
        olds?.domainResource ?? output?.domainResource ?? "",
        env.project,
      );
      const nextDomain = domainResourceOf(
        news.domainResource ??
          olds?.domainResource ??
          output?.domainResource ??
          "",
        env.project,
      );
      const previousNetwork = networkOf(
        olds?.authorizedNetwork ?? output?.authorizedNetwork ?? "",
        env.project,
      );
      const nextNetwork = networkOf(
        news.authorizedNetwork ??
          olds?.authorizedNetwork ??
          output?.authorizedNetwork ??
          "",
        env.project,
      );
      return replaceOnIdentity({
        previousId: olds?.peeringId ?? output?.peeringId,
        nextId: news.peeringId ?? olds?.peeringId ?? output?.peeringId,
        extra:
          (previousDomain.length > 0 &&
            nextDomain.length > 0 &&
            previousDomain !== nextDomain) ||
          (previousNetwork.length > 0 &&
            nextNetwork.length > 0 &&
            previousNetwork !== nextNetwork),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const peeringId = yield* toPhysicalId(
        id,
        olds?.peeringId,
        output?.peeringId,
        "peering",
      );
      const name = output?.name ?? resourceName(env.project, peeringId);
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
        const items = yield* listPeerings(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const peeringId = yield* toPhysicalId(
        id,
        news.peeringId,
        output?.peeringId,
        "peering",
      );
      const name = resourceName(env.project, peeringId);
      const domainResource = domainResourceOf(news.domainResource, env.project);
      const authorizedNetwork = networkOf(news.authorizedNetwork, env.project);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* managedidentities
          .createProjectsLocationsGlobalPeerings({
            parent: globalParent(env.project),
            peeringId,
            body: {
              domainResource,
              authorizedNetwork,
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
        (item: managedidentities.Peering) => item.state,
        (item: managedidentities.Peering) => item.statusMessage,
      );

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* managedidentities.patchProjectsLocationsGlobalPeerings({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item: managedidentities.Peering) => item.state,
          (item: managedidentities.Peering) => item.statusMessage,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* managedidentities
        .deleteProjectsLocationsGlobalPeerings({ name: output.name })
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
