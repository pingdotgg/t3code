import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import SchedulerBindingsHost, {
  PausedJob,
  ResumedJob,
  RunJobTarget,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudSchedulerBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let jobs: { paused: string; resumed: string; run: string };

/**
 * The host's project-level roles. Cloud Scheduler has no per-job IAM
 * policy: Pause/Resume grant `roles/cloudscheduler.admin` (the only
 * predefined role with `jobs.pause`/`jobs.enable`) and Run grants
 * `roles/cloudscheduler.jobRunner`, all on the project.
 */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({ role: binding.role, condition: binding.condition }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(roles).toEqual([
    { role: "roles/cloudscheduler.admin", condition: undefined },
    { role: "roles/cloudscheduler.jobRunner", condition: undefined },
  ]);
});

const getJob = (name: string) => scheduler.getProjectsLocationsJobs({ name });

describe.skipIf(!dockerAvailable)(
  "CloudScheduler Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:cloudscheduler",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* SchedulerBindingsHost;
            const paused = yield* PausedJob;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: paused.project,
              paused: paused.name,
              resumed: (yield* ResumedJob).name,
              run: (yield* RunJobTarget).name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        jobs = { paused: out.paused, resumed: out.resumed, run: out.run };
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("PauseJob", () => {
      test.provider(
        "pauses the job as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "pause");
            expect(job.name).toEqual(jobs.paused);
            expect(job.state).toEqual("PAUSED");
            expect((yield* getJob(jobs.paused)).state).toEqual("PAUSED");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("ResumeJob", () => {
      test.provider(
        "resumes a paused job as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            yield* scheduler.pauseProjectsLocationsJobs({
              name: jobs.resumed,
            });
            expect((yield* getJob(jobs.resumed)).state).toEqual("PAUSED");
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "resume");
            expect(job.name).toEqual(jobs.resumed);
            expect(job.state).toEqual("ENABLED");
            expect((yield* getJob(jobs.resumed)).state).toEqual("ENABLED");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RunJob", () => {
      test.provider(
        "forces a run as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const job = yield* expectProbe<scheduler.Job>(baseUrl, "run");
            expect(job.name).toEqual(jobs.run);
            // The forced attempt is recorded on the job asynchronously.
            const after = yield* getJob(jobs.run).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (current) => current.lastAttemptTime !== undefined,
                times: 18,
              }),
            );
            expect(after.lastAttemptTime).toBeDefined();
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:cloudscheduler", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
