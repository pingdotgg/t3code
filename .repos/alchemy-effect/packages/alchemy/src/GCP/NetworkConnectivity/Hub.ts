import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./internal.ts";

const DEFAULT_LOCATION = "global";
const DEFAULT_POLICY_MODE =
  "PRESET" satisfies networkconnectivity.HubPolicyModeEnum;
const DEFAULT_PRESET_TOPOLOGY =
  "MESH" satisfies networkconnectivity.HubPresetTopologyEnum;
const MAX_NAME_LENGTH = 63;

export type HubState = networkconnectivity.HubStateEnum | (string & {});
export type HubPolicyMode =
  | networkconnectivity.HubPolicyModeEnum
  | (string & {});
export type HubPresetTopology =
  | networkconnectivity.HubPresetTopologyEnum
  | (string & {});

export type HubRoutingVpc = {
  /** URI of the VPC network attached via a spoke. */
  uri: string | undefined;
  /**
   * Whether this VPC must be used for new site-to-site data-transfer
   * spokes.
   */
  requiredForNewSiteToSiteDataTransferSpokes: boolean | undefined;
};

export type HubProps = {
  /**
   * Hub id (the `{hub}` segment of
   * `projects/{project}/locations/global/hubs/{hub}`). If omitted, a
   * unique RFC1035 name is generated from the stack, stage, and logical
   * id. Must be 1-63 characters and match `[a-z]([-a-z0-9]*[a-z0-9])?`.
   * Immutable — changing it replaces the hub.
   */
  hubId?: string;
  /**
   * Human-readable description of the hub.
   */
  description?: string;
  /**
   * Whether Private Service Connect connection propagation is enabled.
   * When true, PSC endpoints in VPC spokes are reachable from other VPC
   * spokes on this hub.
   * @default false
   */
  exportPsc?: boolean;
  /**
   * Policy mode. `PRESET` applies `presetTopology`; `CUSTOM` leaves
   * topology unspecified.
   * @default "PRESET"
   */
  policyMode?: HubPolicyMode;
  /**
   * Preset topology used when `policyMode` is `PRESET`. Ignored (and
   * reported as `PRESET_TOPOLOGY_UNSPECIFIED`) when `policyMode` is
   * `CUSTOM`.
   * @default "MESH"
   */
  presetTopology?: HubPresetTopology;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Hub = Resource<
  "GCP.NetworkConnectivity.Hub",
  HubProps,
  {
    /** Full resource name `projects/{project}/locations/global/hubs/{hub}`. */
    name: string;
    /** Hub id (last path segment). */
    hubId: string;
    /** Project id. */
    project: string;
    /** Location id. Hubs are global — always `"global"`. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Whether PSC connection propagation is enabled. */
    exportPsc: boolean;
    /** Policy mode currently configured on the hub. */
    policyMode: string | undefined;
    /** Preset topology currently configured on the hub. */
    presetTopology: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated UUID, unique across hubs. */
    uniqueId: string | undefined;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** VPC networks associated with this hub's spokes (output-only). */
    routingVpcs: HubRoutingVpc[];
    /** Route table names nested under this hub (output-only). */
    routeTables: ReadonlyArray<string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Connectivity Center hub — the global attachment point for
 * VPC, VPN, and interconnect spokes.
 *
 * Hubs live at `locations/global`. Changing `hubId` replaces the hub.
 * Description, labels, `exportPsc`, `policyMode`, and `presetTopology`
 * update in place. A hub can only be deleted when it has no spokes.
 *
 * ### Creating a Hub
 * **Example:** Generated name
 * ```typescript
 * const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {});
 * ```
 *
 * **Example:** Named hub with labels
 * ```typescript
 * const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
 *   hubId: "app-mesh",
 *   description: "prod mesh",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Preset topology
 * **Example:** STAR hub
 * ```typescript
 * const hub = yield* GCP.NetworkConnectivity.Hub("Star", {
 *   policyMode: "PRESET",
 *   presetTopology: "STAR",
 * });
 * ```
 *
 * ### Private Service Connect
 * **Example:** Enable PSC transitivity
 * ```typescript
 * const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
 *   exportPsc: true,
 * });
 * ```
 *
 * ### Updating a Hub
 * **Example:** Description, labels, and PSC
 * ```typescript
 * const hub = yield* GCP.NetworkConnectivity.Hub("Mesh", {
 *   hubId: "app-mesh",
 *   description: "prod mesh v2",
 *   exportPsc: true,
 *   labels: { env: "prod", role: "ncc" },
 * });
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const Hub = Resource<Hub>("GCP.NetworkConnectivity.Hub");

export class HubNotResolved extends Data.TaggedError(
  "GCP.NetworkConnectivity.HubNotResolved",
)<{
  name: string;
}> {}

export class HubFailed extends Data.TaggedError(
  "GCP.NetworkConnectivity.HubFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class HubStillExists extends Data.TaggedError(
  "GCP.NetworkConnectivity.HubStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `h${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : "hub";
};

const resourceName = (project: string, hubId: string) =>
  `projects/${project}/locations/${DEFAULT_LOCATION}/hubs/${hubId}`;

const parentOf = (project: string) =>
  `projects/${project}/locations/${DEFAULT_LOCATION}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const hubsAt = parts.lastIndexOf("hubs");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    hubId:
      hubsAt >= 0 && parts[hubsAt + 1] ? parts[hubsAt + 1]! : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, hubId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (hubId !== undefined) return hubId;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

const desiredPolicyMode = (news: HubProps): HubPolicyMode =>
  news.policyMode ?? DEFAULT_POLICY_MODE;

const desiredPresetTopology = (news: HubProps): HubPresetTopology => {
  if (desiredPolicyMode(news) === "CUSTOM") {
    return "PRESET_TOPOLOGY_UNSPECIFIED";
  }
  return news.presetTopology ?? DEFAULT_PRESET_TOPOLOGY;
};

const toRoutingVpcs = (
  vpcs: networkconnectivity.RoutingVPCList | undefined,
): HubRoutingVpc[] =>
  (vpcs ?? []).map((vpc) => ({
    uri: vpc.uri,
    requiredForNewSiteToSiteDataTransferSpokes:
      vpc.requiredForNewSiteToSiteDataTransferSpokes,
  }));

const toAttrs = (hub: networkconnectivity.Hub, project: string) => {
  const name = hub.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    hubId: parsed.hubId,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    description: hub.description,
    exportPsc: hub.exportPsc === true,
    policyMode: hub.policyMode,
    presetTopology: hub.presetTopology,
    labels: userLabels(hub.labels),
    uniqueId: hub.uniqueId,
    state: hub.state,
    routingVpcs: toRoutingVpcs(hub.routingVpcs),
    routeTables: hub.routeTables ?? [],
    createTime: hub.createTime,
    updateTime: hub.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsGlobalHubs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isPendingState = (state: string | undefined) =>
  state === "CREATING" ||
  state === "UPDATING" ||
  state === "DELETING" ||
  state === "ACCEPTING" ||
  state === "REJECTING" ||
  state === "STATE_UNSPECIFIED";

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (hub): hub is networkconnectivity.Hub => hub !== undefined,
      () => new HubNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (hub) => hub.state !== "FAILED" && hub.state !== "OBSOLETE",
      (hub) => new HubFailed({ name, state: hub.state }),
    ),
    Effect.filterOrFail(
      (hub) => !isPendingState(hub.state),
      () => new HubNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetworkConnectivity.HubNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((hub) =>
      hub === undefined
        ? Effect.void
        : Effect.fail(new HubStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.NetworkConnectivity.HubStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const listOwnedHubs = (project: string) =>
  networkconnectivity.listProjectsLocationsGlobalHubs
    .pages({
      parent: parentOf(project),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.hubs ?? [])),
      Stream.filter((hub) =>
        Object.keys(hub.labels ?? {}).some((key) => key.startsWith("alchemy-")),
      ),
      Stream.map((hub) => toAttrs(hub, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const HubProvider = () =>
  Provider.succeed(Hub, {
    stables: ["name", "hubId", "project", "location", "uniqueId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.hubId ?? output?.hubId;
      const nextId = news.hubId ?? previousId;
      if (
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const hubId = yield* toId(id, olds?.hubId, output?.hubId);
      const name = output?.name ?? resourceName(env.project, hubId);
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
        return yield* listOwnedHubs(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const hubId = yield* toId(id, news.hubId, output?.hubId);
      const name = output?.name ?? resourceName(env.project, hubId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const policyMode = desiredPolicyMode(news);
      const presetTopology = desiredPresetTopology(news);
      const exportPsc = news.exportPsc === true;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsGlobalHubs({
            parent: parentOf(env.project),
            hubId,
            body: {
              description: news.description,
              labels: desiredLabels,
              exportPsc,
              policyMode,
              presetTopology,
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
        return yield* new HubNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const exportPscChanged = (current.exportPsc === true) !== exportPsc;
      const policyModeChanged =
        (current.policyMode ?? DEFAULT_POLICY_MODE) !== policyMode;
      const presetTopologyChanged =
        (current.presetTopology ?? DEFAULT_PRESET_TOPOLOGY) !== presetTopology;

      if (
        labelsChanged ||
        descriptionChanged ||
        exportPscChanged ||
        policyModeChanged ||
        presetTopologyChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          exportPscChanged ? "exportPsc" : undefined,
          policyModeChanged ? "policyMode" : undefined,
          presetTopologyChanged ? "presetTopology" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networkconnectivity.patchProjectsLocationsGlobalHubs({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              exportPsc,
              policyMode,
              presetTopology,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsGlobalHubs({ name: output.name })
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
      yield* waitUntilGone(output.name);
    }),
  });
