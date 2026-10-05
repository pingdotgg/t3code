import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GetSchema, type GetSchemaRequest } from "./GetSchema.ts";
import type { Schema } from "./Schema.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";

/**
 * HTTP implementation of {@link GetSchema}.
 *
 * @layer
 * @provides GCP.PubSub.GetSchema
 */
export const GetSchemaHttp = Layer.effect(
  GetSchema,
  Effect.gen(function* () {
    const getSchema = yield* pubsub.getProjectsSchemas;
    return Effect.fn(function* (schema: Schema) {
      yield* bindGcpHost({
        tag: "GCP.PubSub.GetSchema",
        resource: schema,
        iam: [
          grantFor(
            { role: "roles/pubsub.viewer", on: "pubsub.schema" },
            schema.name,
          ),
        ],
      });
      const name = yield* schema.name;
      return Effect.fn(`GCP.PubSub.GetSchema(${schema.LogicalId})`)(function* (
        request?: GetSchemaRequest,
      ) {
        return yield* getSchema({
          view: "FULL",
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
