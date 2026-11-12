import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import { ResumeCollector } from "./ResumeCollector.ts";

/**
 * HTTP implementation of {@link ResumeCollector}.
 *
 * @layer
 * @provides GCP.RapidMigrationAssessment.ResumeCollector
 */
export const ResumeCollectorHttp: Layer.Layer<
  ResumeCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  ResumeCollector,
  makeCollectorHttpBinding<
    rma.ResumeProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.ResumeProjectsLocationsCollectorsError
  >({
    tag: "GCP.RapidMigrationAssessment.ResumeCollector",
    iam: { role: "roles/rma.runner" },
    operation: rma.resumeProjectsLocationsCollectors,
  }),
);
