import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
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
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import {
  hasAlchemyLabelKeys,
  isJobTerminal,
  normalizeLocation,
  parentOf,
  parseResourceName,
  rfc1035,
  userLabels,
  waitForOperation,
} from "./internal.ts";
import type { EncryptionSpec } from "./shared.ts";

export type CustomJobSpec = aiplatform.GoogleCloudAiplatformV1CustomJobSpec;

export type CustomJobProps = {
  /**
   * Region. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name (max 128 characters). Defaults to a generated
   * id. Immutable after create — CustomJob has no update API.
   */
  displayName?: string;
  /**
   * Worker pools, container/python spec, networking, and scheduling.
   * Required. Immutable after create.
   */
  jobSpec: CustomJobSpec;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Set at create; CustomJob cannot patch labels.
   */
  labels?: Record<string, string>;
  /**
   * Customer-managed encryption. Immutable after create.
   */
  encryptionSpec?: EncryptionSpec;
};

export type CustomJob = Resource<
  "GCP.AIPlatform.CustomJob",
  CustomJobProps,
  {
    /** Full resource name `.../customJobs/{custom_job}`. */
    name: string;
    /** Custom job id (last path segment). */
    customJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Job spec as stored by Vertex. */
    jobSpec: CustomJobSpec | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Detailed job state. */
    state: string | undefined;
    /** Customer-managed KMS key, if any. */
    kmsKeyName: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Failure/cancel status, if any. */
    error: { code?: number; message?: string } | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI CustomJob — a container or Python training workload.
 *
 * Creating a CustomJob starts it immediately. There is no update API, so
 * reconcile is observe-ensure (create if missing). Delete cancels a
 * running job, then deletes it. Alchemy ownership labels are merged into
 * `labels` so `list` / nuke can find the job.
 *
 * ### Creating a Custom Job
 * **Example:** Single-worker container job
 * ```typescript
 * const job = yield* GCP.AIPlatform.CustomJob("Train", {
 *   displayName: "echo-train",
 *   jobSpec: {
 *     workerPoolSpecs: [
 *       {
 *         machineSpec: { machineType: "n1-standard-4" },
 *         replicaCount: "1",
 *         containerSpec: {
 *           imageUri: "gcr.io/google-samples/hello-app:1.0",
 *           command: ["echo"],
 *           args: ["ok"],
 *         },
 *       },
 *     ],
 *     scheduling: { timeout: "600s" },
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const CustomJob = Resource<CustomJob>("GCP.AIPlatform.CustomJob");

export class CustomJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.CustomJobNotResolved",
)<{
  name: string;
}> {}

const toId = (id: string, existing?: string) =>
  Effect.gen(function* () {
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const toAttrs = (
  job: aiplatform.GoogleCloudAiplatformV1CustomJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, "customJobs");
  return {
    name,
    customJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: job.displayName,
    jobSpec: job.jobSpec,
    labels: userLabels(job.labels),
    state: job.state,
    kmsKeyName: job.encryptionSpec?.kmsKeyName,
    createTime: job.createTime,
    startTime: job.startTime,
    endTime: job.endTime,
    updateTime: job.updateTime,
    error: job.error
      ? { code: job.error.code, message: job.error.message }
      : undefined,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsCustomJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listJobs = (project: string, region: string) => {
  const collect = (parent: string) =>
    aiplatform.listProjectsLocationsCustomJobs
      .pages({ parent, pageSize: 100 })
      .pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.customJobs ?? [])),
        Stream.filter((job) => hasAlchemyLabelKeys(job.labels)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
  const fallback = Effect.forEach(listLocations(region), (location) =>
    collect(`projects/${project}/locations/${location}`),
  ).pipe(Effect.map((pages) => pages.flat()));
  // Vertex AI has no `locations/-` wildcard; scan known locations.
  return fallback.pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
};

const findOwned = (
  id: string,
  project: string,
  region: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const jobs = yield* listJobs(project, region);
    for (const job of jobs) {
      if (yield* hasAlchemyLabels(id, tagRecord(job.labels))) return job;
    }
    return undefined as aiplatform.GoogleCloudAiplatformV1CustomJob | undefined;
  });

const cancelAndDelete = (name: string) =>
  Effect.gen(function* () {
    const existing = yield* getByName(name);
    if (existing === undefined) return;
    if (!isJobTerminal(existing.state)) {
      yield* aiplatform
        .cancelProjectsLocationsCustomJobs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(name).pipe(
        Effect.filterOrFail(
          (job) => job === undefined || isJobTerminal(job.state),
          () => new CustomJobNotResolved({ name }),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.AIPlatform.CustomJobNotResolved",
          times: 8,
          schedule: Schedule.spaced("4 seconds"),
        }),
        Effect.catchTag(
          "GCP.AIPlatform.CustomJobNotResolved",
          () => Effect.void,
        ),
      );
    }
    const operation = yield* aiplatform
      .deleteProjectsLocationsCustomJobs({ name })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("3 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
      );
    if (operation !== undefined) {
      yield* waitForOperation(operation, { notFoundOk: true });
    }
  });

export const CustomJobProvider = () =>
  Provider.succeed(CustomJob, {
    stables: ["name", "customJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwned(
        id,
        env.project,
        env.region,
        output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const jobs = yield* listJobs(env.project, env.region);
        return jobs.map((job) => toAttrs(job, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const displayName =
        news.displayName ?? (yield* toId(id, output?.customJobId));
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* findOwned(id, env.project, env.region, output?.name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsCustomJobs({
            parent: parentOf(env.project, location),
            body: {
              displayName,
              jobSpec: news.jobSpec,
              labels: desiredLabels,
              encryptionSpec: news.encryptionSpec,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, env.project, env.region),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CustomJobNotResolved({
          name: output?.name ?? parentOf(env.project, location),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cancelAndDelete(output.name);
    }),
  });
