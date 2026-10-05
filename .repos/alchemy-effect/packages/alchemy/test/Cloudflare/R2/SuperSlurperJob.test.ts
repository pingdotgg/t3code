import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";

const { test } = Test.make({ providers: Cloudflare.providers() });
const missingJobId =
  "0000000000000000000000000000000000000000000000000000000000000000";

const program = (options: {
  job: boolean;
  paused?: boolean;
  overwrite?: boolean;
  reference?: boolean;
  sourcePrefix?: string;
  targetName?: string;
  otherJob?: boolean;
  subscription?: "direct" | "ref";
}) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const source = yield* Cloudflare.R2.Bucket("Source", {
      forceDestroy: true,
    });
    const target = yield* Cloudflare.R2.Bucket("Target", {
      name: options.targetName,
      forceDestroy: true,
    });
    const token = yield* Cloudflare.ApiToken.AccountApiToken("Credentials", {
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers R2 Storage Read",
            "Workers R2 Storage Write",
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });
    const secret = {
      accessKeyId: token.tokenId.pipe(Output.map(Redacted.make)),
      secretAccessKey: token.value.pipe(
        Output.mapEffect((value) =>
          Effect.sync(() =>
            Redacted.make(
              createHash("sha256").update(Redacted.value(value)).digest("hex"),
            ),
          ),
        ),
      ),
    };
    const job = options.job
      ? yield* Cloudflare.R2.SuperSlurperJob("Migration", {
          source: {
            vendor: "r2",
            bucket: source.bucketName,
            secret,
            pathPrefix: options.sourcePrefix,
          },
          target: { vendor: "r2", bucket: target.bucketName, secret },
          paused: options.paused,
          overwrite: options.overwrite,
        })
      : undefined;
    const otherJob = options.otherJob
      ? yield* Cloudflare.R2.SuperSlurperJob("OtherMigration", {
          source: { vendor: "r2", bucket: source.bucketName, secret },
          target: { vendor: "r2", bucket: target.bucketName, secret },
          paused: true,
        })
      : undefined;
    const reference = options.reference
      ? yield* Cloudflare.R2.SuperSlurperJob.ref("Migration")
      : undefined;
    const queue = options.subscription
      ? yield* Cloudflare.Queues.Queue("JobEventsQueue")
      : undefined;
    const subscription =
      options.subscription && job && queue
        ? yield* Cloudflare.Queues.Subscription("JobEvents", {
            source:
              options.subscription === "ref"
                ? yield* Cloudflare.R2.SuperSlurperJob.ref("Migration")
                : job,
            events: ["job.resumed", "job.completed", "job.aborted"],
            queueId: queue.queueId,
          })
        : undefined;
    return {
      source,
      target,
      token,
      job,
      otherJob,
      reference,
      queue,
      subscription,
    };
  });

const getJob = (identity: { accountId: string; jobId: string }) =>
  r2
    .getSuperSlurperJob({
      accountId: identity.accountId,
      jobId: identity.jobId,
    })
    .pipe(Retry.none);

const terminal = (status: r2.GetSuperSlurperJobResponse["status"]) =>
  status === "aborted" || status === "completed";

test.provider(
  "observes absence and types the API's absent-job mutation failures",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const identity = { accountId, jobId: missingJobId };
      const missing = yield* getJob(identity).pipe(Effect.flip);
      expect(missing._tag).toBe("SuperSlurperJobOperationFailed");
      expect(missing.message).toBe("Internal Server Error");
      const invalidSecret = {
        accessKeyId: "00000000000000000000000000000000",
        secretAccessKey:
          "0000000000000000000000000000000000000000000000000000000000000000",
      };
      const rejected = yield* r2
        .createSuperSlurperJob({
          accountId,
          source: {
            vendor: "r2",
            bucket: "alchemy-slurper-missing-source",
            secret: invalidSecret,
          },
          target: {
            vendor: "r2",
            bucket: "alchemy-slurper-missing-target",
            secret: invalidSecret,
          },
        })
        .pipe(Retry.none, Effect.flip);
      expect(rejected._tag).toBe("SuperSlurperPreconnectivityFailed");
      expect(rejected.message).toBe(
        "Preconnectivity failed, please verify tokens and try again",
      );
      for (const operation of [
        r2.abortSuperSlurperJob,
        r2.pauseSuperSlurperJob,
        r2.resumeSuperSlurperJob,
      ]) {
        const error = yield* operation(identity).pipe(Retry.none, Effect.flip);
        expect(error._tag).toBe("SuperSlurperJobOperationFailed");
        expect(error.message).toBe("Internal Server Error");
      }
      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:r2", "live"],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider(
  "creates, pauses, resumes, preserves terminal identity, replaces and cancels without deleting objects",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const buckets = yield* stack.deploy(program({ job: false }));
      yield* r2.uploadBucketObject({
        accountId,
        bucketName: buckets.source.bucketName,
        objectName: "migration.txt",
        body: "super-slurper-source",
      });
      yield* r2.uploadBucketObject({
        accountId,
        bucketName: buckets.target.bucketName,
        objectName: "sentinel.txt",
        body: "keep-existing-target-data",
      });
      const created = yield* stack.deploy(program({ job: true, paused: true }));
      const job = created.job!;
      expect(job.accountId).toBe(accountId);
      expect(job.jobId).toBeTruthy();
      const paused = yield* getJob(job);
      expect(paused.id).toBe(job.jobId);
      expect(paused.source?.bucket).toBe(buckets.source.bucketName);
      expect(paused.target?.bucket).toBe(buckets.target.bucketName);
      expect(paused.status === "paused" || terminal(paused.status)).toBe(true);

      const noop = yield* stack.deploy(
        program({ job: true, paused: true, reference: true }),
      );
      expect(noop.job!.jobId).toBe(job.jobId);
      expect(noop.reference!.jobId).toBe(job.jobId);
      expect(noop.reference!.accountId).toBe(accountId);

      const resumed = yield* stack.deploy(program({ job: true }));
      expect(resumed.job!.jobId).toBe(job.jobId);
      const running = yield* getJob(job);
      expect(running.status === "running" || terminal(running.status)).toBe(
        true,
      );
      if (!terminal(running.status)) {
        yield* r2
          .abortSuperSlurperJob({ accountId, jobId: job.jobId })
          .pipe(Retry.none);
      }
      const finished = yield* getJob(job).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (value) => terminal(value.status),
          times: 8,
        }),
      );
      expect(terminal(finished.status)).toBe(true);

      const terminalRedeploy = yield* stack.deploy(
        program({ job: true, paused: true }),
      );
      expect(terminalRedeploy.job!.jobId).toBe(job.jobId);
      expect((yield* getJob(job)).status).toBe(finished.status);

      const replaced = yield* stack.deploy(
        program({ job: true, paused: true, overwrite: true }),
      );
      const replacement = replaced.job!;
      expect(replacement.jobId).not.toBe(job.jobId);
      expect((yield* getJob(job)).status).toBe(finished.status);
      const changedSource = yield* stack.deploy(
        program({
          job: true,
          paused: true,
          overwrite: true,
          sourcePrefix: "migration",
          otherJob: true,
        }),
      );
      const filtered = changedSource.job!;
      const otherJob = changedSource.otherJob!;
      expect(filtered.jobId).not.toBe(replacement.jobId);
      expect(otherJob.jobId).not.toBe(job.jobId);
      expect(otherJob.jobId).not.toBe(filtered.jobId);
      const firstPage = yield* r2.listSuperSlurperJobs({
        accountId,
        limit: 1,
        offset: 0,
      });
      const secondPage = yield* r2.listSuperSlurperJobs({
        accountId,
        limit: 1,
        offset: 1,
      });
      expect(firstPage.result).toHaveLength(1);
      expect(secondPage.result).toHaveLength(1);
      expect(firstPage.result[0]!.id).not.toBe(secondPage.result[0]!.id);
      expect((yield* getJob(filtered)).source?.pathPrefix).toBe("migration");
      const otherBeforeRemoval = yield* getJob(otherJob);
      const removed = yield* stack.deploy(
        program({ job: false, otherJob: true }),
      );
      expect(removed.otherJob!.jobId).toBe(otherJob.jobId);
      expect((yield* getJob(otherJob)).status).toBe(otherBeforeRemoval.status);
      expect(terminal((yield* getJob(filtered)).status)).toBe(true);
      expect(removed.source.bucketName).toBe(buckets.source.bucketName);
      expect(removed.target.bucketName).toBe(buckets.target.bucketName);
      const cancelled = yield* getJob(replacement).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (value) => terminal(value.status),
          times: 8,
        }),
      );
      expect(terminal(cancelled.status)).toBe(true);
      const objects = yield* r2.listBucketObjects({
        accountId,
        bucketName: buckets.target.bucketName,
      });
      expect(
        objects.result.some((object) => object.key === "sentinel.txt"),
      ).toBe(true);
      const sourceObjects = yield* r2.listBucketObjects({
        accountId,
        bucketName: buckets.source.bucketName,
      });
      expect(
        sourceObjects.result.some((object) => object.key === "migration.txt"),
      ).toBe(true);

      yield* stack.destroy();
      for (const bucketName of [
        buckets.source.bucketName,
        buckets.target.bucketName,
      ]) {
        const error = yield* r2
          .getBucket({ accountId, bucketName })
          .pipe(Effect.flip);
        expect(error._tag).toBe("NoSuchBucket");
      }
      expect((yield* getJob(job)).status).toBe(finished.status);
      expect(terminal((yield* getJob(replacement)).status)).toBe(true);
      expect(terminal((yield* getJob(otherJob)).status)).toBe(true);
      const tokenGone = yield* accounts
        .getToken({
          accountId,
          tokenId: buckets.token.tokenId,
        })
        .pipe(Effect.flip);
      expect(["TokenNotFound", "InvalidRoute"]).toContain(tokenGone._tag);
      yield* Effect.log({
        jobs: [job.jobId, replacement.jobId, filtered.jobId, otherJob.jobId],
        status: "all terminal; buckets and token destroyed",
      });
      yield* stack.destroy();
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:account",
      "provider:cloudflare:apitoken",
      "provider:cloudflare:queue",
      "provider:cloudflare:r2",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider(
  "an unresolved target bucket identity replaces the migration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* stack.deploy(
        program({
          job: true,
          paused: true,
          targetName: "alchemy-slurper-target-replacement-a",
        }),
      );
      const replaced = yield* stack.deploy(
        program({
          job: true,
          paused: true,
          targetName: "alchemy-slurper-target-replacement-b",
        }),
      );
      expect(replaced.job!.jobId).not.toBe(initial.job!.jobId);
      expect((yield* getJob(replaced.job!)).target?.bucket).toBe(
        replaced.target.bucketName,
      );
      expect(terminal((yield* getJob(initial.job!)).status)).toBe(true);
      yield* stack.destroy();
      expect(terminal((yield* getJob(replaced.job!)).status)).toBe(true);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:apitoken",
      "provider:cloudflare:queue",
      "provider:cloudflare:r2",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider(
  "job resources and refs deliver account-wide subscription events without taking ownership",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const buckets = yield* stack.deploy(program({ job: false }));
      yield* r2.uploadBucketObject({
        accountId,
        bucketName: buckets.source.bucketName,
        objectName: "event.txt",
        body: "migration event",
      });
      const created = yield* stack.deploy(
        program({ job: true, paused: true, subscription: "direct" }),
      );
      const job = created.job!;
      const subscription = created.subscription!;
      expect(subscription.source).toEqual({ type: "superSlurper" });
      const live = yield* queues.getSubscription({
        accountId,
        subscriptionId: subscription.subscriptionId,
      });
      expect(live.source).toEqual(
        expect.objectContaining({ type: "superSlurper" }),
      );
      yield* queues.createConsumer({
        accountId,
        queueId: created.queue!.queueId,
        type: "http_pull",
      });
      const referenced = yield* stack.deploy(
        program({ job: true, paused: true, subscription: "ref" }),
      );
      expect(referenced.subscription!.subscriptionId).toBe(
        subscription.subscriptionId,
      );
      const resumed = yield* stack.deploy(
        program({ job: true, subscription: "ref" }),
      );
      expect(resumed.job!.jobId).toBe(job.jobId);
      const bodies: string[] = [];
      const delivered = () =>
        bodies.some(
          (body) =>
            body.includes("cf.superSlurper.job.") &&
            body.includes(job.jobId) &&
            body.includes(subscription.subscriptionId),
        );
      yield* Effect.gen(function* () {
        const batch = yield* queues
          .pullMessage({
            accountId,
            queueId: created.queue!.queueId,
            batchSize: 100,
            visibilityTimeoutMs: 1000,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "QueueHttpPullNotEnabled",
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
          );
        for (const message of batch.messages ?? [])
          if (message.body) bodies.push(message.body);
        const acks = (batch.messages ?? []).flatMap((message) =>
          message.leaseId ? [{ leaseId: message.leaseId }] : [],
        );
        if (acks.length)
          yield* queues.ackMessage({
            accountId,
            queueId: created.queue!.queueId,
            acks,
          });
        // A `job.resumed` emitted before the new subscription propagates is
        // lost, so emit a fresh one until an event is delivered.
        if (!delivered() && (yield* getJob(job)).status === "running") {
          yield* r2.pauseSuperSlurperJob(job).pipe(Retry.none, Effect.ignore);
          yield* r2.resumeSuperSlurperJob(job).pipe(Retry.none, Effect.ignore);
        }
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          times: 10,
          until: delivered,
        }),
        Effect.timeout("60 seconds"),
      );
      expect(delivered()).toBe(true);
      yield* stack.deploy(program({ job: true, paused: true }));
      expect((yield* getJob(job)).id).toBe(job.jobId);
      const gone = yield* queues
        .getSubscription({
          accountId,
          subscriptionId: subscription.subscriptionId,
        })
        .pipe(Effect.flip);
      expect(gone._tag).toBe("SubscriptionNotFound");
      yield* stack.destroy();
      expect(terminal((yield* getJob(job)).status)).toBe(true);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie))),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:apitoken",
      "provider:cloudflare:queue",
      "provider:cloudflare:r2",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);

// A one-object migration remained running after the bounded 24-second probe.
test.provider.skipIf(
  process.env.CLOUDFLARE_TEST_SUPER_SLURPER_COMPLETION !== "1",
)(
  "completes a real object transfer and never restarts the completed job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const buckets = yield* stack.deploy(program({ job: false }));
      yield* r2.uploadBucketObject({
        accountId,
        bucketName: buckets.source.bucketName,
        objectName: "migration.txt",
        body: "super-slurper-source",
      });
      const created = yield* stack.deploy(program({ job: true }));
      const job = created.job!;
      const completed = yield* getJob(job).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (value) => terminal(value.status),
          times: 8,
        }),
      );
      expect(completed.status).toBe("completed");
      const migrated = yield* r2.listBucketObjects({
        accountId,
        bucketName: buckets.target.bucketName,
      });
      expect(
        migrated.result.some((object) => object.key === "migration.txt"),
      ).toBe(true);
      const redeployed = yield* stack.deploy(
        program({ job: true, paused: true }),
      );
      expect(redeployed.job!.jobId).toBe(job.jobId);
      expect((yield* getJob(job)).status).toBe("completed");
      yield* stack.destroy();
      expect((yield* getJob(job)).status).toBe("completed");
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:apitoken",
      "provider:cloudflare:queue",
      "provider:cloudflare:r2",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);
