import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import { RegisterCollector } from "./RegisterCollector.ts";

/**
 * HTTP implementation of {@link RegisterCollector}.
 *
 * @layer
 * @provides GCP.RapidMigrationAssessment.RegisterCollector
 */
export const RegisterCollectorHttp: Layer.Layer<
  RegisterCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  RegisterCollector,
  makeCollectorHttpBinding<
    rma.RegisterProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.RegisterProjectsLocationsCollectorsError
  >({
    tag: "GCP.RapidMigrationAssessment.RegisterCollector",
    iam: { role: "roles/rma.runner" },
    operation: rma.registerProjectsLocationsCollectors,
  }),
);
