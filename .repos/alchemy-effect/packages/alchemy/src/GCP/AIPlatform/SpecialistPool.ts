import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  locationParent,
  ownedByAlchemy,
  parseOwnership,
} from "./ownership.ts";

export type SpecialistPoolProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the pool.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Must be unique per project. Specialist pools
   * have no labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix.
   */
  displayName?: string;
  /**
   * Email addresses of specialist managers.
   */
  specialistManagerEmails?: string[];
  /**
   * Email addresses of specialist workers.
   */
  specialistWorkerEmails?: string[];
};

export type SpecialistPool = Resource<
  "GCP.AIPlatform.SpecialistPool",
  SpecialistPoolProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/specialistPools/{specialist_pool}`. */
    name: string;
    /** Pool id (last path segment). */
    specialistPoolId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Manager emails. */
    specialistManagerEmails: string[];
    /** Worker emails. */
    specialistWorkerEmails: string[];
    /** Number of managers. */
    specialistManagersCount: number | undefined;
    /** Pending data labeling jobs. */
    pendingDataLabelingJobs: string[];
  },
  never,
  Providers
>;

/**
 * A Vertex AI SpecialistPool of managers and workers for data labeling.
 *
 * Specialist pools have no labels field — Alchemy stamps ownership into
 * the display name. Location is immutable. Manager and worker emails
 * update in place.
 *
 * ### Creating a Pool
 * **Example:** Empty pool with a display name
 * ```typescript
 * const pool = yield* GCP.AIPlatform.SpecialistPool("Labelers", {
 *   displayName: "labelers",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const SpecialistPool = Resource<SpecialistPool>(
  "GCP.AIPlatform.SpecialistPool",
);

export class SpecialistPoolNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.SpecialistPoolNotResolved",
)<{
  name: string;
}> {}

const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].sort((left, right) => left.localeCompare(right));

const sameEmails = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

const toAttrs = (
  pool: aiplatform.GoogleCloudAiplatformV1SpecialistPool,
  project: string,
) => {
  const name = pool.name ?? "";
  const parsed = parseOwnership(pool.displayName);
  return {
    name,
    specialistPoolId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    specialistManagerEmails: pool.specialistManagerEmails ?? [],
    specialistWorkerEmails: pool.specialistWorkerEmails ?? [],
    specialistManagersCount: pool.specialistManagersCount,
    pendingDataLabelingJobs: pool.pendingDataLabelingJobs ?? [],
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsSpecialistPools({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((pool) =>
      pool
        ? Effect.succeed(pool)
        : Effect.fail(new SpecialistPoolNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.SpecialistPoolNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listAt = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsSpecialistPools
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.specialistPools ?? [])),
      Stream.filter((pool) => hasOwnershipMarker(pool.displayName)),
      Stream.map((pool) => toAttrs(pool, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  aiplatform.listProjectsLocationsSpecialistPools
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.specialistPools ?? [])),
      Stream.filter((pool) => pool.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const SpecialistPoolProvider = () =>
  Provider.succeed(SpecialistPool, {
    stables: ["name", "specialistPoolId", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (previousLocation !== undefined && previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.displayName))
          ? attrs
          : Unowned(attrs);
      }
      const location = olds?.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, olds?.displayName);
      const found = yield* findByDisplayName(parent, displayName);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, env.project);
      return (yield* ownedByAlchemy(id, found.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return (yield* Effect.forEach(listLocations(env.region), (location) =>
          listAt(locationParent(env.project, location), env.project),
        )).flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const managers = news.specialistManagerEmails;
      const workers = news.specialistWorkerEmails;

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsSpecialistPools({
            parent,
            body: {
              displayName,
              specialistManagerEmails: managers,
              specialistWorkerEmails: workers,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created, {
            alreadyExistsOk: true,
          });
          const createdName = resourceNameFromOperation(done) ?? "";
          if (createdName.length > 0) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findByDisplayName(parent, displayName);
        }
      }

      if (current === undefined) {
        return yield* new SpecialistPoolNotResolved({
          name: output?.name ?? `${parent}/specialistPools/-`,
        });
      }

      const name = current.name ?? "";
      const displayChanged = (current.displayName ?? "") !== displayName;
      const managersChanged = !sameEmails(
        current.specialistManagerEmails,
        managers,
      );
      const workersChanged = !sameEmails(
        current.specialistWorkerEmails,
        workers,
      );

      if (displayChanged || managersChanged || workersChanged) {
        const patched = yield* aiplatform.patchProjectsLocationsSpecialistPools(
          {
            name,
            updateMask: [
              displayChanged ? "displayName" : undefined,
              managersChanged ? "specialistManagerEmails" : undefined,
              workersChanged ? "specialistWorkerEmails" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name,
              displayName,
              specialistManagerEmails: managers,
              specialistWorkerEmails: workers,
            },
          },
        );
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsSpecialistPools({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
