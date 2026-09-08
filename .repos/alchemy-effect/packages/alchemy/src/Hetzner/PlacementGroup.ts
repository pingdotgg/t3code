import { Services } from "@distilled.cloud/hetzner";
import type { GetPlacementGroupResponsePlacementGroup } from "@distilled.cloud/hetzner/placement_groups";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import { waitForAction } from "./actions.ts";
import {
  alchemyLabelKeys,
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  labelSelector,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

/**
 * Placement Group type. Hetzner currently offers only `spread` — Servers
 * in the group are placed on distinct physical hosts.
 */
export type PlacementGroupType = "spread";

export interface PlacementGroupProps {
  /**
   * Name of the Placement Group. Must be unique per Hetzner project. If
   * omitted, a unique name is generated from `${stack}-${id}-${stage}`.
   */
  name?: string;
  /**
   * Placement strategy. `spread` places each Server on a different
   * physical host. Cannot be changed after creation — changing it
   * replaces the group.
   *
   * @default "spread"
   */
  type?: PlacementGroupType;
  /**
   * User-defined labels (`key/value` pairs). Alchemy ownership labels
   * (`alchemy.stack`, `alchemy.stage`, `alchemy.id`) are merged in
   * automatically.
   */
  labels?: Record<string, string>;
}

export type PlacementGroup = Resource<
  "Hetzner.PlacementGroup",
  PlacementGroupProps,
  {
    /**
     * Numeric Hetzner Placement Group ID.
     */
    id: number;
    /**
     * Name of the Placement Group. Unique per project.
     */
    name: string;
    /**
     * Placement strategy. Currently always `spread`.
     */
    type: PlacementGroupType;
    /**
     * User-defined labels (Alchemy ownership labels stripped).
     */
    labels: Record<string, string>;
    /**
     * RFC3339 timestamp of when the Placement Group was created.
     */
    created: string;
    /**
     * IDs of Servers currently assigned to this group. Server
     * attachment is configured on the Server resource.
     */
    servers: number[];
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud Placement Group. Spread groups keep member Servers on
 * distinct physical hosts so a single hardware failure cannot take them
 * all down. Type is `spread` (the only type Hetzner currently offers)
 * and is immutable — changing it replaces the group. Name and labels
 * update in place.
 *
 * Servers are attached from the Server resource (not here).
 *
 * @see https://docs.hetzner.cloud/reference/cloud#placement-groups
 *
 * ### Creating a Placement Group
 * **Example:** Basic spread group
 * ```typescript
 * const group = yield* Hetzner.PlacementGroup("web");
 * ```
 *
 * **Example:** Named group with labels
 * ```typescript
 * const group = yield* Hetzner.PlacementGroup("web", {
 *   name: "web-spread",
 *   type: "spread",
 *   labels: { role: "web" },
 * });
 * ```
 *
 * @resource
 */
export const PlacementGroup = Resource<PlacementGroup>(
  "Hetzner.PlacementGroup",
);

export class PlacementGroupNotResolved extends Data.TaggedError(
  "Hetzner.PlacementGroupNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_TYPE: PlacementGroupType = "spread";

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ?? existing ?? (yield* createPhysicalName({ id, maxLength: 64 }))
    );
  });

const toAttrs = (group: GetPlacementGroupResponsePlacementGroup) => ({
  id: group.id,
  name: group.name,
  type: group.type as PlacementGroupType,
  labels: userLabels(group.labels),
  created: group.created,
  servers: group.servers,
});

const getById = (id: number) =>
  Services.placementGroups.getPlacementGroup({ id }).pipe(
    Effect.map(({ placement_group }) => placement_group),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const findByName = (name: string) =>
  Services.placementGroups
    .listPlacementGroups({ name, per_page: 50 })
    .pipe(
      Effect.map(({ placement_groups }) =>
        placement_groups.find((group) => group.name === name),
      ),
    );

const findByAlchemyLabels = (id: string) =>
  Effect.gen(function* () {
    const internal = yield* createInternalLabels(id);
    const { placement_groups } =
      yield* Services.placementGroups.listPlacementGroups({
        label_selector: labelSelector(internal),
        per_page: 50,
      });
    return placement_groups.find((group) => {
      const labels = tagRecord(group.labels);
      return Object.entries(internal).every(
        ([key, value]) => labels[key] === value,
      );
    });
  });

const observe = Effect.fn(function* (input: {
  id?: number;
  name?: string;
  logicalId: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  if (input.name !== undefined) {
    const byName = yield* findByName(input.name);
    if (byName !== undefined) return byName;
  }
  return yield* findByAlchemyLabels(input.logicalId);
});

/**
 * Poll `getPlacementGroup` until it returns the typed `NotFound` tag.
 * Bounded to 10 attempts at 1s spacing.
 */
export const waitUntilPlacementGroupGone = (id: number) =>
  Services.placementGroups.getPlacementGroup({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

export const PlacementGroupProvider = () =>
  Provider.succeed(PlacementGroup, {
    stables: ["id", "type", "created"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      const nextType = news.type ?? DEFAULT_TYPE;
      if (output !== undefined && nextType !== output.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* toName(id, olds?.name, output?.name);
      const existing = yield* observe({
        id: output?.id,
        name,
        logicalId: id,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Services.placementGroups.listPlacementGroups
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk, toAttrs)),
        ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const type = news.type ?? DEFAULT_TYPE;
      const name = yield* toName(id, news.name, output?.name);
      const desired = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* observe({
        id: output?.id,
        name,
        logicalId: id,
      });

      if (current === undefined) {
        const created = yield* Services.placementGroups
          .createPlacementGroup({
            name,
            type,
            labels: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created?.action != null) {
          yield* waitForAction(created.action.id);
        }
        current =
          created?.placement_group ?? (yield* observe({ name, logicalId: id }));
      }

      if (current === undefined) {
        return yield* new PlacementGroupNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desired);
      const nameChanged = current.name !== name;
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      if (nameChanged || labelsChanged) {
        const updated = yield* Services.placementGroups.updatePlacementGroup({
          id: current.id,
          name: nameChanged ? name : undefined,
          labels: labelsChanged ? desired : undefined,
        });
        current = updated.placement_group;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Services.placementGroups
        .deletePlacementGroup({ id: output.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
