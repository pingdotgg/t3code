import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Schema } from "./Schema.ts";
import { bindGcpHost } from "../Host.ts";
import {
  ValidateMessage,
  type ValidateMessageRequest,
} from "./ValidateMessage.ts";

/**
 * HTTP implementation of {@link ValidateMessage}.
 *
 * @layer
 * @provides GCP.PubSub.ValidateMessage
 */
export const ValidateMessageHttp = Layer.effect(
  ValidateMessage,
  Effect.gen(function* () {
    const validate = yield* pubsub.validateMessageProjectsSchemas;
    return Effect.fn(function* (schema: Schema) {
      yield* bindGcpHost({
        tag: "GCP.PubSub.ValidateMessage",
        resource: schema,
        // schemas.validate is checked on the parent project, not the schema.
        iam: [{ role: "roles/pubsub.viewer" }],
      });
      const name = yield* schema.name;
      const project = yield* schema.project;
      return Effect.fn(`GCP.PubSub.ValidateMessage(${schema.LogicalId})`)(
        function* (request: ValidateMessageRequest) {
          return yield* validate({
            parent: `projects/${yield* project}`,
            body: {
              ...request,
              name: yield* name,
            },
          });
        },
      );
    });
  }),
);
