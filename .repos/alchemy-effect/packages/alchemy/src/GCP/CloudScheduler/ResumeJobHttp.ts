import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { ResumeJob } from "./ResumeJob.ts";

/**
 * HTTP implementation of {@link ResumeJob}.
 *
 * Grants `roles/cloudscheduler.admin` on the project because it is the
 * only predefined role with `cloudscheduler.jobs.enable`, and Cloud Scheduler
 * supports neither per-job IAM policies nor IAM Conditions on
 * `resource.name`.
 *
 * @layer
 * @provides GCP.CloudScheduler.ResumeJob
 */
export const ResumeJobHttp: Layer.Layer<
  ResumeJob,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  ResumeJob,
  makeJobHttpBinding<
    scheduler.ResumeProjectsLocationsJobsRequest,
    scheduler.Job,
    scheduler.ResumeProjectsLocationsJobsError
  >({
    tag: "GCP.CloudScheduler.ResumeJob",
    iam: { role: "roles/cloudscheduler.admin" },
    operation: scheduler.resumeProjectsLocationsJobs,
  }),
);
