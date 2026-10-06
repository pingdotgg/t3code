import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { waitForOperation } from "./operations.ts";
import {
  AiPlatformStillExists,
  MAX_PIPELINE_JOB_ID_LENGTH,
  collectPages,
  jsonEqual,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  type EncryptionSpec,
} from "./shared.ts";

const COLLECTION = "pipelineJobs";

export type PipelineRuntimeConfig = {
  /** Cloud Storage root for pipeline artifacts. */
  gcsOutputDirectory?: string;
  /** Runtime parameters (schema 2.1.0+). */
  parameterValues?: Record<string, unknown>;
  /** Failure policy (`PIPELINE_FAILURE_POLICY_FAIL_SLOW` / `_FAIL_FAST`). */
  failurePolicy?: string;
  /** Input artifacts keyed by name. */
  inputArtifacts?: Record<string, { artifactId?: string }>;
};

export type PipelineJobProps = {
  /**
   * Job id. If omitted, a unique RFC1035 name is generated. Less than
   * 128 characters, matching `/[a-z0-9-]+/`. Immutable — changing it
   * replaces the job (a new run is started).
   */
  pipelineJobId?: string;
  /**
   * Vertex AI location. Immutable — changing it replaces the job.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 UTF-8 characters). Defaults to the job id.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Compiled Kubeflow pipeline spec as a JSON object.
   */
  pipelineSpec?: Record<string, unknown>;
  /**
   * Template URI (Vertex Template Registry or Gallery). Used when
   * `pipelineSpec` is omitted.
   */
  templateUri?: string;
  /**
   * Runtime config (output directory, parameters, failure policy).
   */
  runtimeConfig?: PipelineRuntimeConfig;
  /**
   * Service account the pipeline runs as.
   */
  serviceAccount?: string;
  /**
   * VPC network to peer.
   */
  network?: string;
  /**
   * Reserved IP ranges under the VPC.
   */
  reservedIpRanges?: string[];
  /**
   * Customer-managed encryption key.
   */
  encryptionSpec?: EncryptionSpec;
  /**
   * Run component-level validations before create.
   */
  preflightValidations?: boolean;
};

export type PipelineJob = Resource<
  "GCP.AIPlatform.PipelineJob",
  PipelineJobProps,
  {
    /** Full resource name. */
    name: string;
    /** Job id (last path segment). */
    pipelineJobId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Pipeline state (`PIPELINE_STATE_RUNNING`, …). */
    state: string | undefined;
    /** Template URI. */
    templateUri: string | undefined;
    /** Service account. */
    serviceAccount: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI PipelineJob — a compiled Kubeflow pipeline that runs
 * immediately on create.
 *
 * There is no update API. Changing identity (`pipelineJobId`, `location`)
 * or the pipeline spec / template URI replaces the job.
 *
 * ### Creating a Pipeline Job
 * **Example:** Run a compiled spec
 * ```typescript
 * const job = yield* GCP.AIPlatform.PipelineJob("Train", {
 *   pipelineSpec: compiled,
 *   runtimeConfig: { gcsOutputDirectory: "gs://bucket/pipeline-out" },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const PipelineJob = Resource<PipelineJob>("GCP.AIPlatform.PipelineJob");

export class PipelineJobNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.PipelineJobNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, id: string) =>
  `${locationParent(project, location)}/${COLLECTION}/${id}`;

const toAttrs = (
  job: aiplatform.GoogleCloudAiplatformV1PipelineJob,
  project: string,
) => {
  const name = job.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    pipelineJobId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: job.displayName,
    labels: userLabels(job.labels),
    state: job.state,
    templateUri: job.templateUri,
    serviceAccount: job.serviceAccount,
    createTime: job.createTime,
    startTime: job.startTime,
    endTime: job.endTime,
    updateTime: job.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsPipelineJobs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const TERMINAL_STATES = new Set([
  "PIPELINE_STATE_SUCCEEDED",
  "PIPELINE_STATE_FAILED",
  "PIPELINE_STATE_CANCELLED",
]);

class PipelineJobNotTerminal extends Data.TaggedError(
  "GCP.AIPlatform.PipelineJobNotTerminal",
)<{ name: string; state: string | undefined }> {}

/**
 * A pending or running job cannot be deleted: cancel it and wait until it
 * settles (cancellation takes up to a few minutes).
 */
const cancelUntilTerminal = (name: string) =>
  Effect.gen(function* () {
    const job = yield* getByName(name);
    if (job === undefined || TERMINAL_STATES.has(job.state ?? "")) return;
    yield* aiplatform
      .cancelProjectsLocationsPipelineJobs({ name, body: {} })
      .pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        // The job can reach a terminal state between the read above and the
        // cancel ("… is in state JOB_STATE_FAILED and cannot be canceled");
        // the wait below re-reads the state and still fails if it is not
        // terminal.
        Effect.catchTag("BadRequest", () => Effect.void),
      );
    yield* getByName(name).pipe(
      Effect.flatMap((current) =>
        current === undefined || TERMINAL_STATES.has(current.state ?? "")
          ? Effect.void
          : Effect.fail(
              new PipelineJobNotTerminal({ name, state: current.state }),
            ),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.AIPlatform.PipelineJobNotTerminal",
        times: 36,
        schedule: Schedule.spaced("5 seconds"),
      }),
    );
  });

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (job) => job === undefined,
      () => new AiPlatformStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) => error._tag === "GCP.AIPlatform.StillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const PipelineJobProvider = () =>
  Provider.succeed(PipelineJob, {
    stables: ["name", "pipelineJobId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousId = olds?.pipelineJobId ?? output?.pipelineJobId;
      const nextId = news.pipelineJobId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const specChanged =
        olds !== undefined &&
        (!jsonEqual(news.pipelineSpec, olds.pipelineSpec) ||
          (news.templateUri ?? "") !== (olds.templateUri ?? ""));
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        specChanged;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toPhysicalId(
        id,
        olds?.pipelineJobId,
        output?.pipelineJobId,
        MAX_PIPELINE_JOB_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name = output?.name ?? resourceName(env.project, location, jobId);
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
        const pages = (yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            collectPages(
              aiplatform.listProjectsLocationsPipelineJobs.pages({
                parent: locationParent(env.project, location),
                pageSize: 100,
              }),
            ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        )).flat();
        return pages.flatMap((page) =>
          (page.pipelineJobs ?? [])
            .filter((job) =>
              Object.keys(job.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((job) => toAttrs(job, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const jobId = yield* toPhysicalId(
        id,
        news.pipelineJobId,
        output?.pipelineJobId,
        MAX_PIPELINE_JOB_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, jobId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsPipelineJobs({
            parent: locationParent(env.project, location),
            pipelineJobId: jobId,
            body: {
              displayName: news.displayName ?? jobId,
              labels: desiredLabels,
              pipelineSpec: news.pipelineSpec,
              templateUri: news.templateUri,
              runtimeConfig: news.runtimeConfig,
              serviceAccount: news.serviceAccount,
              network: news.network,
              reservedIpRanges: news.reservedIpRanges,
              encryptionSpec: news.encryptionSpec,
              preflightValidations: news.preflightValidations,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PipelineJobNotResolved({ name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cancelUntilTerminal(output.name);
      const operation = yield* aiplatform
        .deleteProjectsLocationsPipelineJobs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
