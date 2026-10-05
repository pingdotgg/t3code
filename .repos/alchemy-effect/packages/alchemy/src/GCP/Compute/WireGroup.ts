import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type WireGroupWireProperties = compute.WireProperties;
export type WireGroupEndpoint = compute.WireGroupEndpoint;
export type WireGroupEndpointMap = compute.WireGroupEndpointMap;

export type WireGroupProps = {
  /**
   * Wire group name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Changing the name
   * replaces the group.
   */
  wireGroupName?: string;
  /**
   * Parent cross-site network name. Immutable — changing it replaces the
   * group.
   */
  crossSiteNetwork: string;
  /**
   * Optional description. Compute wire groups have no labels field, so
   * Alchemy ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`)
   * is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Whether wires in the group are enabled. Mutable in place.
   * @default true
   */
  adminEnabled?: boolean;
  /**
   * Properties applied to every wire (bandwidth, fault response).
   */
  wireProperties?: WireGroupWireProperties;
  /**
   * Logical endpoints keyed by RFC1035 labels. Each endpoint lists
   * interconnects and VLAN tags.
   */
  endpoints?: WireGroupEndpointMap;
};

export type WireGroup = Resource<
  "GCP.Compute.WireGroup",
  WireGroupProps,
  {
    /** Wire group name. */
    wireGroupName: string;
    /** Parent cross-site network name. */
    crossSiteNetwork: string;
    /** Server-assigned numeric id. */
    wireGroupId: string | undefined;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Whether wires in the group are enabled. */
    adminEnabled: boolean;
    /** Wire properties. */
    wireProperties: WireGroupWireProperties | undefined;
    /** Logical endpoints. */
    endpoints: WireGroupEndpointMap | undefined;
    /** Whether the group still has pending wire changes. */
    reconciling: boolean;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine wire group on a cross-site network.
 *
 * Wire groups connect Interconnect endpoints across metros. Compute Engine
 * has no labels on this resource, so Alchemy stamps ownership into the
 * description so `list` / `pnpm nuke:gcp` can find them.
 *
 * Name and parent `crossSiteNetwork` are immutable — changing them
 * replaces the group. `adminEnabled`, `wireProperties`, `endpoints`, and
 * description update in place via `wireGroups.patch`.
 *
 * ### Creating a Wire Group
 * **Example:** Two-endpoint VLAN wire group
 * ```typescript
 * const wires = yield* GCP.Compute.WireGroup("metro", {
 *   crossSiteNetwork: network.crossSiteNetworkName,
 *   description: "nyc-to-sfo",
 *   wireProperties: {
 *     bandwidthUnmetered: "10",
 *     bandwidthAllocation: "SHARED_WITH_WIRE_GROUP",
 *   },
 *   endpoints: {
 *     nyc: {
 *       interconnects: {
 *         a: { interconnect: "global/interconnects/nyc-a", vlanTags: [100] },
 *       },
 *     },
 *     sfo: {
 *       interconnects: {
 *         a: { interconnect: "global/interconnects/sfo-a", vlanTags: [100] },
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const WireGroup = Resource<WireGroup>("GCP.Compute.WireGroup");

export class WireGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.WireGroupNotResolved",
)<{
  wireGroupName: string;
  crossSiteNetwork: string;
}> {}

export class WireGroupStillExists extends Data.TaggedError(
  "GCP.Compute.WireGroupStillExists",
)<{
  wireGroupName: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const toName = (id: string, name: string | undefined, existing?: string) =>
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
      : `w${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const toBody = (
  wireGroupName: string,
  props: WireGroupProps,
  ownership: Record<string, string>,
): compute.WireGroup => ({
  name: wireGroupName,
  description: encodeDescription(ownership, props.description),
  adminEnabled: props.adminEnabled ?? true,
  wireProperties: props.wireProperties,
  endpoints: props.endpoints,
});

const toAttrs = (
  group: compute.WireGroup,
  project: string,
  crossSiteNetwork: string,
): WireGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    wireGroupName: group.name ?? group.id ?? "",
    crossSiteNetwork: lastSegment(crossSiteNetwork),
    wireGroupId: group.id,
    project,
    description: parsed.description,
    adminEnabled: group.adminEnabled !== false,
    wireProperties: group.wireProperties,
    endpoints: group.endpoints,
    reconciling: group.reconciling === true,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
  };
};

const getByName = (
  project: string,
  crossSiteNetwork: string,
  wireGroup: string,
) =>
  compute
    .getWireGroups({ project, crossSiteNetwork, wireGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitGroupGone = (
  project: string,
  crossSiteNetwork: string,
  wireGroupName: string,
) =>
  getByName(project, crossSiteNetwork, wireGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new WireGroupStillExists({
              wireGroupName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof WireGroupStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listParents = (project: string) =>
  compute.listCrossSiteNetworks
    .items({ project, maxResults: 500, returnPartialSuccess: true })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const WireGroupProvider = () =>
  Provider.succeed(WireGroup, {
    stables: [
      "wireGroupName",
      "wireGroupId",
      "project",
      "crossSiteNetwork",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName = olds?.wireGroupName ?? output?.wireGroupName;
      const nextName = news.wireGroupName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousParent = lastSegment(
        olds?.crossSiteNetwork ?? output?.crossSiteNetwork,
      );
      const nextParent = lastSegment(news.crossSiteNetwork);
      const parentChanged =
        previousParent.length > 0 &&
        nextParent.length > 0 &&
        previousParent !== nextParent;

      if (nameChanged || parentChanged) {
        return {
          action: "replace" as const,
          deleteFirst: !parentChanged && !nameChanged ? true : parentChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const wireGroupName = yield* toName(
        id,
        olds?.wireGroupName,
        output?.wireGroupName,
      );
      const preferredParent = lastSegment(
        olds?.crossSiteNetwork ?? output?.crossSiteNetwork,
      );

      if (preferredParent.length > 0) {
        const existing = yield* getByName(
          env.project,
          preferredParent,
          wireGroupName,
        );
        if (existing !== undefined) {
          const attrs = toAttrs(existing, env.project, preferredParent);
          const { labels } = parseDescription(existing.description);
          return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
        }
      }

      const parents = yield* listParents(env.project);
      for (const parent of parents) {
        const parentName = parent.name;
        if (parentName === undefined) continue;
        const existing = yield* getByName(
          env.project,
          parentName,
          wireGroupName,
        );
        if (existing === undefined) continue;
        const attrs = toAttrs(existing, env.project, parentName);
        const { labels } = parseDescription(existing.description);
        return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
      }
      return undefined;
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listParents(env.project);
        const groups = yield* Effect.forEach(
          parents,
          (parent) => {
            const crossSiteNetwork = parent.name;
            if (crossSiteNetwork === undefined) {
              return Effect.succeed([] as WireGroup["Attributes"][]);
            }
            return compute.listWireGroups
              .items({
                project: env.project,
                crossSiteNetwork,
                maxResults: 500,
                returnPartialSuccess: true,
              })
              .pipe(
                Stream.filter((group) => hasOwnershipMarker(group.description)),
                Stream.map((group) =>
                  toAttrs(group, env.project, crossSiteNetwork),
                ),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              );
          },
          { concurrency: 8 },
        );
        return groups.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const wireGroupName = yield* toName(
        id,
        news.wireGroupName,
        output?.wireGroupName,
      );
      const crossSiteNetwork = lastSegment(
        news.crossSiteNetwork ?? output?.crossSiteNetwork,
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(wireGroupName, news, ownership);

      let current = yield* getByName(
        env.project,
        crossSiteNetwork,
        wireGroupName,
      );

      if (current === undefined) {
        const inserted = yield* compute
          .insertWireGroups({
            project: env.project,
            crossSiteNetwork,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitGlobalOperation(env.project, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* getByName(
          env.project,
          crossSiteNetwork,
          wireGroupName,
        ).pipe(
          Effect.filterOrFail(
            (group): group is compute.WireGroup => group !== undefined,
            () =>
              new WireGroupNotResolved({
                wireGroupName,
                crossSiteNetwork,
              }),
          ),
          Effect.retry({
            while: (error) => error._tag === "GCP.Compute.WireGroupNotResolved",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
        );
      }

      if (current === undefined) {
        return yield* new WireGroupNotResolved({
          wireGroupName,
          crossSiteNetwork,
        });
      }

      const descriptionChanged =
        (current.description ?? "") !== (desired.description ?? "");
      const adminChanged =
        (current.adminEnabled !== false) !== (desired.adminEnabled !== false);
      const propertiesChanged = !sameJson(
        current.wireProperties,
        desired.wireProperties,
      );
      const endpointsChanged = !sameJson(current.endpoints, desired.endpoints);

      if (
        descriptionChanged ||
        adminChanged ||
        propertiesChanged ||
        endpointsChanged
      ) {
        const patched = yield* compute.patchWireGroups({
          project: env.project,
          crossSiteNetwork,
          wireGroup: wireGroupName,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            adminChanged ? "adminEnabled" : undefined,
            propertiesChanged ? "wireProperties" : undefined,
            endpointsChanged ? "endpoints" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: desired,
        });
        yield* waitGlobalOperation(env.project, patched);
        current =
          (yield* getByName(env.project, crossSiteNetwork, wireGroupName)) ??
          current;
      }

      return toAttrs(current, env.project, crossSiteNetwork);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const crossSiteNetwork = lastSegment(output.crossSiteNetwork);
      const deleted = yield* compute
        .deleteWireGroups({
          project,
          crossSiteNetwork,
          wireGroup: output.wireGroupName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (deleted !== undefined) {
        yield* waitGlobalOperation(project, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitGroupGone(project, crossSiteNetwork, output.wireGroupName);
    }),
  });
