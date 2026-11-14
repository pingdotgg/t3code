import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { GetSchema, type GetSchemaRequest } from "./GetSchema.ts";
import type { Schema } from "./Schema.ts";

/**
 * HTTP implementation of {@link GetSchema}.
 *
 * @layer
 * @provides GCP.PubSub.GetSchema
 */
export const GetSchemaHttp = Layer.effect(
  GetSchema,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getSchema = yield* GCPBindings.withCredentials(pubsub.getProjectsSchemas);
    return Effect.fn(function* (schema: Schema) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.PubSub.GetSchema(${schema})`({
          iam: [grantFor({ role: "roles/pubsub.viewer", on: "pubsub.schema" }, schema.name)],
        });
      }
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
