import * as logpush from "@distilled.cloud/cloudflare/logpush";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.Logpush.Job" as const;
type TypeId = typeof TypeId;

/**
 * Name of the dataset a Logpush job pushes. The available datasets depend
 * on the job's scope (account vs zone) and the account's plan — e.g.
 * `workers_trace_events` and `audit_logs` are account-scoped, while
 * `http_requests` and `firewall_events` are zone-scoped (Enterprise).
 */
export type Dataset = Exclude<
  NonNullable<logpush.CreateJobForAccountRequest["dataset"]>,
  null
>;

/**
 * Structured output configuration for a Logpush job — the replacement for
 * the deprecated `logpull_options` string.
 */
export interface OutputOptions {
  /**
   * String prepended to each batch (e.g. `[` to build a JSON array).
   */
  batchPrefix?: string;
  /**
   * String appended to each batch (e.g. `]`).
   */
  batchSuffix?: string;
  /**
   * Mitigation flag for CVE-2021-44228 — when `true`, verbatim
   * `${` sequences are replaced with `x{`.
   */
  "cve-2021-44228"?: boolean;
  /**
   * Delimiter between fields in `csv` output.
   */
  fieldDelimiter?: string;
  /**
   * Log fields to include in the output. Available fields per dataset are
   * listed on the Cloudflare developer docs.
   */
  fieldNames?: string[];
  /**
   * Whether to merge sub-request data into the parent request record
   * (only meaningful for some datasets).
   */
  mergeSubrequests?: boolean;
  /**
   * Output format.
   * @default "ndjson"
   */
  outputType?: "ndjson" | "csv";
  /**
   * Delimiter inserted between records.
   */
  recordDelimiter?: string;
  /**
   * String prepended to each record.
   */
  recordPrefix?: string;
  /**
   * String appended to each record.
   */
  recordSuffix?: string;
  /**
   * Go-template string used to render each record (mutually exclusive
   * with prefix/suffix/delimiter options).
   */
  recordTemplate?: string;
  /**
   * Floating point fraction (0.0–1.0) of records to include.
   * @default 1
   */
  sampleRate?: number;
  /**
   * Timestamp rendering format.
   * @default "unixnano"
   */
  timestampFormat?: "unixnano" | "unix" | "rfc3339" | "rfc3339ms" | "rfc3339ns";
}

export interface JobProps {
  /**
   * Zone the job is scoped to. When omitted, the job is account-scoped
   * (using the account from the active Cloudflare credentials).
   *
   * Stable — moving a job between scopes triggers a replacement.
   */
  zoneId?: string;
  /**
   * Name of the dataset to push (e.g. `workers_trace_events`,
   * `audit_logs`, `http_requests`).
   *
   * Stable — the dataset is fixed at creation, so changing it triggers
   * a replacement.
   */
  dataset: Dataset;
  /**
   * Destination URI, including any credentials the destination needs —
   * e.g. `r2://bucket/{DATE}?account-id=…&access-key-id=…&secret-access-key=…`
   * for R2, or an `s3://`, `gs://`, `https://` endpoint.
   *
   * Cloudflare validates the destination synchronously on create/update by
   * writing a test object, so the destination (e.g. the R2 bucket) must
   * already exist.
   *
   * Mutable — but Cloudflare may reject changing the destination
   * *provider/domain* of an existing job; in that case change a
   * replacement-triggering prop instead.
   */
  destinationConf: string;
  /**
   * Optional human readable job name (not unique). If omitted, a unique
   * name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Whether the job actively pushes logs.
   * @default false
   */
  enabled?: boolean;
  /**
   * Filter expression (JSON-encoded) selecting which events to push.
   * See https://developers.cloudflare.com/logs/reference/filters/.
   */
  filter?: string;
  /**
   * Differentiates Logpush (`""`) from Edge Log Delivery (`"edge"`) jobs.
   *
   * Stable — changing the kind triggers a replacement.
   * @default ""
   */
  kind?: "" | "edge";
  /**
   * Structured output configuration (fields, format, delimiters, sampling).
   */
  outputOptions?: OutputOptions;
  /**
   * Maximum uncompressed file size of a batch, in bytes. Between 5 MB and
   * 1 GB, or `0` to disable the limit.
   * @default 0
   */
  maxUploadBytes?: number;
  /**
   * Maximum interval in seconds between log batches. Between 30 and 300,
   * or `0` to disable the limit.
   * @default 30
   */
  maxUploadIntervalSeconds?: number;
  /**
   * Maximum number of log lines per batch. Between 1,000 and 1,000,000,
   * or `0` to disable the limit.
   * @default 100000
   */
  maxUploadRecords?: number;
  /**
   * Ownership challenge token proving destination ownership — required
   * for destinations like S3/GCS/Azure. R2 destinations authenticated via
   * credentials in `destinationConf` do not need it.
   *
   * Write-only: Cloudflare never echoes it back, so it does not
   * participate in drift detection.
   */
  ownershipChallenge?: string;
}

export interface JobAttributes {
  /** Cloudflare-assigned numeric job id. */
  jobId: number;
  /** Account that owns the job. */
  accountId: string;
  /** Zone the job is scoped to, or `undefined` for account-scoped jobs. */
  zoneId: string | undefined;
  /** Job name. */
  name: string;
  /** Dataset the job pushes. */
  dataset: Dataset;
  /**
   * Destination URI. Note Cloudflare redacts embedded secrets (e.g. the
   * R2 `secret-access-key`) when echoing this back.
   */
  destinationConf: string;
  /** Whether the job is enabled. */
  enabled: boolean;
  /** Job kind (`""` for Logpush, `"edge"` for Edge Log Delivery). */
  kind: string;
  /** Last failure message, if the job is currently failing. */
  errorMessage: string | undefined;
  /** End of the last successfully-pushed log range. */
  lastComplete: string | undefined;
  /** Time of the last push failure. */
  lastError: string | undefined;
}

export type Job = Resource<TypeId, JobProps, JobAttributes, never, Providers>;

/**
 * A Cloudflare Logpush job that pushes batches of logs (HTTP requests,
 * Workers trace events, audit logs, Zero Trust datasets, …) to a
 * destination such as R2, S3, GCS, or an HTTP endpoint.
 *
 * Jobs can be account-scoped (default) or zone-scoped (pass `zoneId`).
 * The dataset, kind, and scope are fixed at creation — changing any of
 * them triggers a replacement; everything else updates in place.
 * @resource
 * @product Logpush
 * @category Observability & Analytics
 * @section Pushing Workers trace events to R2
 * @example Account-scoped job writing to an R2 bucket
 * The R2 destination authenticates with S3-compatible credentials embedded
 * in the destination URI, so no ownership challenge is required.
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("logs", {});
 *
 * const job = yield* Cloudflare.Logpush.Job("worker-logs", {
 *   dataset: "workers_trace_events",
 *   destinationConf: Output.interpolate`r2://${bucket.bucketName}/{DATE}?account-id=${accountId}&access-key-id=${r2AccessKeyId}&secret-access-key=${r2SecretAccessKey}`,
 *   enabled: true,
 * });
 * ```
 *
 * @section Zone-scoped jobs
 * @example HTTP requests dataset on a zone (Enterprise)
 * ```typescript
 * const job = yield* Cloudflare.Logpush.Job("http-logs", {
 *   zoneId: zone.zoneId,
 *   dataset: "http_requests",
 *   destinationConf: "s3://my-bucket/logs?region=us-east-1",
 *   ownershipChallenge: "00000000000000000000",
 * });
 * ```
 *
 * @section Output configuration
 * @example Selecting fields and batching limits
 * ```typescript
 * const job = yield* Cloudflare.Logpush.Job("worker-logs", {
 *   dataset: "workers_trace_events",
 *   destinationConf,
 *   outputOptions: {
 *     fieldNames: ["EventTimestampMs", "Outcome", "ScriptName"],
 *     outputType: "ndjson",
 *     timestampFormat: "rfc3339",
 *   },
 *   maxUploadIntervalSeconds: 60,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/logs/logpush/
 */
export const Job = Resource<Job>(TypeId);

/**
 * Returns true if the given value is a Job resource.
 */
export const isJob = (value: unknown): value is Job =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const JobProvider = () =>
  Provider.succeed(Job, {
    stables: ["jobId", "accountId", "zoneId", "dataset", "kind"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const o = olds as JobProps;
      const n = news as JobProps;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      if (o.dataset !== undefined && o.dataset !== n.dataset) {
        return { action: "replace" } as const;
      }
      if (o.dataset !== undefined && (o.kind ?? "") !== (n.kind ?? "")) {
        return { action: "replace" } as const;
      }
      // zoneId is string; only comparable when both sides are
      // concrete strings (or one side is absent => scope change).
      const oZone = typeof o.zoneId === "string" ? o.zoneId : undefined;
      const nZone = typeof n.zoneId === "string" ? n.zoneId : undefined;
      if (
        o.dataset !== undefined &&
        (typeof o.zoneId === "string" || o.zoneId === undefined) &&
        (typeof n.zoneId === "string" || n.zoneId === undefined) &&
        oZone !== nZone
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const scope: Scope = {
        accountId: output?.accountId ?? accountId,
        zoneId: output?.zoneId ?? (olds?.zoneId as string | undefined),
      };
      // Owned path: refresh by the persisted job id.
      if (output?.jobId !== undefined) {
        const observed = yield* observeById(scope, output.jobId);
        const attrs = toAttributes(observed, scope);
        if (attrs) return attrs;
      }
      // Cold/adoption path: no persisted id — find the job by name. The
      // engine-generated physical name embeds the instance id, so a match
      // on a generated name is proof we created it. A match on a
      // user-provided name is not — report it `Unowned` so the engine
      // gates takeover behind the adopt policy.
      const name = yield* createJobName(id, olds?.name);
      const match = yield* findByName(scope, name, olds?.dataset);
      const attrs = toAttributes(match, scope);
      if (attrs) {
        return olds?.name !== undefined ? Unowned(attrs) : attrs;
      }
      return undefined;
    }),

    // Logpush jobs are hybrid-scoped: account-scoped jobs live under the
    // account, zone-scoped jobs under each zone. Enumerate both — the account
    // collection plus a fan-out over every zone — and hydrate each into the
    // same Attributes shape `read` returns.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const accountRows = yield* logpush.listJobsForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? [])
                .filter((job): job is NonNullable<typeof job> => job != null)
                .map((job) =>
                  toAttributes(job, { accountId, zoneId: undefined }),
                )
                .filter((attrs): attrs is JobAttributes => attrs !== undefined),
            ),
          ),
        );

      const zones = yield* listAllZones(accountId);
      const zoneRows = yield* Effect.forEach(
        zones,
        (zone) =>
          logpush.listJobsForZone.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? [])
                  .filter((job): job is NonNullable<typeof job> => job != null)
                  .map((job) =>
                    toAttributes(job, { accountId, zoneId: zone.id }),
                  )
                  .filter(
                    (attrs): attrs is JobAttributes => attrs !== undefined,
                  ),
              ),
            ),
            // Best-effort account-wide fan-out: a zone the token can't read
            // for Logpush (plan-gated route, missing permission, or a code-
            // 10000 auth blip) must be skipped, not fail the whole
            // enumeration. Drop only that zone and keep the rest.
            Effect.catchTag(
              ["InvalidRoute", "Unauthorized", "Forbidden", "NotFound"],
              () => Effect.succeed([]),
            ),
          ),
        { concurrency: 10 },
      );

      return [...accountRows, ...zoneRows.flat()];
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const scope: Scope = {
        accountId: output?.accountId ?? accountId,
        zoneId: (news.zoneId as string | undefined) ?? undefined,
      };
      const name = yield* createJobName(id, news.name);
      const destinationConf = news.destinationConf as string;
      const body = buildMutableBody(news, name, destinationConf);

      // 1. Observe — by cached id first, falling back to a list scan by
      //    name so we recover from lost state or out-of-band deletes.
      let observed: logpush.GetJobResponse | undefined;
      if (output?.jobId !== undefined) {
        observed = yield* observeById(scope, output.jobId);
      }
      let justCreated = false;
      if (!observed) {
        observed = yield* findByName(scope, name, news.dataset);
      }

      // 2. Ensure — create when missing. Logpush job names are not
      //    unique, so there is no AlreadyExists race to tolerate; create
      //    failures are real (e.g. invalid destination).
      if (!observed) {
        observed = yield* createJob(scope, news.dataset, body);
        justCreated = true;
      }

      const jobId = observed.id;
      if (jobId === undefined || jobId === null) {
        return yield* Effect.fail(
          new Error("Cloudflare did not return an id for the Logpush job"),
        );
      }

      // 3. Sync — Cloudflare's update endpoint is PUT-style; resend the
      //    full desired body when anything differs. `destination_conf`
      //    and `filter` are compared against `olds` because Cloudflare
      //    redacts embedded secrets (destination) or omits the field
      //    entirely (filter) in get/list responses.
      if (!justCreated && needsUpdate(body, news, olds, observed)) {
        observed = yield* updateJob(scope, jobId, body);
      }

      const attrs = toAttributes({ ...observed, id: jobId }, scope);
      if (!attrs) {
        return yield* Effect.fail(
          new Error(
            "Cloudflare returned a Logpush job without id/dataset/destination",
          ),
        );
      }
      // Prefer the desired destination — the observed echo redacts secrets.
      return { ...attrs, destinationConf, name: attrs.name || name };
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope: Scope = {
        accountId: output.accountId,
        zoneId: output.zoneId,
      };
      yield* (
        scope.zoneId !== undefined
          ? logpush.deleteJobForZone({
              zoneId: scope.zoneId,
              jobId: output.jobId,
            })
          : logpush.deleteJobForAccount({
              accountId: scope.accountId,
              jobId: output.jobId,
            })
      ).pipe(Effect.catchTag("JobNotFound", () => Effect.void));
    }),
  });

interface Scope {
  accountId: string;
  zoneId: string | undefined;
}

const createJobName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const observeById = (scope: Scope, jobId: number) =>
  (scope.zoneId !== undefined
    ? logpush.getJobForZone({ zoneId: scope.zoneId, jobId })
    : logpush.getJobForAccount({ accountId: scope.accountId, jobId })
  ).pipe(
    Effect.map((job): logpush.GetJobResponse | undefined => job),
    Effect.catchTag("JobNotFound", () => Effect.succeed(undefined)),
  );

const findByName = (scope: Scope, name: string, dataset: Dataset | undefined) =>
  (scope.zoneId !== undefined
    ? logpush.listJobsForZone.items({ zoneId: scope.zoneId })
    : logpush.listJobsForAccount.items({ accountId: scope.accountId })
  ).pipe(
    Stream.runCollect,
    Effect.map((chunk): logpush.GetJobResponse | undefined => {
      const match = Array.from(chunk)
        .filter((job): job is NonNullable<typeof job> => job != null)
        .find(
          (job) =>
            job.name === name &&
            (dataset === undefined || job.dataset === dataset),
        );
      return match ?? undefined;
    }),
  );

/**
 * The mutable body shared by create and update (PUT) requests.
 */
interface JobMutableBody {
  destinationConf: string;
  enabled: boolean;
  filter: string | undefined;
  kind: "" | "edge" | undefined;
  maxUploadBytes: number | undefined;
  maxUploadIntervalSeconds: number | undefined;
  maxUploadRecords: number | undefined;
  name: string;
  outputOptions: OutputOptions | undefined;
  ownershipChallenge: string | undefined;
}

const buildMutableBody = (
  news: JobProps,
  name: string,
  destinationConf: string,
): JobMutableBody => ({
  destinationConf,
  enabled: news.enabled ?? false,
  filter: news.filter,
  kind: news.kind,
  maxUploadBytes: news.maxUploadBytes,
  maxUploadIntervalSeconds: news.maxUploadIntervalSeconds,
  maxUploadRecords: news.maxUploadRecords,
  name,
  outputOptions: news.outputOptions,
  ownershipChallenge: news.ownershipChallenge,
});

const createJob = (scope: Scope, dataset: Dataset, body: JobMutableBody) =>
  (scope.zoneId !== undefined
    ? logpush.createJobForZone({ zoneId: scope.zoneId, dataset, ...body })
    : logpush.createJobForAccount({
        accountId: scope.accountId,
        dataset,
        ...body,
      })
  ).pipe(Effect.map((job): logpush.GetJobResponse => job));

const updateJob = (scope: Scope, jobId: number, body: JobMutableBody) =>
  (scope.zoneId !== undefined
    ? logpush.updateJobForZone({ zoneId: scope.zoneId, jobId, ...body })
    : logpush.updateJobForAccount({
        accountId: scope.accountId,
        jobId,
        ...body,
      })
  ).pipe(Effect.map((job): logpush.GetJobResponse => job));

const asNumber = (v: "0" | number | null | undefined): number | undefined =>
  v == null ? undefined : typeof v === "string" ? Number(v) : v;

/**
 * Decide whether a PUT is needed. Observable fields are diffed against the
 * live job; write-only/redacted fields (`destination_conf`, `filter`,
 * `ownership_challenge`) fall back to a `news` vs `olds` comparison —
 * `olds === undefined` (adoption) forces a PUT so the job converges to the
 * declared destination/filter.
 */
const needsUpdate = (
  desired: JobMutableBody,
  news: JobProps,
  olds: JobProps | undefined,
  observed: logpush.GetJobResponse,
): boolean => {
  if (olds === undefined) return true;
  if ((news.destinationConf as string) !== (olds.destinationConf as string)) {
    return true;
  }
  if (news.filter !== olds.filter) return true;
  if (desired.enabled !== (observed.enabled ?? false)) return true;
  if (desired.name !== (observed.name ?? undefined)) return true;
  if (
    desired.maxUploadBytes !== undefined &&
    desired.maxUploadBytes !== asNumber(observed.maxUploadBytes)
  ) {
    return true;
  }
  if (
    desired.maxUploadIntervalSeconds !== undefined &&
    desired.maxUploadIntervalSeconds !==
      asNumber(observed.maxUploadIntervalSeconds)
  ) {
    return true;
  }
  if (
    desired.maxUploadRecords !== undefined &&
    desired.maxUploadRecords !== asNumber(observed.maxUploadRecords)
  ) {
    return true;
  }
  if (
    desired.outputOptions !== undefined &&
    !outputOptionsEqual(desired.outputOptions, observed.outputOptions)
  ) {
    return true;
  }
  return false;
};

/**
 * Compare only the keys the user declared — Cloudflare fills the rest with
 * defaults we must not fight.
 */
const outputOptionsEqual = (
  desired: OutputOptions,
  observed: logpush.GetJobResponse["outputOptions"],
): boolean => {
  const o = observed ?? {};
  for (const key of Object.keys(desired) as (keyof OutputOptions)[]) {
    const want = desired[key];
    if (want === undefined) continue;
    const have = o[key] ?? undefined;
    if (Array.isArray(want)) {
      if (
        !Array.isArray(have) ||
        want.length !== have.length ||
        want.some((v, i) => v !== have[i])
      ) {
        return false;
      }
    } else if (want !== have) {
      return false;
    }
  }
  return true;
};

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const toAttributes = (
  observed: logpush.GetJobResponse | undefined,
  scope: Scope,
): JobAttributes | undefined => {
  if (
    observed?.id == null ||
    observed.dataset == null ||
    observed.destinationConf == null
  ) {
    return undefined;
  }
  return {
    jobId: observed.id,
    accountId: scope.accountId,
    zoneId: scope.zoneId,
    name: observed.name ?? "",
    dataset: observed.dataset,
    destinationConf: observed.destinationConf,
    enabled: observed.enabled ?? false,
    kind: observed.kind ?? "",
    errorMessage: undef(observed.errorMessage),
    lastComplete: undef(observed.lastComplete),
    lastError: undef(observed.lastError),
  };
};
