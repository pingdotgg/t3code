import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as logpush from "@distilled.cloud/cloudflare/logpush";
import * as user from "@distilled.cloud/cloudflare/user";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import crypto from "node:crypto";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloudflare's edge intermittently 403s ("Unable to authenticate request")
// even for established tokens. The blip can hit engine-side calls mid-deploy
// as well as the test's own out-of-band calls. Reconcile is idempotent
// (observe→ensure→sync), so retrying the whole deploy is safe. The message
// match (rather than a typed tag) is deliberate: this wraps whole deploys
// whose error channel is the engine's aggregate, not a single distilled op.
const retryAuthBlip = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e) => String(e).includes("Unable to authenticate request"),
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );

const r2Credentials = Effect.gen(function* () {
  const creds = yield* yield* CloudflareEnvironment;
  if (creds.type !== "apiToken") {
    return yield* Effect.die(
      new Error(
        "Logpush R2 test requires an apiToken profile (R2 S3 credentials are derived from the token)",
      ),
    );
  }
  const token = Redacted.value(creds.apiToken);
  const verified = yield* user.verifyToken({}).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );
  const secretAccessKey = yield* Effect.sync(() =>
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    accountId: creds.accountId,
    accessKeyId: verified.id,
    secretAccessKey,
  };
});

interface R2Creds {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface JobOpts {
  dataset: Cloudflare.Logpush.Dataset;
  enabled?: boolean;
  maxUploadIntervalSeconds?: number;
  outputOptions?: Cloudflare.Logpush.OutputOptions;
}

// One program deploying both the R2 destination bucket and the Logpush job
// pushing into it. The job's destinationConf interpolates the bucket name so
// the engine orders job-after-bucket on deploy (and the reverse on destroy).
const program = (creds: R2Creds, opts: JobOpts) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("LogpushBucket", {});
    const job = yield* Cloudflare.Logpush.Job("Job", {
      dataset: opts.dataset,
      destinationConf: Output.interpolate`r2://${bucket.bucketName}/alchemy/{DATE}?account-id=${creds.accountId}&access-key-id=${creds.accessKeyId}&secret-access-key=${creds.secretAccessKey}`,
      enabled: opts.enabled,
      maxUploadIntervalSeconds: opts.maxUploadIntervalSeconds,
      outputOptions: opts.outputOptions,
    });
    return { bucket, job };
  });

// `Forbidden` is in `getJobForAccount`'s typed error union (the same edge
// 403 blip described above), so the retry predicate is fully inferred.
const getJob = (accountId: string, jobId: number) =>
  logpush.getJobForAccount({ accountId, jobId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const waitForDelete = (accountId: string, jobId: number) =>
  getJob(accountId, jobId).pipe(
    Effect.flatMap((job) =>
      job.id === jobId
        ? Effect.fail({ _tag: "JobNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.catchTag("JobNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "JobNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update, and delete an account-scoped job pushing to R2",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const creds = yield* r2Credentials;

      yield* stack.destroy();

      // Create — engine-generated name, disabled to avoid pushing noise.
      const initial = yield* retryAuthBlip(
        stack.deploy(
          program(creds, {
            dataset: "workers_trace_events",
            enabled: false,
          }),
        ),
      );

      expect(initial.job.jobId).toBeTypeOf("number");
      expect(initial.job.accountId).toEqual(accountId);
      expect(initial.job.zoneId).toBeUndefined();
      expect(initial.job.dataset).toEqual("workers_trace_events");
      expect(initial.job.enabled).toEqual(false);
      expect(initial.job.destinationConf).toContain(
        `r2://${initial.bucket.bucketName}/alchemy/{DATE}`,
      );

      const live = yield* getJob(accountId, initial.job.jobId);
      expect(live.id).toEqual(initial.job.jobId);
      expect(live.dataset).toEqual("workers_trace_events");
      expect(live.enabled).toEqual(false);
      expect(live.name).toEqual(initial.job.name);

      // Update mutable props in place — same job id.
      const updated = yield* retryAuthBlip(
        stack.deploy(
          program(creds, {
            dataset: "workers_trace_events",
            enabled: true,
            maxUploadIntervalSeconds: 60,
            outputOptions: {
              fieldNames: ["EventTimestampMs", "Outcome", "ScriptName"],
              timestampFormat: "rfc3339",
            },
          }),
        ),
      );

      expect(updated.job.jobId).toEqual(initial.job.jobId);
      expect(updated.job.enabled).toEqual(true);

      const liveUpdated = yield* getJob(accountId, updated.job.jobId);
      expect(liveUpdated.enabled).toEqual(true);
      expect(liveUpdated.maxUploadIntervalSeconds).toEqual(60);
      expect(liveUpdated.outputOptions?.fieldNames).toEqual([
        "EventTimestampMs",
        "Outcome",
        "ScriptName",
      ]);

      yield* stack.destroy();

      yield* waitForDelete(accountId, initial.job.jobId);

      // Destroy again — delete must be idempotent (the job is already gone).
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "list enumerates the deployed Logpush job",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const creds = yield* r2Credentials;

      yield* stack.destroy();

      const deployed = yield* retryAuthBlip(
        stack.deploy(
          program(creds, {
            dataset: "workers_trace_events",
            enabled: false,
          }),
        ),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Logpush.Job);
      const all = yield* provider.list();

      // The account-scoped job we just deployed is present in the
      // exhaustively-paginated (account + per-zone fan-out) result.
      const found = all.find((job) => job.jobId === deployed.job.jobId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.zoneId).toBeUndefined();
      expect(found?.dataset).toEqual("workers_trace_events");

      yield* stack.destroy();

      yield* waitForDelete(accountId, deployed.job.jobId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// Requires entitlement for a second account-scoped dataset. On the testing
// account (Workers Paid) every dataset except `workers_trace_events` is
// rejected with:
//   Forbidden: creating a new job (for <dataset> dataset) is not allowed:
//   exceeded max jobs allowed
// (verified for audit_logs, audit_logs_v2, access_requests, gateway_dns,
// casb_findings, dns_firewall_logs), so a dataset-change replacement cannot
// be exercised here. Enable on an account with a second Logpush-entitled
// dataset.
test.provider.skip(
  "changing the dataset triggers a replacement",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const creds = yield* r2Credentials;

      yield* stack.destroy();

      const initial = yield* retryAuthBlip(
        stack.deploy(program(creds, { dataset: "workers_trace_events" })),
      );
      expect(initial.job.dataset).toEqual("workers_trace_events");

      const replaced = yield* retryAuthBlip(
        stack.deploy(program(creds, { dataset: "audit_logs_v2" })),
      );

      // The dataset is fixed at creation — a new physical job exists.
      expect(replaced.job.jobId).not.toEqual(initial.job.jobId);
      expect(replaced.job.dataset).toEqual("audit_logs_v2");

      const liveReplaced = yield* getJob(accountId, replaced.job.jobId);
      expect(liveReplaced.dataset).toEqual("audit_logs_v2");

      // The old job was deleted as part of the replacement.
      yield* waitForDelete(accountId, initial.job.jobId);

      yield* stack.destroy();

      yield* waitForDelete(accountId, replaced.job.jobId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
