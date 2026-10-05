import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
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
  DEFAULT_LOCATION,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  toNetworkResource,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "mirroringDeploymentGroups";

export type MirroringLocation = {
  /** Cloud location, e.g. `us-central1-a`. */
  location: string | undefined;
  /** Association state in this location (`ACTIVE`, `OUT_OF_SYNC`, …). */
  state: string | undefined;
};

export type MirroringDeploymentGroupConnectedEndpointGroup = {
  /** Connected endpoint group resource name. */
  name: string | undefined;
};

export type MirroringDeploymentGroupNestedDeployment = {
  /** Nested mirroring deployment resource name. */
  name: string | undefined;
  /** Most recent known state of the nested deployment. */
  state: string | undefined;
};

export type MirroringDeploymentGroupProps = {
  /**
   * Deployment group id (the `{mirroringDeploymentGroup}` segment of
   * `projects/{project}/locations/{location}/mirroringDeploymentGroups/{mirroringDeploymentGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the group.
   */
  mirroringDeploymentGroupId?: string;
  /**
   * Location of the group. Deployment groups are global — always
   * `"global"`. Immutable — changing it replaces the group. `GLOBAL` is
   * accepted and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * VPC used by every child deployment, as a name (`app-vpc`), resource
   * path (`projects/{project}/global/networks/{network}`), or Compute
   * self-link. Immutable — changing it replaces the group.
   */
  network: string;
  /**
   * Human-readable description of the deployment group.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MirroringDeploymentGroup = Resource<
  "GCP.NetworkSecurity.MirroringDeploymentGroup",
  MirroringDeploymentGroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Deployment group id (last path segment). */
    mirroringDeploymentGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. Always `"global"`. */
    location: string;
    /** VPC resource path used by child deployments. */
    network: string | undefined;
    /** VPC network id (last path segment). */
    networkName: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether the API is still reconciling intended vs actual state. */
    reconciling: boolean;
    /** Locations where the group is present. */
    locations: MirroringLocation[];
    /** Endpoint groups connected to this group. */
    connectedEndpointGroups: MirroringDeploymentGroupConnectedEndpointGroup[];
    /** Nested mirroring deployments. */
    nestedDeployments: MirroringDeploymentGroupNestedDeployment[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security Integration mirroring deployment group — the global
 * backend that aggregates zonal mirroring collectors.
 *
 * Changing `mirroringDeploymentGroupId`, `location`, or `network` replaces
 * the group. Description and labels update in place.
 *
 * ### Creating a Deployment Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
 *   network: vpc.selfLink,
 * });
 * ```
 *
 * **Example:** Named group with labels
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
 *   mirroringDeploymentGroupId: "app-collectors",
 *   network: "projects/my-project/global/networks/app-vpc",
 *   description: "prod mirroring backends",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Deployment Group
 * **Example:** Description and labels
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.MirroringDeploymentGroup("Collectors", {
 *   mirroringDeploymentGroupId: "app-collectors",
 *   network: vpc.selfLink,
 *   description: "prod mirroring backends v2",
 *   labels: { env: "prod", role: "nsi" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const MirroringDeploymentGroup = Resource<MirroringDeploymentGroup>(
  "GCP.NetworkSecurity.MirroringDeploymentGroup",
);

export class MirroringDeploymentGroupNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringDeploymentGroupNotResolved",
)<{
  name: string;
}> {}

export class MirroringDeploymentGroupFailed extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringDeploymentGroupFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class MirroringDeploymentGroupStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringDeploymentGroupStillExists",
)<{
  name: string;
}> {}

const isPendingState = (state: string | undefined) =>
  state === "CREATING" || state === "DELETING" || state === "STATE_UNSPECIFIED";

const toLocations = (
  locations: networksecurity.MirroringLocationList | undefined,
): MirroringLocation[] =>
  (locations ?? []).map((item) => ({
    location: item.location,
    state: item.state,
  }));

const toConnected = (
  groups:
    | networksecurity.MirroringDeploymentGroupConnectedEndpointGroupList
    | undefined,
): MirroringDeploymentGroupConnectedEndpointGroup[] =>
  (groups ?? []).map((item) => ({ name: item.name }));

const toNested = (
  deployments:
    | networksecurity.MirroringDeploymentGroupDeploymentList
    | undefined,
): MirroringDeploymentGroupNestedDeployment[] =>
  (deployments ?? []).map((item) => ({
    name: item.name,
    state: item.state,
  }));

const toAttrs = (
  group: networksecurity.MirroringDeploymentGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    mirroringDeploymentGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    network: group.network,
    networkName: group.network ? lastSegment(group.network) : undefined,
    description: group.description,
    labels: userLabels(group.labels),
    state: group.state,
    reconciling: group.reconciling === true,
    locations: toLocations(group.locations),
    connectedEndpointGroups: toConnected(group.connectedEndpointGroups),
    nestedDeployments: toNested(group.nestedDeployments),
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsMirroringDeploymentGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (group): group is networksecurity.MirroringDeploymentGroup =>
        group !== undefined,
      () => new MirroringDeploymentGroupNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (group) => group.state !== "DELETE_FAILED",
      (group) =>
        new MirroringDeploymentGroupFailed({ name, state: group.state }),
    ),
    Effect.filterOrFail(
      (group) => !isPendingState(group.state),
      () => new MirroringDeploymentGroupNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.NetworkSecurity.MirroringDeploymentGroupNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new MirroringDeploymentGroupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.NetworkSecurity.MirroringDeploymentGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsMirroringDeploymentGroups
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.mirroringDeploymentGroups ?? []),
      ),
      Stream.filter((group) =>
        Object.keys(group.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((group) => toAttrs(group, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const MirroringDeploymentGroupProvider = () =>
  Provider.succeed(MirroringDeploymentGroup, {
    stables: [
      "name",
      "mirroringDeploymentGroupId",
      "project",
      "location",
      "network",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.mirroringDeploymentGroupId ?? output?.mirroringDeploymentGroupId;
      const nextId = news.mirroringDeploymentGroupId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousNetwork = lastSegment(
        olds?.network ?? output?.networkName ?? output?.network ?? "",
      );
      const nextNetwork = lastSegment(news.network);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork);
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const mirroringDeploymentGroupId = yield* toId(
        id,
        olds?.mirroringDeploymentGroupId,
        output?.mirroringDeploymentGroupId,
        "mdg",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(
          env.project,
          location,
          COLLECTION,
          mirroringDeploymentGroupId,
        );
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
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const mirroringDeploymentGroupId = yield* toId(
        id,
        news.mirroringDeploymentGroupId,
        output?.mirroringDeploymentGroupId,
        "mdg",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        mirroringDeploymentGroupId,
      );
      const network = toNetworkResource(env.project, news.network);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsMirroringDeploymentGroups({
            parent: parentOf(env.project, location),
            mirroringDeploymentGroupId,
            body: {
              network,
              description: news.description,
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
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new MirroringDeploymentGroupNotResolved({ name });
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
          yield* networksecurity.patchProjectsLocationsMirroringDeploymentGroups(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsMirroringDeploymentGroups({
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
      yield* waitUntilGone(output.name);
    }),
  });
