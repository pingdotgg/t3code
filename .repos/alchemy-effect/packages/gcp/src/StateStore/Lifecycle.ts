import * as storage from "@distilled.cloud/gcp/storage_v1";
import type { StateStoreImpl, StateStoreLifecycle } from "alchemy/Contributions";
import * as Provisioning from "alchemy/State/Provisioning";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  createStateBucketName,
  provisionStateBucket,
  state,
  stateBucketExists,
  stateEnvironment,
} from "./State.ts";

/**
 * Ensure a state bucket (by default the project's) with the settings first
 * use would give it.
 */
const bootstrapStateBucket = Effect.fn("GCP.state.bootstrap")(function* (name?: string) {
  const { project, region } = yield* GcpEnvironment.current;
  if (name !== undefined) yield* Provisioning.storeName(name);
  const bucketName = createStateBucketName(project, name);
  const existed = yield* stateBucketExists(bucketName);
  yield* provisionStateBucket(bucketName, project, region);
  return { project, region, bucketName, existed };
});

/**
 * Empty and delete a state bucket (by default the project's), every object
 * generation included. A missing bucket is not an error.
 */
const teardownStateBucket = Effect.fn("GCP.state.teardown")(function* (name?: string) {
  const { project } = yield* GcpEnvironment.current;
  if (name !== undefined) yield* Provisioning.storeName(name);
  const bucketName = createStateBucketName(project, name);
  if (!(yield* stateBucketExists(bucketName))) {
    return { bucketName, deleted: false };
  }
  yield* storage.listObjects.pages({ bucket: bucketName, versions: true }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
    Stream.runForEach((object) =>
      object.name === undefined
        ? Effect.void
        : storage
            .deleteObjects({
              bucket: bucketName,
              object: object.name,
              generation: object.generation,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void)),
    ),
  );
  yield* storage.deleteBuckets({ bucket: bucketName }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    // Deleted objects can take a moment to stop counting against the bucket.
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(6)]),
    }),
  );
  return { bucketName, deleted: true };
});

/** The GCP environment of the profile core runs the operation under. */
const environment = stateEnvironment();

/**
 * The Cloud Storage state store's lifecycle, for `alchemy state`. The store
 * also creates its bucket on first use, so bootstrapping is only needed to
 * provision it ahead of time (CI).
 */
export const lifecycle: StateStoreLifecycle = {
  bootstrap: ({ name }) =>
    bootstrapStateBucket(name).pipe(
      Effect.map(({ bucketName, project, region, existed }) => ({
        status: existed ? ("adopted" as const) : ("created" as const),
        store: bucketName,
        location: { account: project, region },
      })),
      Effect.provide(environment),
    ),
  teardown: ({ name }) =>
    teardownStateBucket(name).pipe(
      Effect.map(({ bucketName, deleted }) => ({ deleted: deleted ? [bucketName] : [] })),
      Effect.provide(environment),
    ),
};

/** The state store GCP contributes. */
export const stateStore: StateStoreImpl = { layer: state, lifecycle };
