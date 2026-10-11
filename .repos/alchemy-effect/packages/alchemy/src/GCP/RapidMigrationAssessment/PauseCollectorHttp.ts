import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import { PauseCollector } from "./PauseCollector.ts";

/**
 * HTTP implementation of {@link PauseCollector}.
 *
 * @layer
 * @provides GCP.RapidMigrationAssessment.PauseCollector
 */
export const PauseCollectorHttp: Layer.Layer<
  PauseCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  PauseCollector,
  makeCollectorHttpBinding<
    rma.PauseProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.PauseProjectsLocationsCollectorsError
  >({
    tag: "GCP.RapidMigrationAssessment.PauseCollector",
    iam: { role: "roles/rma.runner" },
    operation: rma.pauseProjectsLocationsCollectors,
  }),
);
