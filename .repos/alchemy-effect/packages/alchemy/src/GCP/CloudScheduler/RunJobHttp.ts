import * as scheduler from "@distilled.cloud/gcp/cloudscheduler_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makeJobHttpBinding } from "./BindingHttp.ts";
import { RunJob } from "./RunJob.ts";

/**
 * HTTP implementation of {@link RunJob}.
 *
 * @layer
 * @provides GCP.CloudScheduler.RunJob
 */
export const RunJobHttp: Layer.Layer<
  RunJob,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  RunJob,
  makeJobHttpBinding<
    scheduler.RunProjectsLocationsJobsRequest,
    scheduler.Job,
    scheduler.RunProjectsLocationsJobsError
  >({
    tag: "GCP.CloudScheduler.RunJob",
    // Cloud Scheduler has no resource-level IAM.
    iam: { role: "roles/cloudscheduler.jobRunner" },
    operation: scheduler.runProjectsLocationsJobs,
  }),
);
