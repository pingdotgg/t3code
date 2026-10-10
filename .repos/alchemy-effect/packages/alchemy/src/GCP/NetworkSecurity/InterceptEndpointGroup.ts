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

const COLLECTION = "interceptEndpointGroups";

export type InterceptEndpointGroupAssociationDetail = {
  /** Connected association resource name. */
  name: string | undefined;
  /** Associated VPC network. */
  network: string | undefined;
  /** Most recent known association state. */
  state: string | undefined;
};

export type InterceptEndpointGroupConnectedDeploymentGroup = {
  /** Connected deployment group resource name. */
  name: string | undefined;
  /** Locations where the deployment group is present. */
  locations: Array<{
    location: string | undefined;
    state: string | undefined;
  }>;
};

export type InterceptEndpointGroupProps = {
  /**
   * Endpoint group id (the `{interceptEndpointGroup}` segment of
   * `projects/{project}/locations/{location}/interceptEndpointGroups/{interceptEndpointGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the group.
   */
  interceptEndpointGroupId?: string;
  /**
   * Location of the group. Endpoint groups are global — always
   * `"global"`. Immutable — changing it replaces the group. `GLOBAL` is
   * accepted and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Deployment group this endpoint group is connected to, as a full
   * resource name. Immutable — changing it replaces the group.
   */
  interceptDeploymentGroup: string;
  /**
   * Human-readable description of the endpoint group.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type InterceptEndpointGroup = Resource<
  "GCP.NetworkSecurity.InterceptEndpointGroup",
  InterceptEndpointGroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Endpoint group id (last path segment). */
    interceptEndpointGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. Always `"global"`. */
    location: string;
    /** Connected deployment group resource name. */
    interceptDeploymentGroup: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether the API is still reconciling intended vs actual state. */
    reconciling: boolean;
    /** Associations attached to this group. */
    associations: InterceptEndpointGroupAssociationDetail[];
    /** Connected deployment group details. */
    connectedDeploymentGroup:
      | InterceptEndpointGroupConnectedDeploymentGroup
      | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security Integration intercept endpoint group — the consumer
 * frontend for an intercept deployment group.
 *
 * Changing `interceptEndpointGroupId`, `location`, or
 * `interceptDeploymentGroup` replaces the group. Description and labels
 * update in place.
 *
 * ### Creating an Endpoint Group
 * **Example:** Generated name
 * ```typescript
 * const endpoints = yield* GCP.NetworkSecurity.InterceptEndpointGroup("Front", {
 *   interceptDeploymentGroup: group.name,
 * });
 * ```
 *
 * **Example:** Named group with labels
 * ```typescript
 * const endpoints = yield* GCP.NetworkSecurity.InterceptEndpointGroup("Front", {
 *   interceptEndpointGroupId: "app-intercept-eg",
 *   interceptDeploymentGroup: group.name,
 *   description: "prod intercept frontend",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Endpoint Group
 * **Example:** Description and labels
 * ```typescript
 * const endpoints = yield* GCP.NetworkSecurity.InterceptEndpointGroup("Front", {
 *   interceptEndpointGroupId: "app-intercept-eg",
 *   interceptDeploymentGroup: group.name,
 *   description: "prod intercept frontend v2",
 *   labels: { env: "prod", role: "nsi" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const InterceptEndpointGroup = Resource<InterceptEndpointGroup>(
  "GCP.NetworkSecurity.InterceptEndpointGroup",
);

export class InterceptEndpointGroupNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.InterceptEndpointGroupNotResolved",
)<{
  name: string;
}> {}

export class InterceptEndpointGroupFailed extends Data.TaggedError(
  "GCP.NetworkSecurity.InterceptEndpointGroupFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class InterceptEndpointGroupStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.InterceptEndpointGroupStillExists",
)<{
  name: string;
}> {}

const isPendingState = (state: string | undefined) =>
  state === "CREATING" || state === "DELETING" || state === "STATE_UNSPECIFIED";

const toAssociations = (
  associations:
    | networksecurity.InterceptEndpointGroupAssociationDetailsList
    | undefined,
): InterceptEndpointGroupAssociationDetail[] =>
  (associations ?? []).map((item) => ({
    name: item.name,
    network: item.network,
    state: item.state,
  }));

const toConnected = (
  group:
    | networksecurity.InterceptEndpointGroupConnectedDeploymentGroup
    | undefined,
): InterceptEndpointGroupConnectedDeploymentGroup | undefined =>
  group === undefined
    ? undefined
    : {
        name: group.name,
        locations: (group.locations ?? []).map((location) => ({
          location: location.location,
          state: location.state,
        })),
      };

const toAttrs = (
  group: networksecurity.InterceptEndpointGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    interceptEndpointGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    interceptDeploymentGroup: group.interceptDeploymentGroup,
    description: group.description,
    labels: userLabels(group.labels),
    state: group.state,
    reconciling: group.reconciling === true,
    associations: toAssociations(group.associations),
    connectedDeploymentGroup: toConnected(group.connectedDeploymentGroup),
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsInterceptEndpointGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (group): group is networksecurity.InterceptEndpointGroup =>
        group !== undefined,
      () => new InterceptEndpointGroupNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (group) => group.state !== "DELETE_FAILED",
      (group) => new InterceptEndpointGroupFailed({ name, state: group.state }),
    ),
    Effect.filterOrFail(
      (group) => !isPendingState(group.state),
      () => new InterceptEndpointGroupNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.InterceptEndpointGroupNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new InterceptEndpointGroupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.InterceptEndpointGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsInterceptEndpointGroups
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.interceptEndpointGroups ?? []),
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

export const InterceptEndpointGroupProvider = () =>
  Provider.succeed(InterceptEndpointGroup, {
    stables: [
      "name",
      "interceptEndpointGroupId",
      "project",
      "location",
      "interceptDeploymentGroup",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.interceptEndpointGroupId ?? output?.interceptEndpointGroupId;
      const nextId = news.interceptEndpointGroupId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousGroup = lastSegment(
        olds?.interceptDeploymentGroup ??
          output?.interceptDeploymentGroup ??
          "",
      );
      const nextGroup = lastSegment(news.interceptDeploymentGroup);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousGroup.length > 0 && previousGroup !== nextGroup);
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptEndpointGroupId = yield* toId(
        id,
        olds?.interceptEndpointGroupId,
        output?.interceptEndpointGroupId,
        "ieg",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(
          env.project,
          location,
          COLLECTION,
          interceptEndpointGroupId,
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
      const interceptEndpointGroupId = yield* toId(
        id,
        news.interceptEndpointGroupId,
        output?.interceptEndpointGroupId,
        "ieg",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        interceptEndpointGroupId,
      );
      const interceptDeploymentGroup = toResourcePath(
        news.interceptDeploymentGroup,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsInterceptEndpointGroups({
            parent: parentOf(env.project, location),
            interceptEndpointGroupId,
            body: {
              interceptDeploymentGroup,
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
        return yield* new InterceptEndpointGroupNotResolved({ name });
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
          yield* networksecurity.patchProjectsLocationsInterceptEndpointGroups({
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
        .deleteProjectsLocationsInterceptEndpointGroups({
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
