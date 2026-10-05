import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { PauseJob } from "./PauseJob.ts";

/**
 * HTTP implementation of {@link PauseJob}.
 *
 * Grants `roles/cloudscheduler.admin` on the project because it is the
 * only predefined role with `cloudscheduler.jobs.pause`, and Cloud Scheduler
 * supports neither per-job IAM policies nor IAM Conditions on
 * `resource.name`.
 *
 * @layer
 * @provides GCP.CloudScheduler.PauseJob
 */
export const PauseJobHttp: Layer.Layer<
  PauseJob,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  PauseJob,
  makeJobHttpBinding<
    scheduler.PauseProjectsLocationsJobsRequest,
    scheduler.Job,
    scheduler.PauseProjectsLocationsJobsError
  >({
    tag: "GCP.CloudScheduler.PauseJob",
    iam: { role: "roles/cloudscheduler.admin" },
    operation: scheduler.pauseProjectsLocationsJobs,
  }),
);
