import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import { GetSchemaRegistry } from "./GetSchemaRegistry.ts";
import type { SchemaRegistry } from "./SchemaRegistry.ts";

/**
 * HTTP implementation of {@link GetSchemaRegistry}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetSchemaRegistry
 */
export const GetSchemaRegistryHttp: Layer.Layer<
  GetSchemaRegistry,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  GetSchemaRegistry,
  makeManagedKafkaHttpBinding<SchemaRegistry>()<
    kafka.GetProjectsLocationsSchemaRegistriesRequest,
    kafka.SchemaRegistry,
    kafka.GetProjectsLocationsSchemaRegistriesError
  >({
    tag: "GCP.ManagedKafka.GetSchemaRegistry",
    // Schema-registry permission checks do not match a resource-name IAM
    // Condition on the registry (the conditioned grant stayed denied live),
    // so the read-only viewer role is granted on the project.
    iam: { role: "roles/managedkafka.schemaRegistryViewer" },
    operation: kafka.getProjectsLocationsSchemaRegistries,
  }),
);
