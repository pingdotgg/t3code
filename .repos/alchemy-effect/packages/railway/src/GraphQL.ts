import { Query } from "@distilled.cloud/core/query";
import {
  Railway,
  type Bucket,
  type Group,
  type Service,
  type ServiceInstance,
  type VolumeInstance,
} from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Collect every node of a connection. `select` projects one node, e.g.
 * `(service) => ({ id: service.id, name: service.name })`.
 */
const collect = <Item, Error>(connection: Query<ReadonlyArray<Item> | null, Error>) =>
  Stream.runCollect(Query.items(connection)).pipe(Effect.map((items) => Array.from(items)));

/** Every service of a project, projected by `select`. */
export const projectServices = <Mapped>(
  projectId: string,
  select: (service: Query<Service>) => Mapped,
) => collect(Railway.project({ id: projectId }).services({ first: 50 }).pipe(Query.map(select)));

/** Every bucket of a project, projected by `select`. */
export const projectBuckets = <Mapped>(
  projectId: string,
  select: (bucket: Query<Bucket>) => Mapped,
) => collect(Railway.project({ id: projectId }).buckets({ first: 50 }).pipe(Query.map(select)));

/** Every group of a project, projected by `select`. */
export const projectGroups = <Mapped>(projectId: string, select: (group: Query<Group>) => Mapped) =>
  collect(Railway.project({ id: projectId }).groups({ first: 50 }).pipe(Query.map(select)));

const environmentDeleted = Query.fn((id: string, projectId: string) => ({
  deletedAt: Railway.environment({ id, projectId }).deletedAt,
}));

/** Volumes are read through their environment so access checks remain scoped. */
export const environmentVolumes = <Mapped>(
  environmentId: string,
  projectId: string,
  select: (volume: Query<VolumeInstance>) => Mapped,
) =>
  Effect.gen(function* () {
    const { deletedAt } = yield* environmentDeleted(environmentId, projectId);
    if (deletedAt !== null) return [];
    return yield* collect(
      Railway.environment({ id: environmentId, projectId })
        .volumeInstances({ first: 50 })
        .pipe(Query.map(select)),
    );
  });

/** Enumerate existing service instances without probing absent service/environment pairs. */
export const environmentServiceInstances = <Mapped>(
  environmentId: string,
  projectId: string,
  select: (instance: Query<ServiceInstance>) => Mapped,
) =>
  Effect.gen(function* () {
    const { deletedAt } = yield* environmentDeleted(environmentId, projectId);
    if (deletedAt !== null) return [];
    return yield* collect(
      Railway.environment({ id: environmentId, projectId })
        .serviceInstances({ first: 50 })
        .pipe(Query.map(select)),
    );
  });

/** A delete remains pending until its read path confirms absence. */
export class ResourceDeletionPending extends Data.TaggedError("Railway.ResourceDeletionPending")<{
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
    Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (gone) => gone, times }),
    Effect.flatMap((gone) =>
      gone ? Effect.void : Effect.fail(new ResourceDeletionPending({ resourceType, resourceId })),
    ),
  );
