import type {
  EnvironmentResponse,
  ProjectResponse,
  ProjectResponseBucketsEdgesItemNode,
  ProjectResponseGroupsEdgesItemNode,
  ProjectResponseServicesEdgesItemNode,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects, type Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Group is drawn on. Accepts a `Railway.Project`
 * (its primary environment), a `Railway.Environment`, or an
 * `{ environmentId }` stub.
 */
export type GroupEnvironment = {
  readonly environmentId: string;
};

/**
 * A canvas-group member. Accepts a `Railway.Service` / Postgres / Redis /
 * MySQL / Mongo (`serviceId`), a `Railway.Volume` (`volumeId`), a
 * `Railway.Bucket` (`bucketId`), or a stub with those ids.
 */
export type GroupMember = {
  readonly serviceId?: string;
  readonly volumeId?: string;
  readonly bucketId?: string;
};

export interface GroupProps {
  /**
   * Parent Railway Project. Changing it replaces the Group.
   */
  project: Ref<Project>;
  /**
   * Environment whose canvas this group lives on. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Defaults to the project's primary environment.
   * Changing it replaces the Group.
   */
  environment?: Ref<GroupEnvironment>;
  /**
   * Canvas group name. If omitted, a unique name is generated from the
   * stack, stage and logical ID. Updates in place.
   */
  name?: string;
  /**
   * Members to place in the group — services, databases, volumes, and
   * buckets. Service membership is persisted as `groupId`; volume ids
   * are observed from `canvasGroupRefs`; bucket ids from `Bucket.groupId`.
   */
  resources: ReadonlyArray<Ref<GroupMember>>;
  /**
   * Optional canvas color. Updates in place.
   */
  color?: string;
  /**
   * Optional canvas icon. Updates in place.
   */
  icon?: string;
  /**
   * Whether the group is collapsed on the canvas.
   *
   * @default false
   */
  collapsed?: boolean;
}

export type Group = Resource<
  "Railway.Group",
  GroupProps,
  {
    /** Railway group id (EnvironmentConfig key / Group.id). */
    groupId: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment whose canvas this group is on. */
    environmentId: string;
    /** Canvas group name. */
    name: string;
    /** Canvas color, if set. */
    color: string | undefined;
    /** Canvas icon, if set. */
    icon: string | undefined;
    /** Whether the group is collapsed on the canvas. */
    collapsed: boolean;
    /** Member service ids (`Service.groupId` / Postgres / Redis / …). */
    serviceIds: string[];
    /** Member volume ids. */
    volumeIds: string[];
    /** Member bucket ids (`Bucket.groupId`). */
    bucketIds: string[];
  },
  never,
  Providers
>;

const resolveGroupProps = (
  props: GroupProps | Effect.Effect<GroupProps, never, Providers>,
): Effect.Effect<GroupProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project = Effect.isEffect(resolved.project)
      ? yield* resolved.project as Effect.Effect<Project, never, Providers>
      : resolved.project;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              GroupEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    const resources = yield* Effect.forEach(resolved.resources, (item) =>
      Effect.isEffect(item)
        ? (item as Effect.Effect<GroupMember, never, Providers>)
        : Effect.succeed(item),
    );
    return { ...resolved, project, environment, resources };
  });

const GroupResource = Resource<Group>("Railway.Group");

/**
 * A Railway.Group organizes services, databases, volumes, and buckets on
 * the project canvas. IaC parity with `group("Backend", [api, worker, db])`.
 *
 * Groups have no dedicated create/delete mutation. Alchemy writes
 * `EnvironmentConfig.groups` (and `services[id].groupId`) via
 * `environmentPatchCommit`, matching Railway's own IaC compiler. Volume
 * membership is observed from `environment.canvasGroupRefs`. When Railway
 * does not persist a first-class Group id, the resource still records
 * member service/volume/bucket ids. `canvasViewMerge` /
 * `canvasViewMergePreview` copy canvas layout between environments.
 *
 * @see https://docs.railway.com/infrastructure-as-code/reference
 *
 * ### Create a Group
 * Pass a Project and the members to group. Alchemy generates a unique
 * name unless you pass one.
 *
 * **Example:** Group two services
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const worker = yield* Railway.Service("Worker", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const backend = yield* Railway.Group("Backend", {
 *   project: site,
 *   resources: [api, worker],
 * });
 * ```
 *
 * :::caution[Changing `project` replaces the Group]
 * The Group is created in the new Project. The old Group is deleted.
 * :::
 *
 * ### Environment
 * Defaults to the Project's primary environment. Pass a
 * `Railway.Environment` (or `{ environmentId }`) to target another one.
 *
 * **Example:** Extra environment
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", { project: site });
 * const backend = yield* Railway.Group("Backend", {
 *   project: site,
 *   environment: staging,
 *   resources: [api],
 * });
 * ```
 *
 * :::caution[Changing `environment` replaces the Group]
 * The Group is created on the new environment's canvas. The old Group is
 * deleted.
 * :::
 *
 * ### Databases, volumes, and buckets
 * Postgres/Redis/MySQL/Mongo group as services (`serviceId`). Volumes and
 * buckets are accepted as members (`volumeId` / `bucketId`).
 *
 * **Example:** Group a database and API
 * ```typescript
 * const db = yield* Railway.Postgres("Db", { project: site });
 * const backend = yield* Railway.Group("Backend", {
 *   project: site,
 *   resources: [api, db],
 * });
 * ```
 *
 * ### Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Group
 * ```typescript
 * // src/backend.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Api = Railway.Service("Api", {
 *   project: Site,
 *   image: "hashicorp/http-echo",
 * });
 * export const Backend = Railway.Group("Backend", {
 *   project: Site,
 *   resources: [Api],
 * });
 * ```
 *
 * @resource
 */
export const Group: typeof GroupResource = Object.assign(
  (
    id: string,
    props: GroupProps | Effect.Effect<GroupProps, never, Providers>,
  ) => GroupResource(id, resolveGroupProps(props)),
  GroupResource,
);

export class GroupProjectRequired extends Data.TaggedError(
  "Railway.GroupProjectRequired",
)<{
  message: string;
}> {}

export class GroupEnvironmentRequired extends Data.TaggedError(
  "Railway.GroupEnvironmentRequired",
)<{
  message: string;
}> {}

class GroupPending extends Data.TaggedError("Railway.GroupPending")<{
  groupId: string;
  state: string;
}> {}

type GroupConfig = {
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  isCollapsed?: boolean | null;
  isDeleted?: boolean | null;
  isCreated?: boolean | null;
  groupId?: string | null;
};

type ServiceConfig = {
  groupId?: string | null;
  isDeleted?: boolean | null;
};

type BucketConfig = {
  groupId?: string | null;
  isDeleted?: boolean | null;
};

type EnvironmentConfigShape = {
  groups?: Record<string, GroupConfig | null> | null;
  services?: Record<string, ServiceConfig | null> | null;
  buckets?: Record<string, BucketConfig | null> | null;
};

type CloudGroup = {
  groupId: string;
  name: string;
  color: string | undefined;
  icon: string | undefined;
  collapsed: boolean;
  serviceIds: string[];
  volumeIds: string[];
  bucketIds: string[];
};

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const uniqueSorted = (ids: readonly string[]): string[] =>
  Array.from(new Set(ids.filter((id) => id.length > 0))).sort();

const sameIds = (left: readonly string[], right: readonly string[]) =>
  uniqueSorted(left).join("\0") === uniqueSorted(right).join("\0");

const classifyMember = (
  member: GroupMember | null | undefined,
):
  | { kind: "service"; id: string }
  | { kind: "volume"; id: string }
  | { kind: "bucket"; id: string }
  | undefined => {
  if (member == null) return undefined;
  if (typeof member.serviceId === "string" && member.serviceId.length > 0) {
    return { kind: "service", id: member.serviceId };
  }
  if (typeof member.bucketId === "string" && member.bucketId.length > 0) {
    return { kind: "bucket", id: member.bucketId };
  }
  if (typeof member.volumeId === "string" && member.volumeId.length > 0) {
    return { kind: "volume", id: member.volumeId };
  }
  return undefined;
};

const membersOf = (resources: readonly GroupMember[] | undefined) => {
  const serviceIds: string[] = [];
  const volumeIds: string[] = [];
  const bucketIds: string[] = [];
  for (const resource of resources ?? []) {
    const classified = classifyMember(resource);
    if (classified === undefined) continue;
    if (classified.kind === "service") serviceIds.push(classified.id);
    else if (classified.kind === "volume") volumeIds.push(classified.id);
    else bucketIds.push(classified.id);
  }
  return {
    serviceIds: uniqueSorted(serviceIds),
    volumeIds: uniqueSorted(volumeIds),
    bucketIds: uniqueSorted(bucketIds),
  };
};

const parseRecord = <T>(
  value: unknown,
): Record<string, T | null> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T | null>)
    : undefined;

const parseEnvironmentConfig = (value: unknown): EnvironmentConfigShape => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const rec = value as {
    groups?: unknown;
    services?: unknown;
    buckets?: unknown;
  };
  return {
    groups: parseRecord<GroupConfig>(rec.groups),
    services: parseRecord<ServiceConfig>(rec.services),
    buckets: parseRecord<BucketConfig>(rec.buckets),
  };
};

/**
 * Railway stores canvas grouping as `{ [resourceId]: groupId }`
 * (`environment.canvasGroupRefs[volume.id]` in railway/iac).
 */
const parseCanvasGroupRefs = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.length > 0) {
      out[key] = item;
      continue;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const rec = item as { groupId?: unknown };
      if (typeof rec.groupId === "string" && rec.groupId.length > 0) {
        out[key] = rec.groupId;
      }
    }
  }
  return out;
};

const idsForGroup = (
  refs: Record<string, string>,
  groupId: string,
): string[] => {
  const ids: string[] = [];
  for (const [resourceId, assigned] of Object.entries(refs)) {
    if (assigned === groupId) ids.push(resourceId);
  }
  return uniqueSorted(ids);
};

const groupRow = (
  config: EnvironmentConfigShape,
  groupId: string,
): GroupConfig | undefined => {
  const row = config.groups?.[groupId];
  if (row === undefined || row === null || row.isDeleted === true) {
    return undefined;
  }
  return row;
};

const servicesForGroup = (
  config: EnvironmentConfigShape,
  groupId: string,
): string[] => {
  const services = config.services;
  if (services === undefined || services === null) return [];
  const ids: string[] = [];
  for (const [serviceId, row] of Object.entries(services)) {
    if (row === null || row.isDeleted === true) continue;
    if (row.groupId === groupId) ids.push(serviceId);
  }
  return uniqueSorted(ids);
};

const bucketsForGroup = (
  config: EnvironmentConfigShape,
  groupId: string,
): string[] => {
  const buckets = config.buckets;
  if (buckets === undefined || buckets === null) return [];
  const ids: string[] = [];
  for (const [bucketId, row] of Object.entries(buckets)) {
    if (row === null || row.isDeleted === true) continue;
    if (row.groupId === groupId) ids.push(bucketId);
  }
  return uniqueSorted(ids);
};

const liveServicesForGroup = (
  services: readonly ProjectResponseServicesEdgesItemNode[],
  groupId: string,
): string[] =>
  uniqueSorted(
    services
      .filter(
        (service) => service.deletedAt == null && service.groupId === groupId,
      )
      .map((service) => service.id),
  );

const liveBucketsForGroup = (
  buckets: readonly ProjectResponseBucketsEdgesItemNode[],
  groupId: string,
): string[] =>
  uniqueSorted(
    buckets
      .filter((bucket) => bucket.groupId === groupId)
      .map((bucket) => bucket.id),
  );

const optionalString = (value: string | null | undefined) =>
  value !== null && value !== undefined && value.length > 0 ? value : undefined;

const volumeIdsOf = (env: EnvironmentResponse | undefined): string[] => {
  if (env === undefined) return [];
  const ids: string[] = [];
  for (const edge of env.volumeInstances.edges) {
    const node = edge.node;
    if (node.deletedAt != null || node.state === "DELETED") continue;
    ids.push(node.volumeId, node.volume.id, node.id);
  }
  return uniqueSorted(ids);
};

const toAttrs = (
  group: CloudGroup,
  extra: { projectId: string; environmentId: string },
): Group["Attributes"] => ({
  groupId: group.groupId,
  projectId: extra.projectId,
  environmentId: extra.environmentId,
  name: group.name,
  color: group.color,
  icon: group.icon,
  collapsed: group.collapsed,
  serviceIds: group.serviceIds,
  volumeIds: group.volumeIds,
  bucketIds: group.bucketIds,
});

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined && name.trim().length > 0) return name.trim();
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createRailwayName(id);
  });

const getProject = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) => (project.deletedAt != null ? undefined : project)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined as ProjectResponse | undefined),
    ),
  );

const getEnvironment = (environmentId: string, projectId: string) =>
  railway
    .environment({ id: environmentId, projectId })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const getEnvironmentConfig = (environmentId: string, projectId: string) =>
  getEnvironment(environmentId, projectId).pipe(
    Effect.map((env) =>
      env === undefined
        ? ({} as EnvironmentConfigShape)
        : parseEnvironmentConfig(env.config),
    ),
  );

const listEnvironmentIds = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments.items({ projectId: project.projectId, first: 50 }).pipe(
    Stream.filter((env) => env.deletedAt == null),
    Stream.map((env) => env.id),
    Stream.runCollect,
    Effect.map((ids) => {
      const set = new Set(Array.from(ids));
      if (project.environmentId.length > 0) {
        set.add(project.environmentId);
      }
      return Array.from(set);
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(
        project.environmentId.length > 0 ? [project.environmentId] : [],
      ),
    ),
  );

const commitPatch = (input: {
  environmentId: string;
  commitMessage: string;
  patch: Record<string, unknown>;
}) =>
  withEnvironmentConfigLock(
    input.environmentId,
    railway.environmentPatchCommit({
      environmentId: input.environmentId,
      commitMessage: input.commitMessage,
      patch: input.patch,
    }),
  ).pipe(
    Effect.catchTag(["RailwayValidationError", "RailwayInternalError"], () =>
      Effect.succeed(""),
    ),
  );

const previewCanvas = (environmentId: string) =>
  railway
    .canvasViewMergePreview({
      sourceEnvironmentId: environmentId,
      targetEnvironmentId: environmentId,
    })
    .pipe(
      Effect.catchTag(
        [
          "RailwayNotFound",
          "NotFound",
          "RailwayValidationError",
          "RailwayInternalError",
        ],
        () => Effect.succeed(undefined),
      ),
    );

const mergeCanvas = (
  sourceEnvironmentId: string,
  targetEnvironmentId: string,
) =>
  railway
    .canvasViewMerge({
      sourceEnvironmentId,
      targetEnvironmentId,
    })
    .pipe(
      Effect.catchTag(
        [
          "RailwayNotFound",
          "NotFound",
          "RailwayValidationError",
          "RailwayInternalError",
        ],
        () => Effect.succeed(false),
      ),
    );

const projectGroups = (project: ProjectResponse | undefined) =>
  project?.groups.edges.map((edge) => edge.node) ?? [];

const projectServices = (project: ProjectResponse | undefined) =>
  project?.services.edges.map((edge) => edge.node) ?? [];

const projectBuckets = (project: ProjectResponse | undefined) =>
  project?.buckets.edges.map((edge) => edge.node) ?? [];

const matchProjectGroup = (
  groups: readonly ProjectResponseGroupsEdgesItemNode[],
  match: { groupId?: string; name?: string },
) => {
  if (match.groupId !== undefined && match.groupId.length > 0) {
    const byId = groups.find((group) => group.id === match.groupId);
    if (byId !== undefined) return byId;
  }
  if (match.name !== undefined && match.name.length > 0) {
    return groups.find((group) => group.name === match.name);
  }
  return undefined;
};

const matchConfigGroup = (
  config: EnvironmentConfigShape,
  match: { groupId?: string; name?: string },
): { groupId: string; row: GroupConfig } | undefined => {
  const groups = config.groups;
  if (groups === undefined || groups === null) return undefined;
  if (match.groupId !== undefined && match.groupId.length > 0) {
    const row = groupRow(config, match.groupId);
    if (row !== undefined) return { groupId: match.groupId, row };
  }
  if (match.name !== undefined && match.name.length > 0) {
    for (const [groupId, row] of Object.entries(groups)) {
      if (row === null || row.isDeleted === true) continue;
      if (row.name === match.name) return { groupId, row };
    }
  }
  return undefined;
};

const observe = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  groupId?: string;
  name?: string;
  volumeIds?: readonly string[];
}) {
  const env = yield* getEnvironment(input.environmentId, input.projectId);
  if (env === undefined || env.deletedAt != null) return undefined;
  const config = parseEnvironmentConfig(env.config);
  const project = yield* getProject(input.projectId);
  const fromConfig = matchConfigGroup(config, input);
  const fromProject = matchProjectGroup(projectGroups(project), input);
  const groupId = fromConfig?.groupId ?? fromProject?.id ?? input.groupId;
  if (groupId === undefined || groupId.length === 0) return undefined;

  const row = fromConfig?.row;
  const canvasRefs = parseCanvasGroupRefs(env.canvasGroupRefs);
  const fromCanvas = idsForGroup(canvasRefs, groupId);
  const knownServices = projectServices(project);
  const knownBuckets = projectBuckets(project);
  const knownVolumeIds = new Set([
    ...volumeIdsOf(env),
    ...(input.volumeIds ?? []),
  ]);
  const knownServiceIds = new Set(knownServices.map((service) => service.id));
  const knownBucketIds = new Set(knownBuckets.map((bucket) => bucket.id));

  const serviceIds = uniqueSorted([
    ...servicesForGroup(config, groupId),
    ...liveServicesForGroup(knownServices, groupId),
    ...fromCanvas.filter((id) => knownServiceIds.has(id)),
  ]);
  const bucketIds = uniqueSorted([
    ...bucketsForGroup(config, groupId),
    ...liveBucketsForGroup(knownBuckets, groupId),
    ...fromCanvas.filter((id) => knownBucketIds.has(id)),
  ]);
  const volumeIds = uniqueSorted([
    ...(input.volumeIds ?? []).filter((id) => canvasRefs[id] === groupId),
    ...fromCanvas.filter(
      (id) =>
        knownVolumeIds.has(id) ||
        (!knownServiceIds.has(id) && !knownBucketIds.has(id)),
    ),
  ]);

  const name =
    optionalString(row?.name ?? fromProject?.name) ?? input.name ?? "";
  if (fromConfig === undefined && fromProject === undefined) {
    if (
      serviceIds.length === 0 &&
      bucketIds.length === 0 &&
      volumeIds.length === 0
    ) {
      return undefined;
    }
  }

  return {
    groupId,
    name,
    color: optionalString(row?.color ?? fromProject?.color),
    icon: optionalString(row?.icon ?? fromProject?.icon),
    collapsed: (row?.isCollapsed ?? fromProject?.isCollapsed) === true,
    serviceIds,
    volumeIds,
    bucketIds,
  } satisfies CloudGroup;
});

const waitUntilPresent = (input: {
  projectId: string;
  environmentId: string;
  groupId: string;
  name: string;
  volumeIds?: readonly string[];
}) =>
  observe({
    projectId: input.projectId,
    environmentId: input.environmentId,
    groupId: input.groupId,
    name: input.name,
    volumeIds: input.volumeIds,
  }).pipe(
    Effect.flatMap((group) => {
      if (group === undefined) {
        return Effect.fail(
          new GroupPending({ groupId: input.groupId, state: "creating" }),
        );
      }
      return Effect.succeed(group);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.GroupPending",
      times: 4,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("Railway.GroupPending", () =>
      observe({
        projectId: input.projectId,
        environmentId: input.environmentId,
        groupId: input.groupId,
        name: input.name,
        volumeIds: input.volumeIds,
      }),
    ),
  );

const waitUntilGone = (input: {
  projectId: string;
  environmentId: string;
  groupId: string;
  name: string;
}) =>
  observe({
    projectId: input.projectId,
    environmentId: input.environmentId,
    groupId: input.groupId,
    name: input.name,
  }).pipe(
    Effect.map((group) => group === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 4,
    }),
  );

const groupPatch = (input: {
  groupId: string;
  name: string;
  color?: string;
  icon?: string;
  collapsed: boolean;
  create: boolean;
  remove?: boolean;
}): Record<string, GroupConfig> => ({
  [input.groupId]: input.remove
    ? { isDeleted: true }
    : {
        name: input.name,
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        isCollapsed: input.collapsed,
        ...(input.create ? { isCreated: true } : {}),
      },
});

const servicePatch = (
  assignments: ReadonlyArray<{ serviceId: string; groupId: string | null }>,
): Record<string, { groupId: string | null }> => {
  const out: Record<string, { groupId: string | null }> = {};
  for (const row of assignments) {
    out[row.serviceId] = { groupId: row.groupId };
  }
  return out;
};

const bucketPatch = (
  assignments: ReadonlyArray<{ bucketId: string; groupId: string | null }>,
): Record<string, { groupId: string | null }> => {
  const out: Record<string, { groupId: string | null }> = {};
  for (const row of assignments) {
    out[row.bucketId] = { groupId: row.groupId };
  }
  return out;
};

const membershipPatch = (input: {
  groupId: string;
  name: string;
  color?: string;
  icon?: string;
  collapsed: boolean;
  create: boolean;
  remove?: boolean;
  services?: ReadonlyArray<{ serviceId: string; groupId: string | null }>;
  buckets?: ReadonlyArray<{ bucketId: string; groupId: string | null }>;
}): Record<string, unknown> => {
  const patch: Record<string, unknown> = {
    groups: groupPatch(input),
  };
  if (input.services !== undefined && input.services.length > 0) {
    patch.services = servicePatch(input.services);
  }
  if (input.buckets !== undefined && input.buckets.length > 0) {
    patch.buckets = bucketPatch(input.buckets);
  }
  return patch;
};

const fallbackGroup = (input: {
  groupId: string;
  name: string;
  color?: string;
  icon?: string;
  collapsed: boolean;
  serviceIds: readonly string[];
  volumeIds: readonly string[];
  bucketIds: readonly string[];
}): CloudGroup => ({
  groupId: input.groupId,
  name: input.name,
  color: input.color,
  icon: input.icon,
  collapsed: input.collapsed,
  serviceIds: uniqueSorted(input.serviceIds),
  volumeIds: uniqueSorted(input.volumeIds),
  bucketIds: uniqueSorted(input.bucketIds),
});

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["groupId", "projectId", "environmentId"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextProject = projectIdOf(news.project);
      const projectChanged =
        nextProject !== undefined && nextProject !== output.projectId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      if (projectChanged || environmentChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      const environmentId =
        output?.environmentId ??
        (olds !== undefined
          ? (environmentIdOf(olds.environment) ?? environmentIdOf(olds.project))
          : undefined);
      if (projectId === undefined || environmentId === undefined) {
        return undefined;
      }
      const name = yield* resolveName(id, olds?.name, output?.name);
      const desired = membersOf(
        (olds?.resources as readonly GroupMember[] | undefined) ?? [],
      );
      const found = yield* observe({
        projectId,
        environmentId,
        groupId: output?.groupId,
        name,
        volumeIds: output?.volumeIds ?? desired.volumeIds,
      });
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, { projectId, environmentId });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        railway.project({ id: project.projectId }).pipe(
          Effect.map((live) =>
            live.groups.edges.flatMap((edge) => {
              const group = edge.node;
              const name = group.name ?? "";
              if (!matchesAlchemyPhysicalName(name)) return [];
              return [
                toAttrs(
                  {
                    groupId: group.id,
                    name,
                    color: group.color ?? undefined,
                    icon: group.icon ?? undefined,
                    collapsed: group.isCollapsed === true,
                    serviceIds: [] as string[],
                    volumeIds: [] as string[],
                    bucketIds: [] as string[],
                  },
                  {
                    projectId: project.projectId,
                    environmentId: project.environmentId,
                  },
                ),
              ];
            }),
          ),
          Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
            Effect.succeed([] as Group["Attributes"][]),
          ),
        ),
      );
      const seen = new Set<string>();
      const unique: Group["Attributes"][] = [];
      for (const row of rows.flat()) {
        const key = `${row.groupId}:${row.environmentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as GroupProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new GroupProjectRequired({
          message: "Group requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new GroupEnvironmentRequired({
          message:
            "Group requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const desired = membersOf(props.resources as readonly GroupMember[]);
      const collapsed = props.collapsed ?? output?.collapsed ?? false;

      let current = yield* observe({
        projectId,
        environmentId,
        groupId: output?.groupId,
        name,
        volumeIds: desired.volumeIds,
      });

      // Railway IaC keys new groups by name (`isCreated: true`) and stamps
      // `service.groupId = name`. After apply, Railway remaps the key to a
      // UUID — observe-by-name picks that up.
      const groupId = current?.groupId ?? output?.groupId ?? name;

      if (current === undefined) {
        yield* commitPatch({
          environmentId,
          commitMessage: `Alchemy: create group ${name}`,
          patch: membershipPatch({
            groupId,
            name,
            color: props.color,
            icon: props.icon,
            collapsed,
            create: true,
            services: desired.serviceIds.map((serviceId) => ({
              serviceId,
              groupId,
            })),
          }),
        });
        if (desired.bucketIds.length > 0) {
          yield* commitPatch({
            environmentId,
            commitMessage: `Alchemy: assign buckets to group ${name}`,
            patch: {
              buckets: bucketPatch(
                desired.bucketIds.map((bucketId) => ({
                  bucketId,
                  groupId,
                })),
              ),
            },
          });
        }
        current =
          (yield* waitUntilPresent({
            projectId,
            environmentId,
            groupId,
            name,
            volumeIds: desired.volumeIds,
          })) ?? undefined;
      }

      if (current !== undefined) {
        const nameChanged = current.name !== name;
        const colorChanged =
          props.color !== undefined && props.color !== current.color;
        const iconChanged =
          props.icon !== undefined && props.icon !== current.icon;
        const collapsedChanged =
          props.collapsed !== undefined && collapsed !== current.collapsed;
        const servicesChanged = !sameIds(
          current.serviceIds,
          desired.serviceIds,
        );
        const bucketsChanged = !sameIds(current.bucketIds, desired.bucketIds);
        if (
          nameChanged ||
          colorChanged ||
          iconChanged ||
          collapsedChanged ||
          servicesChanged ||
          bucketsChanged
        ) {
          const services = [
            ...desired.serviceIds
              .filter((serviceId) => !current!.serviceIds.includes(serviceId))
              .map((serviceId) => ({
                serviceId,
                groupId: current!.groupId,
              })),
            ...current.serviceIds
              .filter((serviceId) => !desired.serviceIds.includes(serviceId))
              .map((serviceId) => ({
                serviceId,
                groupId: null,
              })),
          ];
          const buckets = [
            ...desired.bucketIds
              .filter((bucketId) => !current!.bucketIds.includes(bucketId))
              .map((bucketId) => ({
                bucketId,
                groupId: current!.groupId,
              })),
            ...current.bucketIds
              .filter((bucketId) => !desired.bucketIds.includes(bucketId))
              .map((bucketId) => ({
                bucketId,
                groupId: null,
              })),
          ];
          yield* commitPatch({
            environmentId,
            commitMessage: `Alchemy: update group ${name}`,
            patch: membershipPatch({
              groupId: current.groupId,
              name,
              color: props.color ?? current.color,
              icon: props.icon ?? current.icon,
              collapsed,
              create: false,
              services,
              buckets,
            }),
          });
          current =
            (yield* observe({
              projectId,
              environmentId,
              groupId: current.groupId,
              name,
              volumeIds: desired.volumeIds,
            })) ?? current;
        }
      }

      const preview = yield* previewCanvas(environmentId);
      if (preview !== undefined && preview.mutations.length > 0) {
        yield* mergeCanvas(environmentId, environmentId);
      }

      const observed = yield* observe({
        projectId,
        environmentId,
        groupId: current?.groupId ?? groupId,
        name,
        volumeIds: desired.volumeIds,
      });

      const resolved = observed ?? current;
      return toAttrs(
        fallbackGroup({
          groupId: resolved?.groupId ?? groupId,
          name: resolved?.name || name,
          color: props.color ?? resolved?.color,
          icon: props.icon ?? resolved?.icon,
          collapsed: resolved?.collapsed ?? collapsed,
          serviceIds:
            resolved !== undefined && resolved.serviceIds.length > 0
              ? resolved.serviceIds
              : desired.serviceIds,
          volumeIds: uniqueSorted([
            ...(resolved?.volumeIds ?? []),
            ...desired.volumeIds,
          ]),
          bucketIds: uniqueSorted([
            ...(resolved?.bucketIds ?? []),
            ...desired.bucketIds,
          ]),
        }),
        { projectId, environmentId },
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const groupId = output.groupId;
      const environmentId = output.environmentId;
      const projectId = output.projectId;
      if (groupId.length === 0 || environmentId.length === 0) return;
      const current = yield* observe({
        projectId,
        environmentId,
        groupId,
        name: output.name,
        volumeIds: output.volumeIds,
      });
      if (current === undefined) return;
      yield* commitPatch({
        environmentId,
        commitMessage: `Alchemy: delete group ${output.name}`,
        patch: membershipPatch({
          groupId,
          name: output.name,
          collapsed: false,
          create: false,
          remove: true,
          services: current.serviceIds.map((serviceId) => ({
            serviceId,
            groupId: null,
          })),
          buckets: current.bucketIds.map((bucketId) => ({
            bucketId,
            groupId: null,
          })),
        }),
      }).pipe(
        Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
          Effect.succeed(""),
        ),
      );
      if (projectId.length > 0) {
        yield* waitUntilGone({
          projectId,
          environmentId,
          groupId,
          name: output.name,
        });
      }
    }),
  });
