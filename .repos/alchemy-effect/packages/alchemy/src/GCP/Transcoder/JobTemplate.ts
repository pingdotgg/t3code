import * as transcoder from "@distilled.cloud/gcp/transcoder_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configKey,
  desiredLabelsOf,
  getJobTemplate,
  JobTemplateNotResolved,
  JobTemplateStillExists,
  labelsKey,
  listOwnedJobTemplates,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  resourceName,
  toJobTemplateId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type JobConfig = transcoder.JobConfig;
export type ElementaryStream = transcoder.ElementaryStream;
export type MuxStream = transcoder.MuxStream;
export type AudioStream = transcoder.AudioStream;
export type VideoStream = transcoder.VideoStream;

export type JobTemplateProps = {
  /**
   * Job template id (the `{job_template}` segment of
   * `projects/{project}/locations/{location}/jobTemplates/{job_template}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. 4-63 characters matching `[a-zA-Z][a-zA-Z0-9_-]*`.
   * Immutable — changing it replaces the template.
   */
  jobTemplateId?: string;
  /**
   * Transcoder location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the template. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Transcoding configuration (elementary streams, mux streams, inputs,
   * outputs, manifests, …). The Transcoder API has no update method, so
   * changing `config` replaces the template.
   */
  config: JobConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * The API has no update method, so changing labels replaces the
   * template.
   */
  labels?: Record<string, string>;
};

export type JobTemplate = Resource<
  "GCP.Transcoder.JobTemplate",
  JobTemplateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/jobTemplates/{job_template}`. */
    name: string;
    /** Job template id (last path segment). */
    jobTemplateId: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** Project id. */
    project: string;
    /** Parent `projects/{project}/locations/{location}`. */
    parent: string;
    /** Transcoding configuration stored on the template. */
    config: JobConfig | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Transcoder API job template. Templates capture a reusable
 * `JobConfig` so jobs can be created with `templateId` instead of
 * repeating elementary/mux stream settings.
 *
 * The API exposes create, get, list, and delete only — there is no
 * patch. Changing `jobTemplateId`, `location`, `config`, or `labels`
 * replaces the template. Ownership is stamped with Alchemy labels so
 * `list` / nuke can find it.
 *
 * ### Creating a Job Template
 * **Example:** Generated id
 * ```typescript
 * const template = yield* GCP.Transcoder.JobTemplate("WebHd", {
 *   config: {
 *     elementaryStreams: [
 *       {
 *         key: "video-stream0",
 *         videoStream: {
 *           h264: {
 *             heightPixels: 360,
 *             widthPixels: 640,
 *             bitrateBps: 550000,
 *             frameRate: 30,
 *           },
 *         },
 *       },
 *       {
 *         key: "audio-stream0",
 *         audioStream: { codec: "aac", bitrateBps: 64000 },
 *       },
 *     ],
 *     muxStreams: [
 *       {
 *         key: "sd",
 *         container: "mp4",
 *         elementaryStreams: ["video-stream0", "audio-stream0"],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const template = yield* GCP.Transcoder.JobTemplate("WebHd", {
 *   jobTemplateId: "web-sd",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   config: {
 *     elementaryStreams: [
 *       {
 *         key: "video-stream0",
 *         videoStream: {
 *           h264: { bitrateBps: 550000, frameRate: 30 },
 *         },
 *       },
 *     ],
 *     muxStreams: [
 *       {
 *         key: "sd",
 *         container: "mp4",
 *         elementaryStreams: ["video-stream0"],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Creating a Job from a Template
 * **Example:** Start a transcode
 * ```typescript
 * const createJob = yield* GCP.Transcoder.CreateJob(template);
 * const job = yield* createJob({
 *   body: {
 *     inputUri: "gs://bucket/inputs/file.mp4",
 *     outputUri: "gs://bucket/outputs/",
 *   },
 * });
 * ```
 *
 * @resource
 * @category Transcoder
 */
export const JobTemplate = Resource<JobTemplate>("GCP.Transcoder.JobTemplate");

export { JobTemplateNotResolved, JobTemplateStillExists };

const toAttrs = (
  template: transcoder.JobTemplate,
  project: string,
  region: string,
) => {
  const name = template.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    jobTemplateId: parsed.jobTemplateId,
    location: parsed.location,
    project: parsed.project || project,
    parent: parsed.parent || locationParent(project, parsed.location),
    config: template.config,
    labels: userLabels(template.labels),
  };
};

export const JobTemplateProvider = () =>
  Provider.succeed(JobTemplate, {
    stables: ["name", "jobTemplateId", "location", "project", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.jobTemplateId ?? output?.jobTemplateId;
      const nextId = news.jobTemplateId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        previousId !== nextId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const locationChanged = previousLocation !== nextLocation;
      const configChanged =
        olds !== undefined && configKey(news.config) !== configKey(olds.config);
      const labelsChanged =
        olds !== undefined && labelsKey(news.labels) !== labelsKey(olds.labels);
      if (!idChanged && !locationChanged && !configChanged && !labelsChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst: !idChanged && !locationChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobTemplateId = yield* toJobTemplateId(
        id,
        olds?.jobTemplateId,
        output?.jobTemplateId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, jobTemplateId);
      const existing = yield* getJobTemplate(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedJobTemplates(env.project, env.region);
        return rows.map((row) => toAttrs(row, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobTemplateId = yield* toJobTemplateId(
        id,
        news.jobTemplateId,
        output?.jobTemplateId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const name = resourceName(env.project, location, jobTemplateId);
      const desiredLabels = yield* desiredLabelsOf(id, news.labels);

      let current = yield* getJobTemplate(name);

      if (current === undefined) {
        const created = yield* transcoder
          .createProjectsLocationsJobTemplates({
            parent,
            jobTemplateId,
            body: {
              name,
              config: news.config,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getJobTemplate(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new JobTemplateNotResolved({
          name: output?.name ?? name,
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* transcoder
        .deleteProjectsLocationsJobTemplates({
          name: output.name,
          allowMissing: true,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });
