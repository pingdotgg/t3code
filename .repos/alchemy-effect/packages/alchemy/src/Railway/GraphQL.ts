import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export class InvalidConnectionCursor extends Data.TaggedError(
  "Railway.InvalidConnectionCursor",
)<{
  connection: string;
  cursor: string | null;
}> {}

const advance = (
  connection: string,
  page: { hasNextPage: boolean; endCursor: string | null },
  seen: Set<string>,
) => {
  if (!page.hasNextPage) return Effect.succeed(undefined);
  if (page.endCursor === null || seen.has(page.endCursor)) {
    return Effect.fail(
      new InvalidConnectionCursor({ connection, cursor: page.endCursor }),
    );
  }
  seen.add(page.endCursor);
  return Effect.succeed(page.endCursor);
};

/** Walk the nested service connection, retaining the caller's exact projection. */
export const projectServices = <const S extends railway.Selection<"Service">>(
  projectId: string,
  select: S,
) =>
  Effect.gen(function* () {
    const rows: railway.Result<"Service!", S>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const project = yield* railway.project(
        { id: projectId },
        {
          services: {
            where: { first: 50, after },
            select: {
              edges: { node: { select } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          },
        },
      );
      rows.push(...project.services.edges.map((edge) => edge.node));
      after = yield* advance(
        "Project.services",
        project.services.pageInfo,
        seen,
      );
    } while (after !== undefined);
    return rows;
  });

/** Volumes are read through their environment so access checks remain scoped. */
export const environmentVolumes = <
  const S extends railway.Selection<"VolumeInstance">,
>(
  environmentId: string,
  projectId: string,
  select: S,
) =>
  Effect.gen(function* () {
    const rows: railway.Result<"VolumeInstance!", S>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const environment = yield* railway.environment(
        { id: environmentId, projectId },
        {
          deletedAt: true,
          volumeInstances: {
            where: { first: 50, after },
            select: {
              edges: { node: { select } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          },
        },
      );
      if (environment.deletedAt !== null) return [];
      rows.push(...environment.volumeInstances.edges.map((edge) => edge.node));
      after = yield* advance(
        "Environment.volumeInstances",
        environment.volumeInstances.pageInfo,
        seen,
      );
    } while (after !== undefined);
    return rows;
  });
/** Enumerate existing service instances without probing absent service/environment pairs. */
export const environmentServiceInstances = <
  const S extends railway.Selection<"ServiceInstance">,
>(
  environmentId: string,
  projectId: string,
  select: S,
) =>
  Effect.gen(function* () {
    const rows: railway.Result<"ServiceInstance!", S>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const environment = yield* railway.environment(
        { id: environmentId, projectId },
        {
          deletedAt: true,
          serviceInstances: {
            where: { first: 50, after },
            select: {
              edges: { node: { select } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          },
        },
      );
      if (environment.deletedAt !== null) return [];
      rows.push(...environment.serviceInstances.edges.map((edge) => edge.node));
      after = yield* advance(
        "Environment.serviceInstances",
        environment.serviceInstances.pageInfo,
        seen,
      );
    } while (after !== undefined);
    return rows;
  });
/** Walk the nested bucket connection, retaining the caller's exact projection. */
export const projectBuckets = <const S extends railway.Selection<"Bucket">>(
  projectId: string,
  select: S,
) =>
  Effect.gen(function* () {
    const rows: railway.Result<"Bucket!", S>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const project = yield* railway.project(
        { id: projectId },
        {
          buckets: {
            where: { first: 50, after },
            select: {
              edges: { node: { select } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          },
        },
      );
      rows.push(...project.buckets.edges.map((edge) => edge.node));
      after = yield* advance("Project.buckets", project.buckets.pageInfo, seen);
    } while (after !== undefined);
    return rows;
  });

/** Walk the nested group connection, retaining the caller's exact projection. */
export const projectGroups = <const S extends railway.Selection<"Group">>(
  projectId: string,
  select: S,
) =>
  Effect.gen(function* () {
    const rows: railway.Result<"Group!", S>[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    do {
      const project = yield* railway.project(
        { id: projectId },
        {
          groups: {
            where: { first: 50, after },
            select: {
              edges: { node: { select } },
              pageInfo: { hasNextPage: true, endCursor: true },
            },
          },
        },
      );
      rows.push(...project.groups.edges.map((edge) => edge.node));
      after = yield* advance("Project.groups", project.groups.pageInfo, seen);
    } while (after !== undefined);
    return rows;
  });

/** A delete remains pending until its read path confirms absence. */
export class ResourceDeletionPending extends Data.TaggedError(
  "Railway.ResourceDeletionPending",
)<{
  resourceType: string;
  resourceId: string;
}> {}

export const waitUntilDeleted = <E, R>(
  resourceType: string,
  resourceId: string,
  absent: Effect.Effect<boolean, E, R>,
  times: 4 | 8 | 10 = 8,
) =>
  absent.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times,
    }),
    Effect.flatMap((gone) =>
      gone
        ? Effect.void
        : Effect.fail(
            new ResourceDeletionPending({ resourceType, resourceId }),
          ),
    ),
  );
