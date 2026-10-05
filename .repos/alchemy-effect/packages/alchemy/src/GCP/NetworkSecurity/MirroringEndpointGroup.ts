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
  toResourcePath,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "mirroringEndpointGroups";
const DEFAULT_TYPE =
  "DIRECT" satisfies networksecurity.MirroringEndpointGroupTypeEnum;

export type MirroringEndpointGroupType =
  | networksecurity.MirroringEndpointGroupTypeEnum
  | (string & {});

export type MirroringEndpointGroupAssociationDetail = {
  /** Connected association resource name. */
  name: string | undefined;
  /** Associated VPC network. */
  network: string | undefined;
  /** Most recent known association state. */
  state: string | undefined;
};

export type MirroringEndpointGroupConnectedDeploymentGroup = {
  /** Connected deployment group resource name. */
  name: string | undefined;
  /** Locations where the deployment group is present. */
  locations: Array<{
    location: string | undefined;
    state: string | undefined;
  }>;
};

export type MirroringEndpointGroupProps = {
  /**
   * Endpoint group id (the `{mirroringEndpointGroup}` segment of
   * `projects/{project}/locations/{location}/mirroringEndpointGroups/{mirroringEndpointGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the group.
   */
  mirroringEndpointGroupId?: string;
  /**
   * Location of the group. Endpoint groups are global — always
   * `"global"`. Immutable — changing it replaces the group. `GLOBAL` is
   * accepted and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Deployment group this DIRECT endpoint group is connected to, as a
   * full resource name. Immutable — changing it replaces the group.
   */
  mirroringDeploymentGroup: string;
  /**
   * Endpoint group type. If omitted, defaults to `DIRECT`. Immutable —
   * changing it replaces the group.
   * @default "DIRECT"
   */
  type?: MirroringEndpointGroupType;
  /**
   * Human-readable description of the endpoint group.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MirroringEndpointGroup = Resource<
  "GCP.NetworkSecurity.MirroringEndpointGroup",
  MirroringEndpointGroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Endpoint group id (last path segment). */
    mirroringEndpointGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. Always `"global"`. */
    location: string;
    /** Connected deployment group resource name. */
    mirroringDeploymentGroup: string | undefined;
    /** Endpoint group type (`DIRECT`, …). */
    type: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether the API is still reconciling intended vs actual state. */
    reconciling: boolean;
    /** Associations attached to this group. */
    associations: MirroringEndpointGroupAssociationDetail[];
    /** Connected deployment groups. */
    connectedDeploymentGroups: MirroringEndpointGroupConnectedDeploymentGroup[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security Integration mirroring endpoint group — the consumer
 * frontend for a mirroring deployment group.
 *
 * Changing `mirroringEndpointGroupId`, `location`, `type`, or
 * `mirroringDeploymentGroup` replaces the group. Description and labels
 * update in place.
 *
 * ### Creating an Endpoint Group
 * **Example:** Generated name
 * ```typescript
 * const endpoints = yield* GCP.NetworkSecurity.MirroringEndpointGroup("Front", {
 *   mirroringDeploymentGroup: group.name,
 * });
 * ```
 *
 * **Example:** Named group with labels
 * ```typescript
 * const endpoints = yield* GCP.NetworkSecurity.MirroringEndpointGroup("Front", {
 *   mirroringEndpointGroupId: "app-mirroring-eg",
 *   mirroringDeploymentGroup: group.name,
 *   description: "prod mirroring frontend",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Endpoint Group
 * **Example:** Description and labels
 * ```typescript
 * const endpoints = yield* GCP.NetworkSecurity.MirroringEndpointGroup("Front", {
 *   mirroringEndpointGroupId: "app-mirroring-eg",
 *   mirroringDeploymentGroup: group.name,
 *   description: "prod mirroring frontend v2",
 *   labels: { env: "prod", role: "nsi" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const MirroringEndpointGroup = Resource<MirroringEndpointGroup>(
  "GCP.NetworkSecurity.MirroringEndpointGroup",
);

export class MirroringEndpointGroupNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringEndpointGroupNotResolved",
)<{
  name: string;
}> {}

export class MirroringEndpointGroupFailed extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringEndpointGroupFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class MirroringEndpointGroupStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringEndpointGroupStillExists",
)<{
  name: string;
}> {}

const isPendingState = (state: string | undefined) =>
  state === "CREATING" || state === "DELETING" || state === "STATE_UNSPECIFIED";

const toAssociations = (
  associations:
    | networksecurity.MirroringEndpointGroupAssociationDetailsList
    | undefined,
): MirroringEndpointGroupAssociationDetail[] =>
  (associations ?? []).map((item) => ({
    name: item.name,
    network: item.network,
    state: item.state,
  }));

const toConnected = (
  groups:
    | networksecurity.MirroringEndpointGroupConnectedDeploymentGroupList
    | undefined,
): MirroringEndpointGroupConnectedDeploymentGroup[] =>
  (groups ?? []).map((item) => ({
    name: item.name,
    locations: (item.locations ?? []).map((location) => ({
      location: location.location,
      state: location.state,
    })),
  }));

const toAttrs = (
  group: networksecurity.MirroringEndpointGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    mirroringEndpointGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    mirroringDeploymentGroup: group.mirroringDeploymentGroup,
    type: group.type,
    description: group.description,
    labels: userLabels(group.labels),
    state: group.state,
    reconciling: group.reconciling === true,
    associations: toAssociations(group.associations),
    connectedDeploymentGroups: toConnected(group.connectedDeploymentGroups),
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsMirroringEndpointGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (group): group is networksecurity.MirroringEndpointGroup =>
        group !== undefined,
      () => new MirroringEndpointGroupNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (group) => group.state !== "DELETE_FAILED",
      (group) => new MirroringEndpointGroupFailed({ name, state: group.state }),
    ),
    Effect.filterOrFail(
      (group) => !isPendingState(group.state),
      () => new MirroringEndpointGroupNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.MirroringEndpointGroupNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new MirroringEndpointGroupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.MirroringEndpointGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsMirroringEndpointGroups
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.mirroringEndpointGroups ?? []),
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

export const MirroringEndpointGroupProvider = () =>
  Provider.succeed(MirroringEndpointGroup, {
    stables: [
      "name",
      "mirroringEndpointGroupId",
      "project",
      "location",
      "mirroringDeploymentGroup",
      "type",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.mirroringEndpointGroupId ?? output?.mirroringEndpointGroupId;
      const nextId = news.mirroringEndpointGroupId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousGroup = lastSegment(
        olds?.mirroringDeploymentGroup ??
          output?.mirroringDeploymentGroup ??
          "",
      );
      const nextGroup = lastSegment(news.mirroringDeploymentGroup);
      const previousType = (
        olds?.type ??
        output?.type ??
        DEFAULT_TYPE
      ).toUpperCase();
      const nextType = (news.type ?? previousType).toUpperCase();
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousGroup.length > 0 && previousGroup !== nextGroup) ||
        previousType !== nextType;
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const mirroringEndpointGroupId = yield* toId(
        id,
        olds?.mirroringEndpointGroupId,
        output?.mirroringEndpointGroupId,
        "meg",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(
          env.project,
          location,
          COLLECTION,
          mirroringEndpointGroupId,
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
      const mirroringEndpointGroupId = yield* toId(
        id,
        news.mirroringEndpointGroupId,
        output?.mirroringEndpointGroupId,
        "meg",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        mirroringEndpointGroupId,
      );
      const mirroringDeploymentGroup = toResourcePath(
        news.mirroringDeploymentGroup,
      );
      const type = news.type ?? DEFAULT_TYPE;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsMirroringEndpointGroups({
            parent: parentOf(env.project, location),
            mirroringEndpointGroupId,
            body: {
              mirroringDeploymentGroup,
              type,
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
        return yield* new MirroringEndpointGroupNotResolved({ name });
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
          yield* networksecurity.patchProjectsLocationsMirroringEndpointGroups({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsMirroringEndpointGroups({
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
